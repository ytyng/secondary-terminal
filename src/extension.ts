import * as vscode from 'vscode';
import { TerminalProvider } from './terminalProvider';
import { ShellProcessManager } from './shellProcessManager';
import { TerminalSessionManager } from './terminalSessionManager';
import { createContextTextForSelectedText } from './utils';

export function activate(context: vscode.ExtensionContext) {
    vscode.commands.executeCommand('setContext', 'secondaryTerminal:enabled', true);

    const provider = new TerminalProvider(context);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider('secondaryTerminalMainView', provider)
    );

    // プロセス終了イベントリスナーを追加して強制終了時のクリーンアップを保証
    const processManager = ShellProcessManager.getInstance();
    const sessionManager = TerminalSessionManager.getInstance();

    // Node.js プロセス終了時のクリーンアップ
    const cleanupHandler = () => {
        console.log('Cleaning up shell processes on exit...');
        processManager.terminateAllProcesses();
        sessionManager.removeAllSessions();
    };

    process.on('exit', cleanupHandler);
    process.on('SIGINT', cleanupHandler);
    process.on('SIGTERM', cleanupHandler);
    process.on('beforeExit', cleanupHandler);

    // context の subscriptions に cleanup 処理を登録
    context.subscriptions.push({
        dispose: cleanupHandler
    });

    context.subscriptions.push(
        vscode.commands.registerCommand('secondaryTerminal.focus', () => {
            vscode.commands.executeCommand('secondaryTerminalMainView.focus');
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
            provider.sendTextToTerminal(createContextTextForSelectedText(editor));
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
