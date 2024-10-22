import * as path from 'path';
import * as vscode from 'vscode';
import { fdir } from 'fdir';
import { fileExists } from './util';
import * as outputChannel from './outputChannel';
import { getDependenciesOfElf, resolveDependencies } from './debugResolvers';
import { ElfFileReader } from './elfParser';
import * as sdpPaths from './sdpPaths';

export enum QNXVersion {
	QNX70 = 70,
	QNX71 = 71
};

export async function getQNXVersionOfElf(elfFilePath: string): Promise<QNXVersion | undefined> {
	const commentSection = await new ElfFileReader().getCommentSection(elfFilePath);
	if (commentSection) {
		if (commentSection.includes("qnx700")) {
			return QNXVersion.QNX70;
		} else if (commentSection.includes("qnx710")) {
			return QNXVersion.QNX71;
		}
	}
	return undefined;
}

export async function debug(qnxPath: string, qConnTargetHost: string, qConnTargetPort: number): Promise<void> {
	if (!vscode.workspace.workspaceFolders) {
		vscode.window.showErrorMessage("No workspace opened. Cannot find program.");
		return;
	}

	const gdbPath = await sdpPaths.getGDBPath();
	if (!gdbPath || !await fileExists(gdbPath)) {
		const options = [`Open user settings`, `Open workspace settings`];
		const result = await vscode.window.showErrorMessage(`Unable to find gdb at ${gdbPath}. Have you set your SDP path correctly?`, ...options);
		if (result === options[0]) {
			vscode.commands.executeCommand("workbench.action.openSettings", "qconn.sdpSearchPaths");
		} else if (result === options[1]) {
			vscode.commands.executeCommand("workbench.action.openWorkspaceSettings", "qconn.sdpSearchPaths");
		}
		return;
	}

	const executableName = path.basename(qnxPath);

	const executableMatches = await new fdir()
		.withFullPaths()
		.filter(candidate => path.basename(candidate) === executableName)
		.crawl(vscode.workspace.workspaceFolders[0].uri.fsPath)
		.withPromise();

	if (executableMatches.length === 0) {
		vscode.window.showWarningMessage(`Unable to find ${executableName} in ${vscode.workspace.workspaceFolders[0].uri}`);
		return;
	}

	const programPath = executableMatches[0];
	const programPosixPath = programPath.replaceAll(path.sep, path["posix"].sep);
	const gdbPosixPath = gdbPath.replaceAll(path.sep, path["posix"].sep);

	outputChannel.log(`Getting dependencies of ${programPath}`);
	const dependencies = await getDependenciesOfElf(programPath);
	outputChannel.log(`Dependencies are ${dependencies?.map(dep => dep.soName + "(" + (dep.buildid ?? "unknown build ID") + ")")}`);
	let additionalSOLibSearchPath = "";
	if (dependencies) {
		let searchPaths = [vscode.workspace.workspaceFolders[0].uri.fsPath];

		const qnxVersion = await getQNXVersionOfElf(programPath);
		outputChannel.log(`${programPath} was built for ${qnxVersion}`);
		if (qnxVersion === QNXVersion.QNX70) {
			const qnx70SDPPath = await sdpPaths.getQNX70SDPPath();
			if (qnx70SDPPath) {
				searchPaths = [...searchPaths, qnx70SDPPath];
			}
		}
		if (qnxVersion === QNXVersion.QNX71) {
			const qnx71SDPPath = await sdpPaths.getQNX71SDPPath();
			if (qnx71SDPPath) {
				searchPaths = [...searchPaths, qnx71SDPPath];
			}
		}

		const additionalSOLibSearchPaths = vscode.workspace.getConfiguration("qConn").get<string[]>("additionalSOLibSearchPaths");
		if (additionalSOLibSearchPaths) {
			searchPaths = [...searchPaths, ...additionalSOLibSearchPaths];
		}
		outputChannel.log(`Searching ${searchPaths}`);
		const resolvedDependencies = await resolveDependencies(dependencies, searchPaths);
		outputChannel.log(`Resolved dependencies are ${resolvedDependencies}`);
		additionalSOLibSearchPath = resolvedDependencies.map(p => path.dirname(p)).join(";");
	}

	const configuration = {
		type: "cppdbg",
		name: "QNX launch " + qnxPath,
		request: "launch",
		program: programPosixPath,
		cwd: path.dirname(programPath),
		MIMode: "gdb",
		miDebuggerPath: gdbPosixPath,
		externalConsole: "false",
		additionalSOLibSearchPath: additionalSOLibSearchPath,
		launchCompleteCommand: "exec-run",
		targetArchitecture: "x86_64", // Figure out this dynamically
		customLaunchSetupCommands: [
			{ text: `target qnx ${qConnTargetHost}:${qConnTargetPort}` },
			{ text: `set nto-cwd ${path.dirname(qnxPath)}` },
			{ text: `file ${programPosixPath}` },
			{ text: `set nto-executable ${qnxPath}` }
		]
	};
	outputChannel.log(`Configuration is: ${JSON.stringify(configuration)}`);
	vscode.debug.startDebugging(undefined, configuration);
}

