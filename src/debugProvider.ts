import * as vscode from 'vscode';
import { ElfFileReader } from './elfParser';
import * as path from 'path';
import * as glob from 'fast-glob';

let toolsDir: string;

interface CoreDebugConfiguration extends vscode.DebugConfiguration
{
    coreDumpPath?: string;
    program?: string;
    additionalSOLibSearchPath?: string;
    miDebuggerPath?: string
};

interface Dependency {
    path: string;
    soName: string;
    buildid: string;
}

async function getDependenciesOfCoreFile(coreFilePath: string): Promise<Dependency[]>
{
    const elfFileReader = new ElfFileReader();
    const linkMaps = await elfFileReader.getLinkMap(coreFilePath);
    return linkMaps.map(map => { return {path: map.path, soName: map.soName, buildid: map.buildid}; } );
}

async function fileExists(path: string) : Promise<boolean> {
    try {
        await vscode.workspace.fs.stat(vscode.Uri.file(path));
        return true;
    } catch {
        return false;
    }
}

function getGDBPathFromSDP(sdpPath: string): string {
    if (process.platform === "win32") {
        return path.join(sdpPath, "usr", "bin", "ntox86_64-gdb.exe");
    } else {
        return path.join(sdpPath, "usr", "bin", "ntox86_64-gdb");
    }
}

class CoreDebugConfigurationProvider implements vscode.DebugConfigurationProvider {
    public resolveDebugConfiguration(folder: vscode.WorkspaceFolder | undefined, debugConfiguration: CoreDebugConfiguration, token?: vscode.CancellationToken): vscode.ProviderResult<vscode.DebugConfiguration>
    {
        return debugConfiguration;
    }

    public async resolveDebugConfigurationWithSubstitutedVariables?(folder: vscode.WorkspaceFolder | undefined, debugConfiguration: CoreDebugConfiguration, token?: vscode.CancellationToken): Promise<vscode.DebugConfiguration | undefined>
    {
        if (!debugConfiguration.coreDumpPath) {
            vscode.window.showErrorMessage("Debug type 'core' needs to have coreDumpPath defined");
            return undefined;
        }

        debugConfiguration.type = "cppdbg";
        debugConfiguration.request = "launch";

        if (!debugConfiguration.miDebuggerPath) {
            let gdbPath: string = "";
            if (await fileExists(getGDBPathFromSDP(vscode.workspace.getConfiguration("qConn").get<string>("sdpPath", "")))) {
                gdbPath = getGDBPathFromSDP(vscode.workspace.getConfiguration("qConn").get<string>("sdpPath", ""));
            } else if (process.env.QNX_HOST && await fileExists(getGDBPathFromSDP(process.env.QNX_HOST))) {
                gdbPath = getGDBPathFromSDP(process.env.QNX_HOST);
            } else {
                const sdpPaths = await vscode.window.showOpenDialog({
                    canSelectFolders: true,
                    canSelectFiles: false,
                    canSelectMany: false,
                    title: "Select SDP path"
                });
                if (sdpPaths?.length === 1) {
                    gdbPath = getGDBPathFromSDP(sdpPaths[0].fsPath);
                }
            }
            if (!(await fileExists(gdbPath))) {
                vscode.window.showErrorMessage(`Unable to find gdb at ${gdbPath}. Please set the configuration qConn.sdpPath to the path of your QNX sdp`);
            }
            debugConfiguration.miDebuggerPath = gdbPath;
        }

        const linkMap = (await getDependenciesOfCoreFile(debugConfiguration.coreDumpPath));

        // Try to resolve program
        if (!debugConfiguration.program) {
            if (vscode.workspace.workspaceFolders) {
                const buildId = linkMap.filter(link => link.soName === 'PIE')[0].buildid;
                const fileName = path.parse(debugConfiguration.coreDumpPath).name;
                const pattern = path.join(glob.convertPathToPattern(vscode.workspace.workspaceFolders[0].uri.fsPath),"**", fileName);
                const candidates = await glob.glob(pattern);
                const candidateBuildIds = await Promise.all(candidates.map(async path => { 
                    const buildId = await new ElfFileReader().getBuildID(path);
                    return { path, buildId };
                }));
                const candidatesWithMatchingBuildIds = candidateBuildIds.filter(candidate => candidate.buildId === buildId);
                const uniqueMatches = candidatesWithMatchingBuildIds.filter((a, index) => candidatesWithMatchingBuildIds.findIndex(b => a.path === b.path) === index);
                if (uniqueMatches.length !== 0) {
                    debugConfiguration.program = uniqueMatches[0].path;
                } else {
                    vscode.window.showWarningMessage(`Could not find program ${fileName} with build ID ${buildId}.\nYou can manually set the program path if you want to load this file regardless.`);
                }
            }
        }

        if (debugConfiguration.cwd === undefined && debugConfiguration.program) {
            debugConfiguration.cwd = path.dirname(debugConfiguration.program);
        }

        // Try to resolve additional .so lib paths
        if (!debugConfiguration.additionalSOLibSearchPath) {
            const dependencies = linkMap.filter(link => link.soName !== 'PIE');
            const dependencyMap = new Map(dependencies.map(dependency => [dependency.soName, dependency.buildid]));
            const dependencyBaseNames = dependencies.map(dependency => dependency.soName);

            // find all candidates
            if (vscode.workspace.workspaceFolders) {
                const allDependencyBaseNamesGlobPattern = dependencyBaseNames.join("|");
                const pattern = path.join(glob.convertPathToPattern(vscode.workspace.workspaceFolders[0].uri.fsPath),"**", allDependencyBaseNamesGlobPattern);
                const candidates = await glob.glob(pattern);

                const candidateBuildIds = await Promise.all(candidates.map(async path => { 
                    const buildId = await new ElfFileReader().getBuildID(path);
                    return { path, buildId };
                }));
                const candidatesWithMatchingBuildIds = candidateBuildIds.filter(candidate => candidate.buildId === dependencyMap.get(candidate.path));
                const uniqueMatches = candidatesWithMatchingBuildIds.filter((a, index) => candidatesWithMatchingBuildIds.findIndex(b => a.path === b.path) === index);
                const pathsToUniqueCandidates = uniqueMatches.map(match => path.dirname(match.path));
                debugConfiguration.additionalSOLibSearchPath = pathsToUniqueCandidates.join(";");
            }
        }

        return debugConfiguration;
    }
}

export function registerDebugProvider(ctx: vscode.ExtensionContext)
{
    ctx.subscriptions.push(
        vscode.debug.registerDebugConfigurationProvider(
            "qconn-core",
            new CoreDebugConfigurationProvider()
        )
    );
}
