import * as vscode from 'vscode';
import { TerminalProvider } from './terminalProvider';
import { ShellProcessManager } from './shellProcessManager';
import { TerminalSessionManager } from './terminalSessionManager';

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

    // エディターの選択範囲をSecondary Terminalに送信
    context.subscriptions.push(
        vscode.commands.registerCommand('secondaryTerminal.sendSelection', () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showWarningMessage('アクティブなエディターがありません');
                return;
            }

            const document = editor.document;
            const selection = editor.selection;
            const fileName = document.fileName;
            const selectedText = document.getText(selection);

            if (selectedText) {
                // 選択されたテキストがある場合：ファイル名、行範囲、選択テキストを送信
                const startLine = selection.start.line + 1;
                const endLine = selection.end.line + 1;
                const lineInfo = startLine === endLine ? `line:${startLine}` : `lines:${startLine}-${endLine}`;
                const message = `File:${fileName} (${lineInfo})\n${selectedText}\n`;
                provider.sendTextToTerminal(message);
            } else {
                // 選択されたテキストがない場合：ファイル名と現在の行番号を送信
                const currentLine = selection.start.line + 1;
                const message = `File:${fileName} (line:${currentLine})\n`;
                provider.sendTextToTerminal(message);
            }
        })
    );

    console.log('Secondary Terminal が有効化されました！');
}

export function deactivate() {
    vscode.commands.executeCommand('setContext', 'secondaryTerminal:enabled', false);

    // 拡張機能が非アクティブになったときに全てのリソースをクリーンアップ
    const processManager = ShellProcessManager.getInstance();
    processManager.terminateAllProcesses();

    const sessionManager = TerminalSessionManager.getInstance();
    sessionManager.removeAllSessions();

    console.log('Secondary Terminal が無効化されました。');
}
