import * as vscode from 'vscode';
import { CntlService, SignalType, getPids, FileService, OpenFlags, Permissions } from 'qconn';
import * as processListProvider from './processListProvider';
import { QConnFileSystemProvider } from './qconnFileSystemProvider';
import { createQConnTerminal, createTerminalProfile } from './qconnTerminal';
import * as nodepath from 'path';
import { QConnFileExplorerTreeDataProvider, QConnFileExplorerTreeDataEntry } from './qconnFileExplorerTreeDataProvider';
import * as statusBar from './statusBarItem';
import * as debugProvider from './debugProvider';
import * as qconnUtils from './qconnUtils';
import * as os from 'os';
import * as fspromises from 'fs/promises';
import * as fs from 'fs';
import * as zlib from 'zlib';
import * as nodestream from 'node:stream/promises';
import * as outputChannel from './outputChannel';
import * as debugTools from './debug';
import { startFindSDPPaths } from './sdpPaths';

let qConnTargetHost = vscode.workspace.getConfiguration("qConn").get<string>("target.host", "127.0.0.1");
let qConnTargetPort = vscode.workspace.getConfiguration("qConn").get<number>("target.port", 8000);

let processExplorerTreeView: vscode.TreeView<processListProvider.Process>;
let processExplorerTreeDataProvider: processListProvider.ProcessListProvider;

let fileExplorerTreeView: vscode.TreeView<QConnFileExplorerTreeDataEntry>;
let fileExplorerTreeDataProvider = new QConnFileExplorerTreeDataProvider();

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

async function sendsignal(pid: number, signal: SignalType): Promise<void>
{
	try {
		outputChannel.log(`Sending signal ${signal} to pid ${pid}`);
		const service = await CntlService.connect(qConnTargetHost, qConnTargetPort);
		await service.signalProcess(pid, signal);
		await service.disconnect();
		// Do a quick update of the process explorer
		setTimeout(() => { processExplorerTreeDataProvider.refresh(); }, 500);
	} catch (error) {
		vscode.window.showErrorMessage(`Failed to send signal ${signal} process ${pid}: ${error}`);
	}
}

async function kill(process: processListProvider.Process | undefined): Promise<void> {
	const pid = process ? process.pid : await pickTargetPID(qConnTargetHost, qConnTargetPort);
	if (pid !== undefined) {
		sendsignal(pid, SignalType.kill);
	}
}

async function sigint(process: processListProvider.Process | undefined): Promise<void> {
	const pid = process ? process.pid : await pickTargetPID(qConnTargetHost, qConnTargetPort);
	if (pid !== undefined) {
		sendsignal(pid, SignalType.int);
	}
}

async function connectFs(): Promise<void> {
	vscode.workspace.updateWorkspaceFolders(0, 0, {
		uri: vscode.Uri.parse(`qconnfs://${qConnTargetHost}:${qConnTargetPort}`),
		name: `QNX@${qConnTargetHost}:${qConnTargetPort}`
	});
}

function configurationUpdated(event: vscode.ConfigurationChangeEvent) {

	if (event.affectsConfiguration("qConn.target.port") || event.affectsConfiguration("qConn.target.host")) {
		qConnTargetPort = vscode.workspace.getConfiguration("qConn").get<number>("target.port", 8000);
		qConnTargetHost = vscode.workspace.getConfiguration("qConn").get<string>("target.host", "127.0.0.1");
		statusBar.defaultText();
		processExplorerTreeDataProvider.setHost(qConnTargetHost, qConnTargetPort);
		fileExplorerTreeDataProvider.reconnect();
	}

	if (event.affectsConfiguration("qConn.sdpSearchPaths")) {
		const sdpSearchPaths = vscode.workspace.getConfiguration('qConn').get<string[]>('sdpSearchPaths');
		if (sdpSearchPaths) {
			startFindSDPPaths(sdpSearchPaths);
		}
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
				const toTransfer = Math.min(1024 * 1024, data.length - numTransferred);
				const subBuffer = data.subarray(numTransferred, numTransferred + toTransfer);
				await fileService.write(fd, subBuffer, numTransferred);
				numTransferred = numTransferred + toTransfer;

				if (token.isCancellationRequested) {
					return;
				}
				progress.report({ increment: toTransfer / data.length * 100, message: `${localFilePath.fsPath} to ${destFileString} (${(numTransferred / 1024 / 1024).toFixed(1)} of ${(data.length / 1024 / 1024).toFixed(1)} MB)...` });
			}
		} finally {
			progress.report({ increment: 0, message: `Closing ${destFileString}...` });
			await fileService.close(fd);
		}
		progress.report({ increment: 0, message: `Copied ${localFilePath.fsPath} to ${destFileString}` });
	});
}

let previousDestFileDir: string = "/";

