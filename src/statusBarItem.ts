import * as vscode from 'vscode';
import { SysInfoUpdater } from './sysInfoUpdater';

let sysInfoUpdater: SysInfoUpdater;
let statusBarItem: vscode.StatusBarItem;
let prevPing: number = Date.now();
let pingUpdater: NodeJS.Timeout;

let currentHost: string = vscode.workspace.getConfiguration("qConn").get<string>("target.host", "127.0.0.1");
let currentPort: number = vscode.workspace.getConfiguration("qConn").get<number>("target.port", 8000);

export function defaultText()
{
    setText(`QConn@${currentHost}` + (currentPort === 8000 ? "" : `:${currentPort}`));
}

export function setText(text: string)
{
    statusBarItem.text = text;
}

export function setHost(host: string, port: number) {
	currentHost = host;
	currentPort = port;
	sysInfoUpdater = new SysInfoUpdater(currentHost, currentPort, (hostname, memTotal, memFree) => {
		prevPing = Date.now();
		const MB = BigInt(1024 * 1024);

		statusBarItem.tooltip = "Click to select QConn target\n" +
			`Hostname: ${hostname}\n` +
			`Memory Free ${Number(memFree / MB)}MB / Total ${Number(memTotal / MB)}MB`;
	});
	sysInfoUpdater.startUpdating(5000);

	defaultText();
}

export function initialize(context: vscode.ExtensionContext)
{
	statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
    defaultText();
	statusBarItem.tooltip = "Click to select QConn target";
	statusBarItem.command = "qconn.selectQConnTarget";

	setHost(
		vscode.workspace.getConfiguration("qConn").get<string>("target.host", "127.0.0.1"),
		vscode.workspace.getConfiguration("qConn").get<number>("target.port", 8000));

    context.subscriptions.push(statusBarItem);
    statusBarItem.show();

	pingUpdater = setInterval(() => {
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

export function deactivate()
{
	sysInfoUpdater.stopUpdating();
	clearInterval(pingUpdater);
}