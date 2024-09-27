import * as vscode from 'vscode';
import { CntlService, SignalType, getPids, FileService, OpenFlags, Permissions } from 'qconn';
import * as processListProvider from './processListProvider';
import { QConnFileSystemProvider } from './qconnFileSystemProvider';
import { createQConnTerminal, createTerminalProfile } from './qconnTerminal';
import { SysInfoUpdater} from './sysInfoUpdater';
import * as nodepath from 'path';
import { QConnFileExplorerTreeDataProvider } from './qconnFileExplorerTreeDataProvider';

const outputChannel = vscode.window.createOutputChannel('QConn Extension');

let qConnTargetHost = vscode.workspace.getConfiguration("qConn").get<string>("target.host", "127.0.0.1");
let qConnTargetPort = vscode.workspace.getConfiguration("qConn").get<number>("target.port", 8000);

let processExplorerTreeView: vscode.TreeView<processListProvider.Process>;
let processExplorerTreeDataProvider = new processListProvider.ProcessListProvider(qConnTargetHost, qConnTargetPort);

let fileExplorerTreeView;
let fileExplorerTreeDataProvider = new QConnFileExplorerTreeDataProvider();

let statusBarItem: vscode.StatusBarItem;

let sysInfoUpdater: SysInfoUpdater;

let prevPing: number = Date.now();
let pingUpdater: NodeJS.Timeout;

// Log function to write messages to the output channel
function log(message: string) {
	outputChannel.appendLine(message);
}

async function pickTargetPID(host: string, port: number): Promise<number | undefined> {
	try {
		const processes = await getPids(host, port);
		let pids: vscode.QuickPickItem[] = [];
		for (const [pid, info] of processes) {
			pids.push({ label: pid.toString(), description: info.path });
		}
		pids = pids.sort((a, b) => parseInt(b.label) - parseInt(a.label));

		const item = await vscode.window.showQuickPick(pids, { canPickMany: false, title: "Select PID", ignoreFocusOut: true, matchOnDescription: true });
		if (item) {
			return parseInt(item.label);
		}
		else {
			return undefined;
		}
	} catch {
		const typedPID = await vscode.window.showInputBox({ title: "Could not get PID list over qconn. Please enter the PID manually.", ignoreFocusOut: true });
		if (typedPID === undefined) {
			return undefined;
		}
		return parseInt(typedPID);
	}
}

async function kill(process: processListProvider.Process | undefined) {
	const pid = process ? process.pid : await pickTargetPID(qConnTargetHost, qConnTargetPort);
	if (pid !== undefined) {
		try {
			log(`Sending SIGKILL to pid ${pid}`);
			const service = await CntlService.connect(qConnTargetHost, qConnTargetPort);
			await service.signalProcess(pid, SignalType.kill);
			await service.disconnect();
		} catch (error) {
			vscode.window.showErrorMessage(`Failed to kill process ${pid}: ${error}`);
		}
	}
}

async function connectFs(): Promise<void> {
	vscode.workspace.updateWorkspaceFolders(0, 0, {
		uri: vscode.Uri.parse(`qconnfs://${qConnTargetHost}:${qConnTargetPort}`),
		name: `QNX@${qConnTargetHost}:${qConnTargetPort}`
	});
}

function configurationUpdated()
{
	let dirty = false;
	const configPort = vscode.workspace.getConfiguration("qConn").get<number>("target.port", 8000);
	const configHost = vscode.workspace.getConfiguration("qConn").get<string>("target.host", "127.0.0.1");

	if ((configPort !== qConnTargetPort) || (configHost !== qConnTargetHost)) {
		qConnTargetPort = configPort;
		qConnTargetHost = configHost;
		statusBarItem.text = `QConn@${qConnTargetHost}` + (qConnTargetPort === 8000 ? "" : `:${qConnTargetPort}`);
		processExplorerTreeDataProvider.setHost(qConnTargetHost, qConnTargetPort);
	}
}

async function selectQConnTarget() {
	try {
		const input = await vscode.window.showInputBox({ prompt: "Enter QConn target host", value: `${qConnTargetHost}:${qConnTargetPort}`, ignoreFocusOut: true });
		if (input) {
			const tokens = input.split(":");
			const newHost = tokens[0];
			if (tokens.length === 2) {
				const newPort = parseInt(tokens[1]);
				await vscode.workspace.getConfiguration("qConn").update("target.port", newPort, true);
			}
			await vscode.workspace.getConfiguration("qConn").update("target.host", newHost, true);
		}
	} catch (error) {
		vscode.window.showErrorMessage(`Failed to set QConn target: ${error}`);
	}
}

function transferFile(localFilePath: vscode.Uri, remoteFilePath: string): Thenable<void> {
	return vscode.window.withProgress({
		location: vscode.ProgressLocation.Notification,
		title: "Transferring",
		cancellable: true
	}, async (progress, token) => {
		if (token.isCancellationRequested) {
			return;
		}
		progress.report({ increment: 0, message: `Reading ${localFilePath.fsPath}...` });
		const data = Buffer.from(await vscode.workspace.fs.readFile(localFilePath));
		
		if (token.isCancellationRequested) {
			return;
		}
		progress.report({ increment: 0, message: `Connecting to ${qConnTargetHost}:${qConnTargetPort}...` });

		const fileService = await FileService.connect(qConnTargetHost, qConnTargetPort);

		const destFileString = `${qConnTargetHost}${qConnTargetPort === 8000 ? '' : ':' + qConnTargetPort.toString()}/${remoteFilePath}`;

		if (token.isCancellationRequested) {
			return;
		}
		progress.report({ increment: 0, message: `Opening  ${destFileString}...` });
		const fd = await fileService.open(remoteFilePath, OpenFlags.O_CREAT | OpenFlags.O_WRONLY, Permissions.S_IRUSR | Permissions.S_IWUSR | Permissions.S_IRGRP | Permissions.S_IROTH);
		try {
			let numTransferred = 0;
			while (numTransferred !== data.length) {
				const toTransfer = Math.min(1024*1024, data.length - numTransferred);
				const subBuffer = data.subarray(numTransferred, numTransferred + toTransfer);
				await fileService.write(fd, subBuffer, numTransferred);
				numTransferred = numTransferred + toTransfer;

				if (token.isCancellationRequested) {
					return;
				}
				progress.report({ increment: toTransfer/data.length*100, message: `${localFilePath.fsPath} to ${destFileString} (${(numTransferred/1024/1024).toFixed(1)} of ${(data.length/1024/1024).toFixed(1)} MB)...` });
			}
		} finally {
			progress.report({ increment: 0, message: `Closing ${destFileString}...`});
			await fileService.close(fd);
		}
		progress.report({ increment: 0, message: `Copied ${localFilePath.fsPath} to ${destFileString}` });
	});
}

