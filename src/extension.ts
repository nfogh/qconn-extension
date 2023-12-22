import * as vscode from 'vscode';
import * as qconn from 'qconn';
import * as cntlservice from 'qconn/out/cntlservice';
import * as processListProvider from './processListProvider';
import { QConnFileSystemProvider } from './qconnFileSystemProvider';
import { createQConnTerminal } from './qconnTerminal';

const outputChannel = vscode.window.createOutputChannel('QConn Extension');

const qnxTargetHost = vscode.workspace.getConfiguration("Qconn").get<string>("target.host", "192.168.203.128");
const qnxTargetPort = vscode.workspace.getConfiguration("Qconn").get<number>("target.port", 8000);

let treeView: vscode.TreeView<processListProvider.Process>;
let treeDataProvider = new processListProvider.ProcessListProvider(qnxTargetHost, qnxTargetPort);

// Log function to write messages to the output channel
function log(message: string) {
	outputChannel.appendLine(message);
}

async function pickTargetPID(host: string, port: number): Promise<number | undefined> {
	try {
		const processes = await qconn.getPids(host, port);
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
	const pid = process ? process.pid : await pickTargetPID(qnxTargetHost, qnxTargetPort);
	if (pid !== undefined) {
		log(`Sending SIGKILL to pid ${pid}`);
		const service = await cntlservice.CntlService.connect(qnxTargetHost, qnxTargetPort);
		await service.signalProcess(pid, cntlservice.SignalType.kill);
		await service.disconnect();
	}
}

async function connectFs(): Promise<void> {
	vscode.workspace.updateWorkspaceFolders(0, 0, {
		uri: vscode.Uri.parse(`qnxfs://${qnxTargetHost}:${qnxTargetPort}`),
		name: `QNX@${qnxTargetHost}:${qnxTargetPort}`
	});
}

export function activate(context: vscode.ExtensionContext) {
	console.log('Activating QConn extension');

	context.subscriptions.push(vscode.workspace.registerFileSystemProvider('qnxfs', new QConnFileSystemProvider(), { isCaseSensitive: true }));

	context.subscriptions.push(vscode.commands.registerCommand('qconn.kill', kill));
	context.subscriptions.push(vscode.commands.registerCommand('qconn.connectFs', connectFs));
	context.subscriptions.push(vscode.commands.registerCommand('qconn.createQNXTerminal', () => { createQConnTerminal(qnxTargetHost, qnxTargetPort); }));

	treeView = vscode.window.createTreeView('qConnProcessView', { treeDataProvider: treeDataProvider });

	treeView.onDidChangeVisibility(event => {
		if (event.visible) {
			treeDataProvider.startUpdating();
		} else {
			treeDataProvider.stopUpdating();
		}
	});
}

// This method is called when your extension is deactivated
export function deactivate() {
	outputChannel.dispose();
}

