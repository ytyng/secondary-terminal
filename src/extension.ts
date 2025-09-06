import * as vscode from 'vscode';
import { TerminalProvider } from './terminalProvider';
import { ShellProcessManager } from './shellProcessManager';
import { TerminalSessionManager } from './terminalSessionManager';
import { createContextTextForSelectedText } from './utils';

/**
 * ターミナルの選択テキストをクリップボードにコピーして取得
 */
async function copyTerminalSelection(): Promise<string | null> {
    const activeTerminal = vscode.window.activeTerminal;
    if (!activeTerminal) {
        vscode.window.showWarningMessage('アクティブなターミナルがありません');
        return null;
    }

    try {
        // ターミナルの選択をクリップボードにコピー
        await vscode.commands.executeCommand('workbench.action.terminal.copySelection');

        // 短い待機時間を設ける
        await new Promise(resolve => setTimeout(resolve, 50));

        // クリップボードから選択テキストを取得
        const selectedText = await vscode.env.clipboard.readText();

        if (selectedText && selectedText.trim()) {
            return selectedText;
        } else {
            vscode.window.showWarningMessage('ターミナルでテキストが選択されていません');
            return null;
        }
    } catch (error) {
        vscode.window.showWarningMessage('ターミナルの選択テキストを取得できませんでした');
        return null;
    }
}


async function copyTerminalSelectionWithPrefix(): Promise<string | null> {
    const selectedText = await copyTerminalSelection();
    if (selectedText) {
        return `[@terminal]\n\`\`\`\n${selectedText}\n\`\`\`\n`;
    }
    return null;
}


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

    // ターミナルの選択範囲をクリップボードにコピー→Secondary Terminalに送信
    context.subscriptions.push(
        vscode.commands.registerCommand('secondaryTerminal.sendTerminalSelection', async () => {
            const selectedText = await copyTerminalSelectionWithPrefix();
            if (selectedText) {
                provider.sendTextToTerminal(selectedText);
            }
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
                // ステータスバーに5秒間短いメッセージを表示
                vscode.window.setStatusBarMessage('$(check) コピーしました', 5000);
            });
        })
    );

    // ターミナルの選択範囲をクリップボードにコピー（[@terminal]形式）
    context.subscriptions.push(
        vscode.commands.registerCommand('secondaryTerminal.copyTerminalSelectionWithLocation', async () => {
            const selectedText = await copyTerminalSelectionWithPrefix();
            if (selectedText) {
                await vscode.env.clipboard.writeText(selectedText);
                // ステータスバーに5秒間短いメッセージを表示
                vscode.window.setStatusBarMessage('$(check) コピーしました', 5000);
            }
        })
    );

}

export function deactivate() {
    // VSCode終了時は非同期処理やAPIを避けて、シンプルに同期処理のみ実行

    try {
        // セッションマネージャーのクリーンアップ
        const sessionManager = TerminalSessionManager.getInstance();
        sessionManager.removeAllSessions();
    } catch (error) {
        console.error('Error during sessions cleanup:', error);
    }

    try {
        // プロセスマネージャーのクリーンアップ（同期版のみ使用）
        const processManager = ShellProcessManager.getInstance();
        processManager.terminateAllProcesses();
    } catch (error) {
        console.error('Error during process cleanup:', error);
    }

    // VSCode API は呼び出さない（終了時はコンテキストも自動でクリアされる）
}