async function copyFileToTarget(filePath: vscode.Uri | undefined): Promise<void> {
	try {
		if (!filePath) {
			const selectedFilePath = await vscode.window.showOpenDialog({ canSelectFiles: true, canSelectFolders: false, canSelectMany: false });
			if (!selectedFilePath) {
				return;
			}
			filePath = selectedFilePath[0];
		}

		const destFileDir = await vscode.window.showInputBox({ title: "Type in destination directory", value: previousDestFileDir, ignoreFocusOut: true });

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

async function createFileOrDirectory(type: vscode.FileType.Directory | vscode.FileType.File, entry: QConnFileExplorerTreeDataEntry | undefined) {
	let directory = vscode.Uri.parse(`qconnfs://${qConnTargetHost}:${qConnTargetPort}/`);
	if (entry) {
		directory = entry.type === vscode.FileType.Directory ?
			entry.resourceUri :
			entry.resourceUri.with({ path: nodepath.dirname(entry.resourceUri.path) });
	} else if (fileExplorerTreeView.selection.length === 1) {
		directory = fileExplorerTreeView.selection[0].type === vscode.FileType.Directory ?
			fileExplorerTreeView.selection[0].resourceUri :
			fileExplorerTreeView.selection[0].resourceUri.with({ path: nodepath.dirname(fileExplorerTreeView.selection[0].resourceUri.path) });
	}

	const name = await vscode.window.showInputBox({ prompt: "Type name", ignoreFocusOut: true, title: "Type name" });
	if (name) {
		const path = vscode.Uri.joinPath(directory, name);
		if (type === vscode.FileType.File) {
			fileExplorerTreeDataProvider.createFile(path);
		} else {
			fileExplorerTreeDataProvider.createDirectory(path);
		}
	}
}

async function transferCoreFile(sourcePath: string): Promise<string | undefined>
{
	return await vscode.window.withProgress({
		location: vscode.ProgressLocation.Notification,
		title: `Transferring ${sourcePath}`,
		cancellable: true
	}, async (progress, token) => {
		let prevPercent: number = 0;
		const data = await qconnUtils.readFile(sourcePath, qConnTargetHost, qConnTargetPort, (percent) => {
			progress.report({ increment: percent - prevPercent });
			prevPercent = percent;
		});
		const destPath = nodepath.join(os.tmpdir(), nodepath.basename(sourcePath));
		await fspromises.writeFile(destPath, data);
		if (nodepath.parse(destPath).ext === ".gz") {
			const unzippedPath = nodepath.join(os.tmpdir(), nodepath.parse(nodepath.basename(sourcePath)).name);
			try {
				progress.report({message: "Unpacking core file..."});
				await nodestream.pipeline(
					fs.createReadStream(destPath),
					zlib.createGunzip(),
					fs.createWriteStream(unzippedPath));
			} catch (error) {
				vscode.window.showErrorMessage(`Unable to unzip ${destPath}. ${error}`);
			}
			return unzippedPath;
		}
		return destPath;
	});
}

async function pickCoreFileOnTarget(): Promise<string | undefined> {
	const coreDumpPath = vscode.workspace.getConfiguration('qConn').get<string>('coreDumpPath', '/var/dumps');
	const coreDumps = await qconnUtils.listDir(coreDumpPath, qConnTargetHost, qConnTargetPort);
	const coreDumpFileNames = coreDumps.map(info => info.name).filter(name => name.includes("core"));

	const selectedCoreDump = await vscode.window.showQuickPick(coreDumpFileNames, { canPickMany: false, title: "Select core dump", ignoreFocusOut: true });
	if (selectedCoreDump) {
		return await transferCoreFile(coreDumpPath + "/" + selectedCoreDump);
	} else {
		return undefined;
	}
}

export async function pickCoreFileOnLocal(): Promise<string | undefined> {
	const corePath = await vscode.window.showOpenDialog({
		canSelectMany: false,
		canSelectFolders: false,
		canSelectFiles: true,
		title: "Select core dump",
		filters: { 'Core dumps': ["core"] }
	});
	if (corePath?.length === 1) {
		return corePath[0].fsPath;
	}
	return undefined;
}

export async function debug(treeDataEntry: QConnFileExplorerTreeDataEntry | undefined): Promise<void>
{
	let executablePath = treeDataEntry ? treeDataEntry.resourceUri.path : undefined;
	if (!executablePath) {
		return;
	}

	debugTools.debug(executablePath, qConnTargetHost, qConnTargetPort);
}

export async function debug_corefile(treeDataEntry: QConnFileExplorerTreeDataEntry | undefined): Promise<void>
{
	if (!treeDataEntry) {
		return;
	}

	let coreFilePath = treeDataEntry.resourceUri.path;

	if (treeDataEntry.resourceUri.scheme === "qconnfs") {
		const downloadedPath = await transferCoreFile(coreFilePath);
		if (!downloadedPath) {
			return;
		}
		coreFilePath = downloadedPath;
	}

	const configuration: debugProvider.CoreDebugConfiguration = {
		type: "qconn-core",
		name:"core dump",
		request: "launch",
		coreDumpPath: coreFilePath
	};

	const provider = new debugProvider.CoreDebugConfigurationProvider();
	if (provider.resolveDebugConfigurationWithSubstitutedVariables) {
		const resolvedConfiguration = await provider.resolveDebugConfigurationWithSubstitutedVariables(undefined, configuration);
		if (resolvedConfiguration) {
			vscode.debug.startDebugging(undefined, resolvedConfiguration);
		}
	}
}

async function attach(context: processListProvider.Process | undefined) : Promise<void>
{
	if (context?.label === undefined) {
		return;
	}

	const pid = Number(context.pid);
	const qnxPath = typeof context.label === 'string'? context.label : context.label.label;

	return debugTools.attach(pid, qnxPath, qConnTargetHost, qConnTargetPort);
}

export function activate(context: vscode.ExtensionContext) {
	console.log('Activating QConn extension');
	outputChannel.activate();
	outputChannel.log('Activating QConn extension');

	qConnTargetHost = vscode.workspace.getConfiguration("qConn").get<string>("target.host", "127.0.0.1");
	qConnTargetPort = vscode.workspace.getConfiguration("qConn").get<number>("target.port", 8000);
	
	context.subscriptions.push(vscode.workspace.registerFileSystemProvider('qconnfs', new QConnFileSystemProvider(), { isCaseSensitive: true }));

	context.subscriptions.push(vscode.commands.registerCommand('qconn.kill', kill));
	context.subscriptions.push(vscode.commands.registerCommand('qconn.sigint', sigint));
	context.subscriptions.push(vscode.commands.registerCommand('qconn.connectFs', connectFs));
	context.subscriptions.push(vscode.commands.registerCommand('qconn.createQConnTerminal', () => { createQConnTerminal(qConnTargetHost, qConnTargetPort); }));
	context.subscriptions.push(vscode.commands.registerCommand('qconn.selectQConnTarget', () => { selectQConnTarget(); }));
	context.subscriptions.push(vscode.commands.registerCommand('qconn.copyFileToTarget', copyFileToTarget));
	context.subscriptions.push(createTerminalProfile());
	processExplorerTreeDataProvider = new processListProvider.ProcessListProvider(qConnTargetHost, qConnTargetPort);
	processExplorerTreeView = vscode.window.createTreeView('qConnProcessView', { treeDataProvider: processExplorerTreeDataProvider });
	context.subscriptions.push(vscode.commands.registerCommand('qconnProcessView.refresh', () => processExplorerTreeDataProvider.refresh()));

	fileExplorerTreeView = vscode.window.createTreeView('qConnFileExplorer', { treeDataProvider: fileExplorerTreeDataProvider });
	context.subscriptions.push(vscode.commands.registerCommand('qconnFileExplorer.refresh', () => fileExplorerTreeDataProvider.reconnect()));
	context.subscriptions.push(vscode.commands.registerCommand('qconnFileExplorer.deleteFile', (entry) => fileExplorerTreeDataProvider.delete(entry)));
	context.subscriptions.push(vscode.commands.registerCommand('qconnFileExplorer.renameFile', (entry) => fileExplorerTreeDataProvider.rename(entry)));
	context.subscriptions.push(vscode.commands.registerCommand('qconnFileExplorer.createFile', (entry) => createFileOrDirectory(vscode.FileType.File, entry)));
	context.subscriptions.push(vscode.commands.registerCommand('qconnFileExplorer.createDirectory', (entry) => createFileOrDirectory(vscode.FileType.Directory, entry)));
	context.subscriptions.push(vscode.commands.registerCommand('qconnFileExplorer.copyToHost', (entry) => { fileExplorerTreeDataProvider.copyToHost(entry); }));

	context.subscriptions.push(vscode.commands.registerCommand('qconn.PickCoreFileOnTarget', pickCoreFileOnTarget));
	context.subscriptions.push(vscode.commands.registerCommand('qconn.PickCoreFileOnLocal', pickCoreFileOnLocal));

	context.subscriptions.push(vscode.commands.registerCommand('qconn.attach', attach));
	context.subscriptions.push(vscode.commands.registerCommand('qconn.debug', debug));
	context.subscriptions.push(vscode.commands.registerCommand('qconn.debug_corefile', debug_corefile));

	processExplorerTreeView.onDidChangeVisibility(event => {
		if (event.visible) {
			processExplorerTreeDataProvider.startUpdating();
		} else {
			processExplorerTreeDataProvider.stopUpdating();
		}
	});
	if (processExplorerTreeView.visible) {
		processExplorerTreeDataProvider.startUpdating();
	}

	debugProvider.registerDebugProvider(context);

	vscode.workspace.onDidChangeConfiguration((event) => { configurationUpdated(event); });

	statusBar.initialize(context);

	const sdpSearchPaths = vscode.workspace.getConfiguration('qConn').get<string[]>('sdpSearchPaths');
	if (sdpSearchPaths) {
		startFindSDPPaths(sdpSearchPaths);
	}
}

export function deactivate() {
	statusBar.deactivate();
	outputChannel.deactivate();
}

