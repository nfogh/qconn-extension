import { SInfoService } from 'qconn';

export type CallbackType = (hostname: string, memTotal: bigint, memFree: bigint) => void;

export class SysInfoUpdater
{
    private readonly timer: NodeJS.Timeout | undefined;

    private host: string;
    private port: number;

    private isUpdating = false;
    private updateIntervalMS: number = 2000;
    private updatePromise: Promise<void> | undefined = undefined;

    private readonly callback: CallbackType;
    constructor(host: string, port: number, callback: CallbackType) {
        this.host = host;
        this.port = port;
        this.callback = callback;
    }

    public setHost(host: string, port: number) {
        this.host = host;
        this.port = port;
    }

    private async update(): Promise<void> {
        while (this.isUpdating) {
            try {
                const sInfoService = await SInfoService.connect(this.host, this.port);
                try {
                    const sysInfo = await sInfoService.getSysInfo();
                    this.callback(sysInfo.hostname, sysInfo.memTotal, sysInfo.memFree);
                } finally {
                    sInfoService.disconnect();
                }
            } catch (error) {
                // Silently discard connection errors
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
