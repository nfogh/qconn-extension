import * as vscode from 'vscode';
import { SInfoService } from 'qconn';
import { ProcessInfo } from 'qconn/out/sinfoservice';

export class ProcessListProvider implements vscode.TreeDataProvider<Process> {
    private processes: Process[] = [];
    private timer: NodeJS.Timeout | undefined;

    private host: string;
    private port: number;

    private isUpdating = false;
    private updateIntervalMS = 2000;
    private updatePromise: Promise<void> | undefined = undefined;

    private sInfoService: SInfoService | undefined;

    private _onDidChangeTreeData: vscode.EventEmitter<Process | undefined | null | void> = new vscode.EventEmitter<Process | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<Process | undefined | null | void> = this._onDidChangeTreeData.event;

    constructor(host: string, port: number) {
        this.host = host;
        this.port = port;
        this.update();
    }

    public reconnect() {
        this.sInfoService?.disconnect();
        this.sInfoService = undefined; // We will automatically reconnect on the next update
        this.refresh();
    }

    public refresh() {
        this._onDidChangeTreeData.fire();
    }

    public setHost(host: string, port: number) {
        if (this.host !== host || this.port !== port) {
            this.host = host;
            this.port = port;
            this.sInfoService?.disconnect();
            this.sInfoService = undefined; // We will automatically reconnect on the next update
            this.update();
        }
    }

    private async update(): Promise<void> {
        while (this.isUpdating) {
            try {
                if (this.sInfoService === undefined) {
                    this.processes = [new StatusLabel(`Connecting to qconn on ${this.host}` + (this.port === 8000 ? "" : `:${this.port}`) + `...`, -1, vscode.TreeItemCollapsibleState.None)];
                    this._onDidChangeTreeData.fire();
                    this.sInfoService = await SInfoService.connect(this.host, this.port);
                }
                const processMap = await this.sInfoService.getPids();
                let processes: Process[] = [];
                for (const [processID, processInfo] of processMap) {
                    processes.push(new Process(processInfo, processID, vscode.TreeItemCollapsibleState.None));
                }
                this.processes = processes.sort((a, b) => b.pid - a.pid);
                this._onDidChangeTreeData.fire();
            } catch (error) {
                this.processes = [new StatusLabel(`Connecting to qconn on ${this.host}` + (this.port === 8000 ? "" : `:${this.port}`) + `...`, -1, vscode.TreeItemCollapsibleState.None)];
                await this.sInfoService?.disconnect();
                this.sInfoService = undefined;
                this._onDidChangeTreeData.fire();
            }

            await new Promise(r => setTimeout(r, this.updateIntervalMS));
        }
    }

    public setUpdateIntervalMS(newUpdateIntervalMS: number) {
        this.updateIntervalMS = newUpdateIntervalMS;
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

    getTreeItem(element: Process): vscode.TreeItem {
        return element;
    }

    getChildren(element?: Process): Thenable<Process[]> {
        return Promise.resolve(this.processes);
    }
}

function formatUTime(uTime: bigint): string {
    const ms = (uTime / BigInt(1000000)) % BigInt(1000);
    const s = (uTime / BigInt(1000000000)) % BigInt(1000);
    const min = (uTime / BigInt(60 * 1000000000)) % BigInt(60);
    const hr = (uTime / BigInt(60 * 60 * 1000000000)) % BigInt(24);
    const days = uTime / BigInt(24 * 60 * 60 * 1000000000);
    let out = "";
    if (days > 0) {
        out += `${days}d `;
    }
    if (hr > 0) {
        out += `${hr}h `;
    }
    if (min > 0) {
        out += `${min}m `;
    }
    if (s > 0) {
        out += `${s}s `;
    }
    if (ms > 0) {
        out += `${ms}ms `;
    }
    return out;
}

function formatDate(timestampInNS: bigint) {
    const unixTimestampInMS = Number(timestampInNS / BigInt(1000000));
    const date = new Date(unixTimestampInMS);
    const year: number = date.getFullYear();
    const month: number = date.getMonth() + 1;
    const day: number = date.getDate();
    const hours: number = date.getHours();
    const minutes: number = date.getMinutes();
    const seconds: number = date.getSeconds();

    return `${year}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')} ${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;

}

function formatMemory(memory: number): string {
    const KB = 1024;
    const MB = 1024 * 1024
    if (memory <= MB) {
        return `${(memory / KB).toPrecision(3)} KB`;
    } else {
        return `${(memory / MB).toPrecision(3)} MB`;
    }
}

export class Process extends vscode.TreeItem {
    constructor(
        processInfo: ProcessInfo,
        public readonly pid: number,
        collapsibleState: vscode.TreeItemCollapsibleState
    ) {
        super(processInfo.path, collapsibleState);
        this.tooltip =
            `Number of threads: ${processInfo.numThreads}\n` +
            `Number of timers: ${processInfo.numTimers}\n` +
            `Data: ${formatMemory(processInfo.datasize)}\n` +
            `Code: ${formatMemory(processInfo.codesize)}\n` +
            `CPU usage: ${formatUTime(processInfo.uTime)}\n` +
            `Start time: ${formatDate(processInfo.startTime)}`
            ;
        this.description = this.pid.toString();
        this.contextValue = "ProcessID";
    }
}

export class StatusLabel extends vscode.TreeItem {
    constructor(
        label: string,
        public readonly pid: number,
        collapsibleState: vscode.TreeItemCollapsibleState
    ) {
        super(label, collapsibleState);
    }
}