let previousDestFileDir: string = "/";

async function copyFileToTarget(filePath: vscode.Uri | undefined): Promise<void> {
	try {
		if (!filePath) {
			const selectedFilePath = await vscode.window.showOpenDialog({canSelectFiles: true, canSelectFolders: false, canSelectMany: false});
			if (!selectedFilePath) {
				return;
			}
			filePath = selectedFilePath[0];
		}

		const destFileDir = await vscode.window.showInputBox({title: "Type in destination directory", value: previousDestFileDir, ignoreFocusOut: true});

		if (!destFileDir) {
			return;
		}

		previousDestFileDir = destFileDir;
		const destFilePath = `${destFileDir === '/' ? '' : destFileDir}/${nodepath.basename(filePath.fsPath)}`;

		await transferFile(filePath, destFilePath);
		fileExplorerTreeDataProvider.refresh();
	} catch (error: unknown) {
		vscode.window.showErrorMessage(`Unable to copy ${filePath} to ${qConnTargetHost}:${qConnTargetPort}: ${error}`);
	}
}


export function activate(context: vscode.ExtensionContext) {
	console.log('Activating QConn extension');

	context.subscriptions.push(vscode.workspace.registerFileSystemProvider('qconnfs', new QConnFileSystemProvider(), { isCaseSensitive: true }));

	context.subscriptions.push(vscode.commands.registerCommand('qconn.kill', kill));
	context.subscriptions.push(vscode.commands.registerCommand('qconn.connectFs', connectFs));
	context.subscriptions.push(vscode.commands.registerCommand('qconn.createQConnTerminal', () => { createQConnTerminal(qConnTargetHost, qConnTargetPort); }));
	context.subscriptions.push(vscode.commands.registerCommand('qconn.selectQConnTarget', () => { selectQConnTarget(); }));
	context.subscriptions.push(vscode.commands.registerCommand('qconn.copyFileToTarget', copyFileToTarget));
	context.subscriptions.push(createTerminalProfile());
	processExplorerTreeView = vscode.window.createTreeView('qConnProcessView', { treeDataProvider: processExplorerTreeDataProvider });

	fileExplorerTreeView = vscode.window.createTreeView('qConnFileExplorer', { treeDataProvider: fileExplorerTreeDataProvider });
	vscode.commands.registerCommand('qconnFileExplorer.refreshEntry', () => fileExplorerTreeDataProvider.refresh() );
	vscode.commands.registerCommand('qconnProcessView.deleteFile', (entry) => fileExplorerTreeDataProvider.delete(entry) );
	vscode.commands.registerCommand('qconnProcessView.createFile', (directory) => { fileExplorerTreeDataProvider.createFileIn(directory); });
	vscode.commands.registerCommand('qconnProcessView.copyFile', (entry) => { fileExplorerTreeDataProvider.copyFileToHost(entry); });
	
	statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
	statusBarItem.text = `QConn@${qConnTargetHost}` + (qConnTargetPort === 8000 ? "" : `:${qConnTargetPort}`);
	statusBarItem.tooltip = "Click to select QConn target";
	statusBarItem.command = "qconn.selectQConnTarget";
	statusBarItem.show();
	context.subscriptions.push(statusBarItem);

	processExplorerTreeView.onDidChangeVisibility(event => {
		if (event.visible) {
			processExplorerTreeDataProvider.startUpdating();
		} else {
			processExplorerTreeDataProvider.stopUpdating();
		}
	});

	vscode.workspace.onDidChangeConfiguration(() => { configurationUpdated(); });

	sysInfoUpdater = new SysInfoUpdater(qConnTargetHost, qConnTargetPort, (hostname, memTotal, memFree) => {
		prevPing = Date.now();
		const MB = BigInt(1024*1024);

		statusBarItem.tooltip = "Click to select QConn target\n" +
		`Hostname: ${hostname}\n` +
		`Memory Free ${Number(memFree/MB)}MB / Available ${Number(memTotal/MB)}MB`;
	});
	sysInfoUpdater.startUpdating(5000);

	pingUpdater = setInterval(() => {
		statusBarItem.text = `QConn@${qConnTargetHost}` + (qConnTargetPort === 8000 ? "" : `:${qConnTargetPort}`);

		if (Date.now() - prevPing > 5000) {
			statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
			statusBarItem.tooltip =
				"No response from host for 10s.\n" +
				"Is qconn running?\n" +
				"Click to select QConn target";
		} else {
			statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.background');
			// tooltip will be updated by SysInfoUpdater
		}
	}, 10000);
}

export function deactivate() {
	sysInfoUpdater.stopUpdating();
	outputChannel.dispose();
	clearInterval(pingUpdater);
}

