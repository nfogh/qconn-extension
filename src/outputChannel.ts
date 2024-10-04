import * as vscode from 'vscode';

let outputChannel: vscode.OutputChannel | undefined;

export function log(text: string) {
	outputChannel?.appendLine(new Date().toLocaleTimeString() + " " + text);
}

export function activate()
{
    if (!outputChannel) {
        outputChannel = vscode.window.createOutputChannel('qconn');
    }
}

export function deactivate()
{
    outputChannel?.dispose();
}