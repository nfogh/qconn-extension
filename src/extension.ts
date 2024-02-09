import * as vscode from 'vscode';
import { CntlService, SignalType, getPids, FileService, OpenFlags, Permissions } from 'qconn';
import * as processListProvider from './processListProvider';
import { QConnFileSystemProvider } from './qconnFileSystemProvider';
import { createQConnTerminal, createTerminalProfile } from './qconnTerminal';
import { SysInfoUpdater} from './sysInfoUpdater';
import * as nodepath from 'path';

const outputChannel = vscode.window.createOutputChannel('QConn Extension');

let qConnTargetHost = vscode.workspace.getConfiguration("qConn").get<string>("target.host", "127.0.0.1");
let qConnTargetPort = vscode.workspace.getConfiguration("qConn").get<number>("target.port", 8000);

let treeView: vscode.TreeView<processListProvider.Process>;
let treeDataProvider = new processListProvider.ProcessListProvider(qConnTargetHost, qConnTargetPort);

let statusBarItem: vscode.StatusBarItem;

let sysInfoUpdater: SysInfoUpdater;

// Log function to write messages to the output channel
function log(message: string) {
	outputChannel.appendLine(message);
}

async function pickTargetPID(host: string, port: number): Promise<number | undefined> {
	try {
		const processes = await getPids(host, port);
		var pids: vscode.QuickPickItem[] = [];
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
		uri: vscode.Uri.parse(`qconn://${qConnTargetHost}:${qConnTargetPort}`),
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
		treeDataProvider.setHost(qConnTargetHost, qConnTargetPort);
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

var previousDestFileDir: string = "/";

async function copyFileToTarget(filePath: vscode.Uri | undefined): Promise<void> {
	try {
		if (!filePath) {
			const selectedFilePath = await vscode.window.showOpenDialog({canSelectFiles: true, canSelectFolders: false, canSelectMany: false});
			if (!selectedFilePath) {
				return;
			}
			filePath = selectedFilePath[0];
		}

		const data = await vscode.workspace.fs.readFile(filePath);
		const destFileDir = await vscode.window.showInputBox({title: "Type in destination directory", value: previousDestFileDir, ignoreFocusOut: true});
		if (!destFileDir) {
			return;
		}
		
		previousDestFileDir = destFileDir;
		const destFilePath = `${destFileDir}/${nodepath.basename(filePath.fsPath)}`;
		const fileService = await FileService.connect(qConnTargetHost, qConnTargetPort);
		const fd = await fileService.open(destFilePath, OpenFlags.O_CREAT | OpenFlags.O_WRONLY, Permissions.S_IRUSR | Permissions.S_IWUSR | Permissions.S_IRGRP | Permissions.S_IROTH);
		try {
			await fileService.write(fd, Buffer.from(data));
		} finally {
			await fileService.close(fd);
		}

		vscode.window.showInformationMessage(`Copied ${filePath.fsPath} to ${qConnTargetHost}:${qConnTargetPort}${destFilePath}`);
	} catch (error: unknown) {
		vscode.window.showErrorMessage(`Unable to copy ${filePath} to ${qConnTargetHost}:${qConnTargetPort}: ${error}`);
	}
}


export function activate(context: vscode.ExtensionContext) {
	console.log('Activating QConn extension');

	context.subscriptions.push(vscode.workspace.registerFileSystemProvider('qconn', new QConnFileSystemProvider(), { isCaseSensitive: true }));

	context.subscriptions.push(vscode.commands.registerCommand('qconn.kill', kill));
	context.subscriptions.push(vscode.commands.registerCommand('qconn.connectFs', connectFs));
	context.subscriptions.push(vscode.commands.registerCommand('qconn.createQConnTerminal', () => { createQConnTerminal(qConnTargetHost, qConnTargetPort); }));
	context.subscriptions.push(vscode.commands.registerCommand('qconn.selectQConnTarget', () => { selectQConnTarget(); }));
	context.subscriptions.push(vscode.commands.registerCommand('qconn.copyFileToTarget', copyFileToTarget));
	context.subscriptions.push(createTerminalProfile());
	treeView = vscode.window.createTreeView('qConnProcessView', { treeDataProvider: treeDataProvider });

	statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
	statusBarItem.text = `QConn@${qConnTargetHost}` + (qConnTargetPort === 8000 ? "" : `:${qConnTargetPort}`);
	statusBarItem.tooltip = "Click to select QConn target";
	statusBarItem.command = "qconn.selectQConnTarget";
	statusBarItem.show();
	context.subscriptions.push(statusBarItem);

	treeView.onDidChangeVisibility(event => {
		if (event.visible) {
			treeDataProvider.startUpdating();
		} else {
			treeDataProvider.stopUpdating();
		}
	});

	vscode.workspace.onDidChangeConfiguration(() => { configurationUpdated(); });

	sysInfoUpdater = new SysInfoUpdater(qConnTargetHost, qConnTargetPort, (hostname, memTotal, memFree) => {
		statusBarItem.text = `QConn@${qConnTargetHost}`;
		if (qConnTargetPort !== 8000) {
			statusBarItem.text += qConnTargetPort;
		}
		const MB = BigInt(1024*1024);
		statusBarItem.text += `  ${Number(memFree/MB)} MB / ${Number(memTotal/MB)}MB`;
	});
	sysInfoUpdater.startUpdating();
}

export function deactivate() {
	sysInfoUpdater.stopUpdating();
	outputChannel.dispose();
}

