import * as vscode from 'vscode';
import * as fileSystemProvider from './qconnFileSystemProvider';
import path from 'path';

export interface QConnFileExplorerTreeDataEntry {
	uri: vscode.Uri;
	type: vscode.FileType;
}

type EventType = QConnFileExplorerTreeDataEntry | undefined | null | void;

export class QConnFileExplorerTreeDataProvider implements vscode.TreeDataProvider<QConnFileExplorerTreeDataEntry> {
	private fileSystemProvider: fileSystemProvider.QConnFileSystemProvider;
	private prevDestDir: vscode.Uri | undefined = undefined;

	constructor() {
		this.fileSystemProvider = new fileSystemProvider.QConnFileSystemProvider();
	}

	private _onDidChangeTreeData: vscode.EventEmitter<EventType> = new vscode.EventEmitter<EventType>();
	readonly onDidChangeTreeData: vscode.Event<EventType> = this._onDidChangeTreeData.event;

	refresh(): void {
		this._onDidChangeTreeData.fire();
	}

	async delete(entry: QConnFileExplorerTreeDataEntry): Promise<void> {
		if (entry.type === vscode.FileType.File) {
			await this.fileSystemProvider.delete(entry.uri);
			this.refresh();
		}
	}

	async rename(entry: QConnFileExplorerTreeDataEntry): Promise<void> {
		if (entry.type === vscode.FileType.File) {
			const fileName = await vscode.window.showInputBox({ prompt: "Type name of file", ignoreFocusOut: false, placeHolder: path.basename(entry.uri.path), title: "Type name of file" });
			if (fileName) {
				const newPath = path.join(path.dirname(entry.uri.path), fileName);
				const newUri = entry.uri.with({ path: newPath });
				this.fileSystemProvider.rename(entry.uri, newUri, { overwrite: false });
				this.refresh();
			}
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

	async copyFileToHost(entry: QConnFileExplorerTreeDataEntry): Promise<void> {
		if (entry.type === vscode.FileType.File) {
			if (!this.prevDestDir && vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
				this.prevDestDir = vscode.workspace.workspaceFolders[0].uri;
			}

			const destDir = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, defaultUri: this.prevDestDir, title: "Select directory to transfer to" });
			if (destDir) {
				const data = await this.fileSystemProvider.readFile(entry.uri);
				await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(destDir[0], path.basename(entry.uri.path)), data);
				this.prevDestDir = destDir[0];
			}
		}
	}

	async getChildren(element?: QConnFileExplorerTreeDataEntry): Promise<QConnFileExplorerTreeDataEntry[]> {
		if (element) {
			const children = await this.fileSystemProvider.readDirectory(element.uri);
			return children.map(([name, type]) => ({ uri: vscode.Uri.joinPath(element.uri, name), type }));
		}

		let qConnTargetHost = vscode.workspace.getConfiguration("qConn").get<string>("target.host", "127.0.0.1");
		let qConnTargetPort = vscode.workspace.getConfiguration("qConn").get<number>("target.port", 8000);
		const uri = vscode.Uri.parse(`qconnfs://${qConnTargetHost}:${qConnTargetPort}/`);

		const children = await this.fileSystemProvider.readDirectory(uri);
		children.sort((a, b) => {
			if (a[1] === b[1]) {
				return a[0].localeCompare(b[0]);
			}
			return a[1] === vscode.FileType.Directory ? -1 : 1;
		});
		return children.map(([name, type]) => ({ uri: vscode.Uri.joinPath(uri, name), type }));
	}

	getTreeItem(element: QConnFileExplorerTreeDataEntry): vscode.TreeItem {
		const treeItem = new vscode.TreeItem(element.uri, element.type === vscode.FileType.Directory ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
		if (element.type === vscode.FileType.File) {
			treeItem.command = { command: 'vscode.open', title: "Open File", arguments: [element.uri], };
			treeItem.contextValue = 'file';
		} else if (element.type === vscode.FileType.Directory) {
			treeItem.contextValue = "directory";
		}
		return treeItem;
	}
}
