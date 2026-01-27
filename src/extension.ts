import * as vscode from 'vscode';
import { TerminalProvider } from './terminalProvider';
import { ShellProcessManager } from './shellProcessManager';
import { TerminalSessionManager } from './terminalSessionManager';
import { createContextTextForSelectedText } from './utils';
import { registerDropZoneProvider } from './dropZoneProvider';
import { getImageFromClipboard } from './clipboardImageHandler';

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
    vscode.commands.executeCommand('setContext', 'secondaryTerminal:dropZoneVisible', false);

    const provider = new TerminalProvider(context);

    // Drop Zone を登録（ファイルドロップ → ACE エディターにパス挿入）
    registerDropZoneProvider(context, (paths: string[]) => {
        // ドロップされたファイルパスを [@<path>] 形式で ACE エディターに送信
        const text = paths.map(p => `[@${p}]`).join('\n');
        provider.sendTextToEditor(text);
    });
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider('secondaryTerminalMainView', provider, {
            webviewOptions: {
                retainContextWhenHidden: true
            }
        })
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

    // エディターの選択範囲をSecondary Terminal の下部エディターに送信
    context.subscriptions.push(
        vscode.commands.registerCommand('secondaryTerminal.sendMainEditorSelection', () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showWarningMessage('アクティブなエディターがありません');
                return;
            }
            provider.sendTextToEditor(createContextTextForSelectedText(editor));
        })
    );

    // ターミナルの選択範囲をクリップボードにコピー → Secondary Terminal の下部エディターに送信
    context.subscriptions.push(
        vscode.commands.registerCommand('secondaryTerminal.sendMainTerminalSelection', async () => {
            const selectedText = await copyTerminalSelectionWithPrefix();
            if (selectedText) {
                provider.sendTextToEditor(selectedText);
            }
        })
    );

    // エディターの選択範囲をコードの位置つきでクリップボードにコピー
    context.subscriptions.push(
        vscode.commands.registerCommand('secondaryTerminal.copyMainEditorSelection', () => {
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
        vscode.commands.registerCommand('secondaryTerminal.copyMainTerminalSelection', async () => {
            const selectedText = await copyTerminalSelectionWithPrefix();
            if (selectedText) {
                await vscode.env.clipboard.writeText(selectedText);
                // ステータスバーに5秒間短いメッセージを表示
                vscode.window.setStatusBarMessage('$(check) コピーしました', 5000);
            }
        })
    );

    // ターミナルを再起動
    context.subscriptions.push(
        vscode.commands.registerCommand('secondaryTerminal.restart', async () => {
            const result = await vscode.window.showWarningMessage(
                'ターミナルをリセットしますか？\n実行中のプロセスはすべて終了します。',
                { modal: true },
                'リセット'
            );

            if (result === 'リセット') {
                await provider.resetTerminal();
            }
        })
    );

    // ログを表示
    context.subscriptions.push(
        vscode.commands.registerCommand('secondaryTerminal.showLogs', () => {
            provider.showLogs();
        })
    );

    // Drop Zone の表示/非表示をトグル
    let dropZoneVisible = false;
    context.subscriptions.push(
        vscode.commands.registerCommand('secondaryTerminal.toggleDropZone', () => {
            dropZoneVisible = !dropZoneVisible;
            vscode.commands.executeCommand('setContext', 'secondaryTerminal:dropZoneVisible', dropZoneVisible);
        })
    );

    // Drop Zone を開く（エディターへのドロップ時に呼ばれる）
    context.subscriptions.push(
        vscode.commands.registerCommand('secondaryTerminal.openDropZone', () => {
            if (!dropZoneVisible) {
                dropZoneVisible = true;
                vscode.commands.executeCommand('setContext', 'secondaryTerminal:dropZoneVisible', true);
            }
            vscode.window.showInformationMessage('Drop files to the "Drop Zone" panel above');
        })
    );

    // クリップボードから画像をペースト
    context.subscriptions.push(
        vscode.commands.registerCommand('secondaryTerminal.pasteImage', async () => {
            const imagePath = await getImageFromClipboard();
            if (imagePath) {
                provider.sendTextToEditor(`[@${imagePath}]`);
                vscode.window.setStatusBarMessage('$(check) Image pasted', 3000);
            } else {
                vscode.window.showInformationMessage('No image found in clipboard');
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
