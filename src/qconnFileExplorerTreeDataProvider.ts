import * as vscode from 'vscode';
import * as fileSystemProvider from './qconnFileSystemProvider';
import path from 'path';

export interface QConnFileExplorerTreeDataEntry {
	resourceUri: vscode.Uri;
	type: vscode.FileType;
}

type EventType = QConnFileExplorerTreeDataEntry | undefined | null | void;

interface CopyToHostParams {
	sourcePath: vscode.Uri;
	destPath: vscode.Uri;
};

export class QConnFileExplorerTreeDataProvider implements vscode.TreeDataProvider<QConnFileExplorerTreeDataEntry> {
	private fileSystemProvider: fileSystemProvider.QConnFileSystemProvider;
	private prevDestDir: vscode.Uri | undefined = undefined;

	constructor() {
		this.fileSystemProvider = new fileSystemProvider.QConnFileSystemProvider();
	}

	private readonly _onDidChangeTreeData: vscode.EventEmitter<EventType> = new vscode.EventEmitter<EventType>();
	readonly onDidChangeTreeData: vscode.Event<EventType> = this._onDidChangeTreeData.event;

	refresh(): void {
		this._onDidChangeTreeData.fire();
	}

	reconnect(): void {
		// Create a new file system provider in case the target host or port has changed
		this.fileSystemProvider = new fileSystemProvider.QConnFileSystemProvider();
		this.refresh();
	}

	async delete(entry: QConnFileExplorerTreeDataEntry): Promise<void> {
		await this.fileSystemProvider.delete(entry.resourceUri);
		this.refresh();
	}

	async rename(entry: QConnFileExplorerTreeDataEntry): Promise<void> {
		const newName = await vscode.window.showInputBox({ prompt: "Type new name", ignoreFocusOut: false, value: path.basename(entry.resourceUri.path), title: "Type new name" });
		if (newName) {
			const newPath = path.join(path.dirname(entry.resourceUri.path), newName);
			const newUri = entry.resourceUri.with({ path: newPath });
			this.fileSystemProvider.rename(entry.resourceUri, newUri, { overwrite: false });
			this.refresh();
		}
	}

	async createFile(path: vscode.Uri): Promise<void> {
		this.fileSystemProvider.writeFile(path, new Uint8Array(), { create: true, overwrite: true });
		this.refresh();
	}

	async createDirectory(path: vscode.Uri): Promise<void> {
		this.fileSystemProvider.createDirectory(path);
		this.refresh();
	}

	async copyFileToHost({sourcePath, destPath}: CopyToHostParams): Promise<void>
	{
		const data = await this.fileSystemProvider.readFile(sourcePath);
		await vscode.workspace.fs.writeFile(destPath, data);
	}

	async copyDirectoryToHost({sourcePath, destPath}: CopyToHostParams): Promise<void>
	{
		await vscode.workspace.fs.createDirectory(destPath);
		const entries = await this.fileSystemProvider.readDirectory(sourcePath);
		for (const entry of entries) {
			if (entry[1] === vscode.FileType.Directory) {
				await this.copyDirectoryToHost({
					sourcePath: vscode.Uri.joinPath(sourcePath, entry[0]), 
					destPath: vscode.Uri.joinPath(destPath, entry[0])});
			} else {
				await this.copyFileToHost({
					sourcePath: vscode.Uri.joinPath(sourcePath, entry[0]),
					destPath: vscode.Uri.joinPath(destPath, entry[0])});
			}
		}
	}

	async copyToHost(entry: QConnFileExplorerTreeDataEntry): Promise<void> {
		if (!this.prevDestDir && vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
			this.prevDestDir = vscode.workspace.workspaceFolders[0].uri;
		}

		const destDir = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, defaultUri: this.prevDestDir, title: "Select directory to transfer to" });
		if (!destDir) {
			return;
		}
		this.prevDestDir = destDir[0];

		if (entry.type === vscode.FileType.File) {
			await this.copyFileToHost({
				sourcePath: entry.resourceUri,
				destPath: vscode.Uri.joinPath(destDir[0], path.basename(entry.resourceUri.path))});
		} else if (entry.type === vscode.FileType.Directory) {
			this.copyDirectoryToHost({
				sourcePath: entry.resourceUri,
				destPath: vscode.Uri.joinPath(destDir[0], path.basename(entry.resourceUri.path))});
		}
	}

	private async readDirectorySorted(uri: vscode.Uri): Promise<QConnFileExplorerTreeDataEntry[]> {
		const children = await this.fileSystemProvider.readDirectory(uri);
		children.sort((a, b) => {
			if (a[1] === b[1]) {
				return a[0].localeCompare(b[0]);
			}
			return a[1] === vscode.FileType.Directory ? -1 : 1;
		});
		return children.map(([name, type]) => ({ resourceUri: vscode.Uri.joinPath(uri, name), type }));
	}

	async getChildren(element?: QConnFileExplorerTreeDataEntry): Promise<QConnFileExplorerTreeDataEntry[]> {
		if (element) {
			return await this.readDirectorySorted(element.resourceUri);
		}

		let qConnTargetHost = vscode.workspace.getConfiguration("qConn").get<string>("target.host", "127.0.0.1");
		let qConnTargetPort = vscode.workspace.getConfiguration("qConn").get<number>("target.port", 8000);
		const uri = vscode.Uri.parse(`qconnfs://${qConnTargetHost}:${qConnTargetPort}/`);

		return await this.readDirectorySorted(uri);
	}

	getTreeItem(element: QConnFileExplorerTreeDataEntry): vscode.TreeItem {
		const treeItem = new vscode.TreeItem(element.resourceUri, element.type === vscode.FileType.Directory ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
		if (element.type === vscode.FileType.File) {
			treeItem.command = { command: 'vscode.open', title: "Open File", arguments: [element.resourceUri], };
			if (element.resourceUri.fsPath.endsWith('.core') || element.resourceUri.fsPath.endsWith('.core.gz')) {
				treeItem.contextValue = 'coredump';
			} else {
				treeItem.contextValue = 'file';
			}
		} else if (element.type === vscode.FileType.Directory) {
			treeItem.contextValue = "directory";
		}
		return treeItem;
	}
}
