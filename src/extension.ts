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
        try {
            // セッションマネージャーを先にクリーンアップ
            sessionManager.removeAllSessions();
            // プロセスマネージャーをクリーンアップ（同期版を使用）
            processManager.terminateAllProcesses();
        } catch (error) {
            console.error('Error during cleanup:', error);
            // エラーが発生してもプロセス終了は妨げない
        }
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

    // エディターの選択範囲をコードの位置つきでクリップボードにコピー
    context.subscriptions.push(
        vscode.commands.registerCommand('secondaryTerminal.copySelectionWithLocation', () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showWarningMessage('アクティブなエディターがありません');
                return;
            }
            const contextText = createContextTextForSelectedText(editor);
            vscode.env.clipboard.writeText(contextText).then(() => {
                vscode.window.showInformationMessage('コードの位置情報付きでクリップボードにコピーしました');
            });
        })
    );

    console.log('Secondary Terminal が有効化されました！');
}

export function deactivate() {
    // VSCode終了時は非同期処理やAPIを避けて、シンプルに同期処理のみ実行
    console.log('Secondary Terminal deactivation started...');
    
    try {
        // セッションマネージャーのクリーンアップ
        const sessionManager = TerminalSessionManager.getInstance();
        sessionManager.removeAllSessions();
        console.log('Sessions cleanup completed');
    } catch (error) {
        console.error('Error during sessions cleanup:', error);
    }

    try {
        // プロセスマネージャーのクリーンアップ（同期版のみ使用）
        const processManager = ShellProcessManager.getInstance();
        processManager.terminateAllProcesses();
        console.log('Process cleanup initiated');
    } catch (error) {
        console.error('Error during process cleanup:', error);
    }
    
    console.log('Secondary Terminal deactivation completed');
    
    // VSCode API は呼び出さない（終了時はコンテキストも自動でクリアされる）
}
