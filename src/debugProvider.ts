import * as vscode from 'vscode';
import * as path from 'path';
import { log } from './outputChannel';
import { fileExists } from './util';
import { getQNXVersionOfElf, QNXVersion } from './debug';
import { getDependenciesOfElf, resolveDependencies } from './debugResolvers';
import * as sdpPaths from './sdpPaths';

let toolsDir: string;

export interface CoreDebugConfiguration extends vscode.DebugConfiguration
{
    coreDumpPath?: string;
    program?: string;
    additionalSOLibSearchPath?: string;
    miDebuggerPath?: string
};

export class CoreDebugConfigurationProvider implements vscode.DebugConfigurationProvider {
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
        debugConfiguration.MIMode = "gdb";

        if (!debugConfiguration.miDebuggerPath) {
            let sdpPath = await sdpPaths.getQNX70SDPPath();
            if (!sdpPath) {
                const options = [`Open user settings`, `Open workspace settings`];
                const result = await vscode.window.showErrorMessage(`Unable to find sdp at ${sdpPath}. Have you set your SDP path correctly?`, ...options);
                if (result === options[0]) {
                    vscode.commands.executeCommand("workbench.action.openSettings", "qconn.sdpSearchPaths");
                } else if (result === options[1]) {
                    vscode.commands.executeCommand("workbench.action.openWorkspaceSettings", "qconn.sdpSearchPaths");
                }
                return undefined;
            }
            const gdbPath = await sdpPaths.getGDBPath();
            if (!gdbPath || !(await fileExists(gdbPath))) {
                vscode.window.showErrorMessage(`Unable to find gdb at ${gdbPath}. Please set the configuration qConn.sdpSearchPaths to the path of your QNX sdp`);
                return undefined;
            }
            debugConfiguration.miDebuggerPath = gdbPath;
        }

        const dependencies = await getDependenciesOfElf(debugConfiguration.coreDumpPath);

        // Try to resolve program
        if (!debugConfiguration.program) {
            if (vscode.workspace.workspaceFolders && dependencies) {
                const programName = path.parse(debugConfiguration.coreDumpPath).name;
                let programDependency = dependencies.filter(link => link.soName === 'PIE')[0];
                programDependency.soName = programName;
                log(`Resolving program ${programName}`);
                const resolvedProgram = await resolveDependencies([programDependency], [vscode.workspace.workspaceFolders[0].uri.fsPath]);
                if (resolvedProgram.length !== 0) {
                    debugConfiguration.program = resolvedProgram[0];
                    log(`Resolved program at ${debugConfiguration.program}`);
                } else {
                    vscode.window.showWarningMessage(`Could not find program ${programName} with build ID ${programDependency.buildid}.\nYou must manually add a launch configuration and set the program path.`);
                }
            }
        }

        if (debugConfiguration.cwd === undefined && debugConfiguration.program) {
            debugConfiguration.cwd = path.dirname(debugConfiguration.program);
        }

        // Try to resolve additional .so lib paths
        if (!debugConfiguration.additionalSOLibSearchPath) {
            if (vscode.workspace.workspaceFolders && dependencies) {
                log(`Resolving shared library dependencies`);
                const soLibDependencies = dependencies.filter(link => link.soName !== 'PIE');

                let searchPaths = [vscode.workspace.workspaceFolders[0].uri.fsPath];
                if (debugConfiguration.program) {
                    const qnxVersion = await getQNXVersionOfElf(debugConfiguration.program);
                    const sdpPath = await (qnxVersion === QNXVersion.QNX70 ? sdpPaths.getQNX70SDPPath() : sdpPaths.getQNX71SDPPath());
                    if (sdpPath) {
                        searchPaths.push(path.join(sdpPath));
                    }
                }
                log(`Searching ${searchPaths} for ${JSON.stringify(soLibDependencies)}`);
                const resolvedDependencies = await resolveDependencies(soLibDependencies, searchPaths);
                log(`Resolved SO libs paths are ${resolvedDependencies}`);
                debugConfiguration.additionalSOLibSearchPath = resolvedDependencies.map(p => path.dirname(p)).join(";");
            }
        }

        log(`Final debug configuration is ${JSON.stringify(debugConfiguration)}`);

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
