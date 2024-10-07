import * as vscode from 'vscode';

export async function fileExists(path: string) : Promise<boolean> {
    try {
        await vscode.workspace.fs.stat(vscode.Uri.file(path));
        return true;
    } catch {
        return false;
    }
}

export function unique<Value>(value: Value, index: number, array: Value[]) { return array.indexOf(value) === index; };