export async function attach(pid: number, qnxPath: string, qConnTargetHost: string, qConnTargetPort: number): Promise<void> {
	// TODO: Get the dependencies of the executable on-target.
	// We could spawn a shell and use pidin -p pid -F %O to get the list of shared libraries
	// file can be used to get the buildID of the libraries
	if (!vscode.workspace.workspaceFolders) {
		return;
	}

	const executableName = path.basename(qnxPath);

	const executableMatches = await new fdir()
		.withFullPaths()
		.filter(candidate => path.basename(candidate) === executableName)
		.crawl(vscode.workspace.workspaceFolders[0].uri.fsPath)
		.withPromise();

	if (executableMatches.length === 0) {
		vscode.window.showWarningMessage(`Unable to find ${executableName} in ${vscode.workspace.workspaceFolders[0].uri.fsPath}`);
		return;
	}

	const programPath = executableMatches[0];

	outputChannel.log(`Getting dependencies of ${programPath}`);
	const dependencies = await getDependenciesOfElf(programPath);
	outputChannel.log(`Dependencies are ${dependencies?.map(dep => dep.soName + "(" + (dep.buildid ?? "unknown build ID") + ")")}`);
	let additionalSOLibSearchPath = "";
	if (dependencies) {
		let searchPaths = [vscode.workspace.workspaceFolders[0].uri.fsPath];
		const qnxVersion = await getQNXVersionOfElf(programPath);
		outputChannel.log(`${programPath} was built for ${qnxVersion}`);
		if (qnxVersion === QNXVersion.QNX70) {
			const qnx70SDPPath = await sdpPaths.getQNX70SDPPath();
			if (qnx70SDPPath) {
				searchPaths = [...searchPaths, qnx70SDPPath];
			}
		}
		if (qnxVersion === QNXVersion.QNX71) {
			const qnx71SDPPath = await sdpPaths.getQNX71SDPPath();
			if (qnx71SDPPath) {
				searchPaths = [...searchPaths, qnx71SDPPath];
			}
		}

		const additionalSOLibSearchPaths = vscode.workspace.getConfiguration("qConn").get<string[]>("additionalSOLibSearchPaths");
		if (additionalSOLibSearchPaths) {
			searchPaths = [...searchPaths, ...additionalSOLibSearchPaths];
		}
		outputChannel.log(`Searching for dependencies in ${searchPaths}`);
		const resolvedDependencies = await resolveDependencies(dependencies, searchPaths);
		outputChannel.log(`Resolved dependencies are ${resolvedDependencies}`);
		additionalSOLibSearchPath = resolvedDependencies.map(p => path.dirname(p)).join(";");
	}

	const gdbPath = await sdpPaths.getGDBPath();
	if (!gdbPath || !await fileExists(gdbPath)) {
		const options = [`Open user settings`, `Open workspace settings`];
		const result = await vscode.window.showErrorMessage(`Unable to find gdb at ${gdbPath}. Have you set your SDP path correctly?`, ...options);
		if (result === options[0]) {
			vscode.commands.executeCommand("workbench.action.openSettings", "qconn.sdpSearchPaths");
		} else if (result === options[1]) {
			vscode.commands.executeCommand("workbench.action.openWorkspaceSettings", "qconn.sdpSearchPaths");
		}
		return;
	}

	const programPosixPath = programPath.replaceAll(path.sep, path["posix"].sep);
	const gdbPosixPath = gdbPath.replaceAll(path.sep, path["posix"].sep);

	const configuration = {
		type: "cppdbg",
		name: `QNX Attach ${qnxPath} (${pid})`,
		request: "launch",
		program: programPosixPath,
		cwd: path.dirname(programPath),
		MIMode: "gdb",
		miDebuggerPath: gdbPosixPath,
		externalConsole: "false",
		stopAtConnect: "true",
		launchCompleteCommand: "None",
		additionalSOLibSearchPath: additionalSOLibSearchPath,
		targetArchitecture: "x86_64",
		customLaunchSetupCommands: [
			{ text: `target qnx ${qConnTargetHost}:${qConnTargetPort}` },
			{ text: `file ${programPosixPath}` },
			{ text: `-target-attach ${pid}` }
		]
	};
	outputChannel.log(`Configuration is: ${JSON.stringify(configuration)}`);
	vscode.debug.startDebugging(undefined, configuration);
}
