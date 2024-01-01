import * as vscode from 'vscode';
import { SInfoService } from 'qconn';

export class ProcessListProvider implements vscode.TreeDataProvider<Process>
{
    private processes: Process[] = [];
    private timer: NodeJS.Timeout | undefined;

    private host: string;
    private port: number;

    private isUpdating = false;
    private sInfoService: SInfoService | undefined;

    private _onDidChangeTreeData: vscode.EventEmitter<Process | undefined | null | void> = new vscode.EventEmitter<Process | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<Process | undefined | null | void> = this._onDidChangeTreeData.event;

    constructor(host: string, port: number) {
        this.host = host;
        this.port = port;
    }

    private startUpdateTimer(intervalMS: number = 2000) {
        return setInterval(async () => {
            if (this.isUpdating) {
                return;
            }
            try {
                this.isUpdating = true;
                if (this.sInfoService === undefined) {
                    this.processes = [new StatusLabel(`Connecting to qconn on ${this.host}...`, -1, vscode.TreeItemCollapsibleState.None)];
                    this._onDidChangeTreeData.fire();
                    this.sInfoService = await SInfoService.connect(this.host, this.port);
                }
                const processMap = await this.sInfoService.getPids();
                let processes: Process[] = [];
                for (const [processID, processInfo] of processMap) {
                    processes.push(new Process(processInfo.path, processID, vscode.TreeItemCollapsibleState.None));
                }
                this.processes = processes.sort((a, b) => b.pid - a.pid);
                this._onDidChangeTreeData.fire();
            } catch (error) {
                this.processes = [new StatusLabel(`Connecting to qconn on ${this.host}...`, -1, vscode.TreeItemCollapsibleState.None)];
                await this.sInfoService?.disconnect();
                this.sInfoService = undefined;
                this._onDidChangeTreeData.fire();
            } finally {
                this.isUpdating = false;
            }
        }, intervalMS);
    }

    stopUpdating() {
        if (this.timer !== undefined) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
        if (this.sInfoService !== undefined) {
            this.sInfoService.disconnect();
            this.sInfoService = undefined;
        }
    }

    startUpdating(intervalMS: number = 2000) {
        this.timer = this.startUpdateTimer(intervalMS);
    }

    getTreeItem(element: Process): vscode.TreeItem {
        return element;
    }

    getChildren(): Thenable<Process[]> {
        return Promise.resolve(this.processes);
    }
}

export class Process extends vscode.TreeItem {
    constructor(
        label: string,
        public readonly pid: number,
        collapsibleState: vscode.TreeItemCollapsibleState
    ) {
        super(label, collapsibleState);
        this.tooltip = `Process id: ${this.pid}`;
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
