import * as vscode from 'vscode';
import { TerminalProvider } from './terminalProvider';

export function activate(context: vscode.ExtensionContext) {
    vscode.commands.executeCommand('setContext', 'secondaryTerminal:enabled', true);

    const provider = new TerminalProvider(context);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider('terminalView', provider)
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('secondaryTerminal.focus', () => {
            vscode.commands.executeCommand('terminalView.focus');
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('secondaryTerminal.clear', () => {
            provider.clearTerminal();
        })
    );

    console.log('Secondary Terminal が有効化されました！');
}

export function deactivate() {
    vscode.commands.executeCommand('setContext', 'secondaryTerminal:enabled', false);
}
