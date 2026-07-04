import * as vscode from 'vscode';
import { TerminalProvider } from './terminalProvider';
import { ShellProcessManager } from './shellProcessManager';
import { TerminalSessionManager } from './terminalSessionManager';
import { createContextTextForSelectedText } from './utils';
import { registerDropZoneProvider } from './dropZoneProvider';
import { getImageFromClipboard } from './clipboardImageHandler';
import { toggleClaudeSandbox } from './claudeSandboxToggle';

/**
 * ターミナルの選択テキストをクリップボードにコピーして取得
 * ユーザーのクリップボード内容は処理後に復元する
 */
async function copyTerminalSelection(): Promise<string | null> {
    const activeTerminal = vscode.window.activeTerminal;
    if (!activeTerminal) {
        vscode.window.showWarningMessage('アクティブなターミナルがありません');
        return null;
    }

    // 元のクリップボード内容を退避する (copySelection で上書きされるため)。
    // 注: readText はテキストしか取得できないため、画像等の非テキスト内容は退避できない。
    // 選択が無い場合 copySelection はクリップボードを変更しないので、
    // 「内容が変化した場合のみ復元する」ことで非テキスト内容の不要な破壊を避ける。
    // 制約: 選択テキストが退避内容と完全一致する場合は「選択なし」と誤判定する。
    // クリップボード API から選択の有無を直接知る手段が無く、判定用に毎回書き込む
    // センチネル方式は非テキスト内容を必ず破壊してしまうため、この誤判定を許容する。
    const previousClipboard = await vscode.env.clipboard.readText();

    try {
        // ターミナルの選択をクリップボードにコピー
        await vscode.commands.executeCommand('workbench.action.terminal.copySelection');

        // 短い待機時間を設ける
        await new Promise(resolve => setTimeout(resolve, 50));

        // クリップボードから選択テキストを取得
        const selectedText = await vscode.env.clipboard.readText();

        if (selectedText && selectedText.trim() && selectedText !== previousClipboard) {
            // クリップボードが上書きされたので、退避した内容を復元してから返す
            await vscode.env.clipboard.writeText(previousClipboard);
            return selectedText;
        }
        // クリップボードが変化していない = 選択なし。復元も行わない
        vscode.window.showWarningMessage('ターミナルでテキストが選択されていません');
        return null;
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


/**
 * セッションとシェルプロセスを後始末する
 * deactivate と subscriptions.dispose から呼ばれる
 * @returns プロセス終了処理の完了を待てる Promise
 */
function performCleanup(): Promise<void> {
    try {
        // セッションマネージャーを先にクリーンアップ
        TerminalSessionManager.getInstance().removeAllSessions();
    } catch (error) {
        console.error('Error during sessions cleanup:', error);
    }

    try {
        // プロセスマネージャーをクリーンアップ (SIGTERM → 2秒後 SIGKILL)
        return ShellProcessManager.getInstance().terminateAllProcessesAsync();
    } catch (error) {
        console.error('Error during process cleanup:', error);
        return Promise.resolve();
    }
}

/**
 * process.on('exit') 用の緊急クリーンアップ。
 * 'exit' ハンドラー内ではイベントループが回らず setTimeout の SIGKILL
 * フォールバックが実行されないため、猶予なしの完全同期で kill する。
 */
function performEmergencyCleanupSync(): void {
    try {
        TerminalSessionManager.getInstance().removeAllSessions();
    } catch (error) {
        console.error('Error during sessions cleanup:', error);
    }
    try {
        ShellProcessManager.getInstance().killAllProcessesSync();
    } catch (error) {
        console.error('Error during process cleanup:', error);
    }
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

    // Node.js プロセス終了時のクリーンアップ。
    // SIGINT / SIGTERM のハンドラーは登録しない。リスナーを登録すると Node.js の
    // デフォルト終了動作が無効化され、process.exit() を呼ばない限り
    // 拡張ホストプロセスがシグナル受信後もハングし続けるため。
    // 通常のシャットダウンは deactivate() が、強制終了は 'exit' がカバーする。
    process.on('exit', performEmergencyCleanupSync);

    // context の subscriptions に cleanup 処理を登録
    context.subscriptions.push({
        dispose: () => { void performCleanup(); }
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

    // glyph atlas 破損による表示崩れを VSCode 再起動なしで復旧する
    context.subscriptions.push(
        vscode.commands.registerCommand('secondaryTerminal.refreshRenderer', () => {
            provider.refreshRenderer();
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

    // Claude Code の sandbox をトグル (<workspace>/.claude/settings.local.json の sandbox.enabled)
    context.subscriptions.push(
        vscode.commands.registerCommand('secondaryTerminal.toggleClaudeSandbox', () => {
            const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
            if (!workspaceFolder) {
                vscode.window.showWarningMessage('No workspace folder open');
                return;
            }
            try {
                const result = toggleClaudeSandbox(workspaceFolder.uri.fsPath);
                const status = result.enabled ? 'ON' : 'OFF';
                vscode.window.showInformationMessage(`Claude sandbox: ${status}`);
                if (!result.enabled) {
                    provider.sendTextToEditorIfEmpty('I turned off the sandbox. Try again.');
                }
            } catch (error) {
                const msg = error instanceof Error ? error.message : String(error);
                vscode.window.showErrorMessage(`Failed to toggle Claude sandbox: ${msg}`);
            }
        })
    );
}

export function deactivate(): Promise<void> {
    // Promise を返すことで、VSCode が SIGKILL フォールバックを含む
    // 非同期の終了処理の完了を待ってくれる
    // (VSCode API は呼び出さない。終了時はコンテキストも自動でクリアされる)
    return performCleanup();
}
