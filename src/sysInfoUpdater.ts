import { SInfoService } from 'qconn';

export interface CallbackType {(hostname: string, memTotal: bigint, memFree: bigint): void};

export class SysInfoUpdater
{
    private timer: NodeJS.Timeout | undefined;

    private host: string;
    private port: number;

    private sInfoService: SInfoService | undefined;

    private isUpdating = false;
    private updateIntervalMS: number = 2000;
    private updatePromise: Promise<void> | undefined = undefined;

    private callback: CallbackType;
    constructor(host: string, port: number, callback: CallbackType) {
        this.host = host;
        this.port = port;
        this.callback = callback;
    }

    public setHost(host: string, port: number) {
        if (this.host !== host || this.port !== port) {
            this.host = host;
            this.port = port;
            this.sInfoService?.disconnect();
            this.sInfoService = undefined; // We will automatically reconnect on the next update
        }
    }

    private async update(): Promise<void> {
        while (this.isUpdating) {
            try {
                if (this.sInfoService === undefined) {
                    this.sInfoService = await SInfoService.connect(this.host, this.port);
                }
                const sysInfo = await this.sInfoService.getSysInfo();
                this.callback(sysInfo.hostname, sysInfo.memTotal, sysInfo.memFree);
            } catch (error) {
            }
            await new Promise(r => setTimeout(r, this.updateIntervalMS));
        }
    }

    async stopUpdating() {
        if (this.updatePromise) {
            this.isUpdating = false;
            await this.updatePromise;
            this.updatePromise = undefined;
        }
    }

    startUpdating(updateIntervalMS: number = 5000) {
        if (!this.updatePromise) {
            this.isUpdating = true;
            this.updateIntervalMS = updateIntervalMS;
            this.updatePromise = this.update();
        }
    }
}
