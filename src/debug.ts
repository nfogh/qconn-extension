import * as path from 'path';
import * as vscode from 'vscode';
import { fdir } from 'fdir';
import { fileExists, unique } from './util';
import { ElfFileReader } from './elfParser';
import * as outputChannel from './outputChannel';

interface Dependency {
	path: string;
	soName: string;
	buildid: string;
}

export async function getDependenciesOfElfFile(elfFilePath: string): Promise<string[] | undefined> {
	return new ElfFileReader().getNeededLibs(elfFilePath);
}

export async function getDependenciesOfCoreFile(coreFilePath: string): Promise<Dependency[]> {
	const elfFileReader = new ElfFileReader();
	const linkMaps = await elfFileReader.getLinkMap(coreFilePath);
	return linkMaps.map(map => { return { path: map.path, soName: map.soName, buildid: map.buildid }; });
}

export function getGDBPathFromSDP(sdpPath: string): string {
	if (process.platform === "win32") {
		return path.join(sdpPath, "usr", "bin", "ntox86_64-gdb.exe");
	} else {
		return path.join(sdpPath, "usr", "bin", "ntox86_64-gdb");
	}
}

export async function resolveElfFileDependencies(dependencies: string[]): Promise<string[]> {
	if (vscode.workspace.workspaceFolders) {
		const candidates = await (new fdir()
			.withBasePath()
			.filter(p => dependencies.includes(path.basename(p)))
			.crawl(vscode.workspace.workspaceFolders[0].uri.fsPath).withPromise());
		outputChannel.log(`SO lib candidates are: ${candidates}`);
		return candidates;
	}
	return [];
}

export async function resolveDependencies(dependencies: Dependency[]): Promise<string[]> {
	const dependencyBuildIDs = new Map(dependencies.map(dependency => [dependency.soName, dependency.buildid]));
	const dependencyBaseNames = dependencies.map(dependency => dependency.soName);

	// find all candidates
	if (vscode.workspace.workspaceFolders) {
		const candidates = await (new fdir()
			.withBasePath()
			.filter(p => dependencyBaseNames.includes(path.basename(p)))
			.crawl(vscode.workspace.workspaceFolders[0].uri.fsPath).withPromise());
		outputChannel.log(`SO lib candidates are: ${candidates}`);

		const candidateBuildIds = await Promise.all(candidates.map(async path => {
			const buildId = await new ElfFileReader().getBuildID(path);
			return { path, buildId };
		}));

		const candidatesWithMatchingBuildIds = candidateBuildIds
			.filter(candidate => candidate.buildId === dependencyBuildIDs.get(candidate.path))
			.map(elem => elem.path);
		return candidatesWithMatchingBuildIds.filter(unique);
	}
	return [];
}

export async function debug(qnxPath: string, qConnTargetHost: string, qConnTargetPort: number): Promise<void> {
	if (!vscode.workspace.workspaceFolders) {
		vscode.window.showErrorMessage("No workspace opened. Cannot find program.");
		return;
	}

	const sdpPath = vscode.workspace.getConfiguration("qConn").get<string>("sdpPath", "");
	const gdbPath = getGDBPathFromSDP(sdpPath);
	if (!await fileExists(gdbPath)) {
		vscode.window.showWarningMessage(`Unable to find gdb in SDP ${sdpPath}. Have you set your SDP path correctly?`);
		return;
	}

	const executableName = path.basename(qnxPath);

	const executableMatches = await new fdir()
		.withFullPaths()
		.filter(candidate => path.basename(candidate) === executableName)
		.crawl(vscode.workspace.workspaceFolders[0].uri.fsPath)
		.withPromise();

	if (executableMatches.length === 0) {
		vscode.window.showWarningMessage(`Unable to find ${executableName} in ${vscode.workspace.workspaceFolders[0]}`);
		return;
	}

	const programPath = executableMatches[0];
	const programPosixPath = programPath.replaceAll(path.sep, path["posix"].sep);
	const gdbPosixPath = gdbPath.replaceAll(path.sep, path["posix"].sep);

	const configuration = {
		type: "cppdbg",
		name: "QNX launch " + qnxPath,
		request: "launch",
		program: programPosixPath,
		cwd: ".",
		MIMode: "gdb",
		miDebuggerPath: gdbPosixPath,
		externalConsole: "false",
		launchCompleteCommand: "exec-run",
		targetArchitecture: "x86_64", // Figure out this dynamically
		customLaunchSetupCommands: [
			{ text: `target qnx ${qConnTargetHost}:${qConnTargetPort}` },
			{ text: `set nto-cwd ${path.dirname(qnxPath)}` },
			{ text: `file ${programPath}` },
			{ text: `set nto-executable ${qnxPath}` }
		]
	};
	outputChannel.log(`Configuration is: ${JSON.stringify(configuration)}`);
	vscode.debug.startDebugging(undefined, configuration);
}

export async function attach(pid: number, qnxPath: string, qConnTargetHost: string, qConnTargetPort: number): Promise<void> {
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
	const dependencies = await getDependenciesOfElfFile(programPath);
	outputChannel.log(`Got ${dependencies}`);
	let additionalSOLibSearchPath = "";
	if (dependencies) {
		const resolvedDependencies = await resolveElfFileDependencies(dependencies);
		additionalSOLibSearchPath = resolvedDependencies.map(p => path.dirname(p)).join(";");
	}

	const sdpPath = vscode.workspace.getConfiguration("qConn").get<string>("sdpPath", "");
	const gdbPath = getGDBPathFromSDP(sdpPath);
	if (!await fileExists(gdbPath)) {
		vscode.window.showWarningMessage(`Unable to find gdb in SDP ${sdpPath}. Have you set your SDP path correctly?`);
		return;
	}

	const programPosixPath = programPath.replaceAll(path.sep, path["posix"].sep);
	const gdbPosixPath = gdbPath.replaceAll(path.sep, path["posix"].sep);

	const configuration = {
		type: "cppdbg",
		name: `QNX Attach ${qnxPath} (${pid})`,
		request: "launch",
		program: programPosixPath,
		cwd: ".",
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
