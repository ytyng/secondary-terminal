import * as vscode from 'vscode';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { ShellProcessManager } from './shellProcessManager';
import { TerminalSessionManager } from './terminalSessionManager';
import { createContextTextForSelectedText } from './utils';

// タブ情報の型定義
interface TabInfo {
    id: string;
    title: string;
}

// タブ状態管理の型定義
interface TabState {
    tabs: TabInfo[];
    activeTabId: string | null;
    nextTabNumber: number;
}

// WebView メッセージの型定義
interface WebViewMessage {
    type: 'terminalInput' | 'terminalReady' | 'tabReady' | 'resize' | 'error' | 'buttonSendSelection' | 'buttonCopySelection' | 'refreshCliAgentStatus' | 'bufferCleanupRequest' | 'terminalInputBegin' | 'terminalInputChunk' | 'terminalInputEnd' | 'editorSendContent' | 'log' | 'extractToTodos' | 'openPromptHistory' | 'createTab' | 'switchTab' | 'closeTab' | 'pasteImage' | 'openDropZone' | 'openLink' | 'oscNotification';
    data?: string;
    cols?: number;
    rows?: number;
    error?: string;
    message?: string;
    timestamp?: number;
    // Tab specific properties
    tabId?: string;
    tab?: TabInfo;
    // Buffer cleanup specific properties
    currentLines?: number;
    threshold?: number;
    preserveScrollPosition?: boolean;
    // Chunked paste properties
    id?: string;
    totalBytes?: number;
    kind?: string;
    b64?: string;
    offset?: number;
    size?: number;
    // Editor specific properties
    text?: string;
    // OSC notification properties (OSC 9 / 777 / 99)
    osc?: number;
    title?: string;
    body?: string;
}

export class TerminalProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;
    private _cwd: string;
    private _terminalCols: number = 80;
    private _terminalRows: number = 24;
    private _workspaceKey: string;
    private _processManager = ShellProcessManager.getInstance();
    private _sessionManager = TerminalSessionManager.getInstance();

    // マルチタブ状態管理
    private _tabState: TabState = {
        tabs: [],
        activeTabId: null,
        nextTabNumber: 1
    };

    // チャンクペースト用の状態管理
    // terminalInputEnd が届かないままセッションが残留しないよう、タイムアウトタイマーを持つ
    private _chunkSessions: Map<string, {
        totalBytes: number;
        receivedBytes: number;
        kind?: string | undefined;
        tabId?: string | undefined;
        timeoutTimer: NodeJS.Timeout;
    }> = new Map();

    // チャンクセッションの無通信タイムアウト (ミリ秒)
    private static readonly CHUNK_SESSION_TIMEOUT_MS = 30000;

    // ログ管理
    private _logs: string[] = [];

    constructor(private readonly _extensionContext: vscode.ExtensionContext) {
        this._cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || os.homedir();
        // ワークスペースキーはワークスペースフォルダのパスまたはホームディレクトリを使用
        this._workspaceKey = this._cwd;

        // フォント・レイアウト設定の変更を webview に即時反映する
        vscode.workspace.onDidChangeConfiguration((event) => {
            if (event.affectsConfiguration('secondaryTerminal.fontFamily') ||
                event.affectsConfiguration('secondaryTerminal.fontSize') ||
                event.affectsConfiguration('secondaryTerminal.lineHeight') ||
                event.affectsConfiguration('secondaryTerminal.letterSpacing') ||
                event.affectsConfiguration('secondaryTerminal.editorHeight') ||
                event.affectsConfiguration('secondaryTerminal.layout')) {
                this._view?.webview.postMessage({
                    type: 'updateFontSettings',
                    settings: this.getFontSettings()
                });
            }
        }, null, this._extensionContext.subscriptions);
    }

    // フォント・レイアウト設定を VSCode 設定から取得する
    private getFontSettings(): {
        fontFamily: string;
        fontSize: number;
        lineHeight: number;
        letterSpacing: number;
        editorHeight: number;
        widthAdjustment: number;
        heightAdjustment: number;
    } {
        const config = vscode.workspace.getConfiguration('secondaryTerminal');
        // package.json の minimum/maximum は設定 UI でしか強制されないため、
        // settings.json 直編集による範囲外の値 (widthAdjustment: 0 → cols=Infinity 等) をここでクランプする
        const clamp = (value: unknown, min: number, max: number, defaultValue: number): number =>
            typeof value === 'number' && Number.isFinite(value)
                ? Math.min(max, Math.max(min, value))
                : defaultValue;
        return {
            fontFamily: config.get<string>('fontFamily', '"RobotoMono Nerd Font Mono", "RobotoMono Nerd Font", "Roboto Mono", Consolas, "Courier New", monospace'),
            fontSize: clamp(config.get('fontSize'), 6, 32, 13),
            lineHeight: clamp(config.get('lineHeight'), 1, 2, 1.2),
            letterSpacing: clamp(config.get('letterSpacing'), -2, 10, 0),
            editorHeight: clamp(config.get('editorHeight'), 40, 1000, 200),
            widthAdjustment: clamp(config.get('layout.widthAdjustment'), 0.5, 1.5, 0.88),
            heightAdjustment: clamp(config.get('layout.heightAdjustment'), 0.5, 2, 1.34)
        };
    }

    private getVersionInfo(): { version: string; buildDate: string } {
        try {
            const versionPath = path.join(this._extensionContext.extensionPath, 'src', 'version.json');
            const versionData = JSON.parse(fs.readFileSync(versionPath, 'utf8'));
            return {
                version: versionData.version || '0.1.0',
                buildDate: versionData.updatedAt || versionData.buildDate || 'Unknown'
            };
        } catch (error) {
            // Failed to read version info - using defaults
            return {
                version: '0.1.0',
                buildDate: 'Unknown'
            };
        }
    }

    // ワークスペースキーとタブIDから複合キーを生成
    private getCompositeKey(tabId: string): string {
        return `${this._workspaceKey}:${tabId}`;
    }

    // 新しいタブを作成
    private handleCreateTab(): TabInfo {
        const tabId = `tab-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
        const tab: TabInfo = {
            id: tabId,
            title: `Terminal ${this._tabState.nextTabNumber++}`
        };
        this._tabState.tabs.push(tab);
        this._tabState.activeTabId = tabId;
        this.appendLog(`Created new tab: ${tab.title} (${tabId})`);
        return tab;
    }

    // タブを切り替え
    private handleSwitchTab(tabId: string): void {
        const tab = this._tabState.tabs.find(t => t.id === tabId);
        if (tab) {
            this._tabState.activeTabId = tabId;
            this.appendLog(`Switched to tab: ${tab.title} (${tabId})`);
        }
    }

    // タブを閉じる
    private handleCloseTab(tabId: string): void {
        const tabIndex = this._tabState.tabs.findIndex(t => t.id === tabId);
        if (tabIndex === -1) {
            return;
        }

        const tab = this._tabState.tabs[tabIndex];
        if (!tab) {
            return;
        }
        this.appendLog(`Closing tab: ${tab.title} (${tabId})`);

        // プロセスを終了（exitコールバックは解除してから終了）
        const compositeKey = this.getCompositeKey(tabId);
        this._processManager.unregisterExitCallback(compositeKey);
        this._processManager.terminateProcess(compositeKey);
        // clearBuffer ではなく removeSession で Map からエントリごと削除する。
        // タブ ID は毎回ユニークなので、削除しないとタブ開閉のたびにセッションが蓄積する。
        this._sessionManager.removeSession(compositeKey);

        // タブリストから削除
        this._tabState.tabs.splice(tabIndex, 1);

        // アクティブタブだった場合、別のタブに切り替え
        if (this._tabState.activeTabId === tabId) {
            const firstTab = this._tabState.tabs[0];
            if (firstTab) {
                this._tabState.activeTabId = firstTab.id;
            } else {
                this._tabState.activeTabId = null;
            }
        }

        // フロントエンドにタブ閉じ完了を通知
        this._view?.webview.postMessage({
            type: 'tabClosed',
            tabId: tabId
        });
    }

    // 特定タブのシェルを起動
    private startShellForTab(tabId: string): void {
        const compositeKey = this.getCompositeKey(tabId);

        // プロセス終了時のコールバックを登録（タブを閉じる）
        this._processManager.registerExitCallback(compositeKey, () => {
            this.appendLog(`Process exited for tab: ${tabId}`);
            // フロントエンドにタブを閉じるように通知
            this._view?.webview.postMessage({
                type: 'tabProcessExited',
                tabId: tabId
            });
            // バックエンドの状態からも削除
            const tabIndex = this._tabState.tabs.findIndex(t => t.id === tabId);
            if (tabIndex !== -1) {
                this._tabState.tabs.splice(tabIndex, 1);
                if (this._tabState.activeTabId === tabId) {
                    const firstTab = this._tabState.tabs[0];
                    this._tabState.activeTabId = firstTab ? firstTab.id : null;
                }
            }
            // セッションを Map から完全に削除する (clearBuffer だとエントリが残留する)
            this._sessionManager.removeSession(compositeKey);
        });

        // プロセスマネージャーからプロセスを取得または作成
        // startup commands の「一度だけ実行」判定はタブ ID を含まないワークスペースキーで行う
        this._processManager.getOrCreateProcess(
            compositeKey,
            this._extensionContext.extensionPath,
            this._cwd,
            this._terminalCols,
            this._terminalRows,
            this._workspaceKey
        );

        // セッションに WebView を接続
        if (this._view) {
            this._sessionManager.connectViewWithTabId(compositeKey, this._view, tabId);
        }

        // 既存のバッファがない場合のみウェルカムメッセージを表示
        if (!this._sessionManager.getBuffer(compositeKey)) {
            const versionInfo = this.getVersionInfo();
            const welcomeMessage = `Welcome to Secondary Terminal v${versionInfo.version} (${versionInfo.buildDate}).\r\n`;
            this._sessionManager.addOutput(compositeKey, welcomeMessage);
            this.appendLog(`Shell started for tab: ${tabId}`);
        } else {
            this.appendLog(`Reconnecting to existing session for tab: ${tabId}`);
        }
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                this._extensionContext.extensionUri,
                vscode.Uri.joinPath(this._extensionContext.extensionUri, 'resources')
            ]
        };

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        // この resolve 呼び出しに閉じたリスナー群。ビュー破棄時にまとめて解放する。
        // context.subscriptions に登録すると、ビューの再解決 (サイドバー移動等) のたびに
        // 旧 WebviewView とハンドラが拡張終了まで残留してメモリリークになるため。
        const viewDisposables: vscode.Disposable[] = [];

        viewDisposables.push(webviewView.webview.onDidReceiveMessage(
            (message: WebViewMessage) => {
                // 型ガード関数
                if (!message || typeof message.type !== 'string') {
                    return;
                }

                switch (message.type) {
                    case 'terminalInput':
                        this.handleInputForTab(message.data, message.tabId);
                        break;
                    case 'tabReady':
                        // 新しいタブ対応: タブIDが指定されている場合はそのタブのシェルを起動
                        if (message.tabId) {
                            // タブが登録されていない場合は登録（フロントエンド発のタブ作成）
                            if (!this._tabState.tabs.find(t => t.id === message.tabId)) {
                                const tab: TabInfo = {
                                    id: message.tabId,
                                    title: `Terminal ${this._tabState.nextTabNumber++}`
                                };
                                this._tabState.tabs.push(tab);
                                this._tabState.activeTabId = message.tabId;
                                this.appendLog(`Registered tab from frontend: ${tab.title} (${message.tabId})`);
                            }
                            this.startShellForTab(message.tabId);
                        }
                        break;
                    case 'terminalReady':
                        // 後方互換性: 旧形式のメッセージ（タブなし）
                        this._sessionManager.connectView(this._workspaceKey, webviewView);
                        if (!this._sessionManager.getBuffer(this._workspaceKey)) {
                            const versionInfo = this.getVersionInfo();
                            const welcomeMessage = `Welcome to Secondary Terminal v${versionInfo.version} (${versionInfo.buildDate}).\r\n`;
                            this._sessionManager.addOutput(this._workspaceKey, welcomeMessage);
                            this.appendLog('Terminal ready - starting shell (legacy mode)');
                        } else {
                            this.appendLog('Terminal ready - reconnecting to existing session (legacy mode)');
                        }
                        this.startShell();
                        break;
                    case 'resize':
                        this._terminalCols = message.cols || 80;
                        this._terminalRows = message.rows || 24;
                        // タブIDが指定されている場合はそのタブのプロセスサイズを更新
                        if (message.tabId) {
                            const compositeKey = this.getCompositeKey(message.tabId);
                            this._processManager.updateProcessSize(
                                compositeKey,
                                this._terminalCols,
                                this._terminalRows
                            );
                        } else {
                            // 後方互換性: 旧形式
                            this._processManager.updateProcessSize(
                                this._workspaceKey,
                                this._terminalCols,
                                this._terminalRows
                            );
                        }
                        break;
                    case 'createTab':
                        // 新しいタブを作成
                        {
                            const newTab = this.handleCreateTab();
                            webviewView.webview.postMessage({
                                type: 'tabCreated',
                                tab: newTab
                            });
                        }
                        break;
                    case 'switchTab':
                        // タブを切り替え
                        if (message.tabId) {
                            this.handleSwitchTab(message.tabId);
                        }
                        break;
                    case 'closeTab':
                        // タブを閉じる（最後の1つも閉じれる）
                        if (message.tabId) {
                            this.handleCloseTab(message.tabId);
                        }
                        break;
                    case 'error':
                        console.error('WebView error:', message.error);
                        this.appendLog(`WebView error: ${message.error}`);
                        break;
                    case 'buttonSendSelection':
                        this.handleButtonSendSelection();
                        break;
                    case 'buttonCopySelection':
                        this.handleButtonCopySelection();
                        break;
                    case 'refreshCliAgentStatus':
                        // PTY プロセスに強制的な CLI Agent ステータスチェックを要求
                        this.forceRefreshCliAgentStatus(message);
                        break;
                    case 'bufferCleanupRequest':
                        this.handleBufferCleanupRequest(message);
                        break;
                    case 'terminalInputBegin':
                        this.handleChunkedInputBegin(message);
                        break;
                    case 'terminalInputChunk':
                        this.handleChunkedInputChunk(message);
                        break;
                    case 'terminalInputEnd':
                        this.handleChunkedInputEnd(message);
                        break;
                    case 'editorSendContent':
                        this.handleEditorSendContent(message);
                        break;
                    case 'log':
                        if (message.message) {
                            this.appendLog(message.message);
                        }
                        break;
                    case 'extractToTodos':
                        this.handleExtractToTodos(message);
                        break;
                    case 'openPromptHistory':
                        this.handleOpenPromptHistory();
                        break;
                    case 'pasteImage':
                        vscode.commands.executeCommand('secondaryTerminal.pasteImage');
                        break;
                    case 'openDropZone':
                        vscode.commands.executeCommand('secondaryTerminal.openDropZone');
                        break;
                    case 'openLink':
                        if (message.data && /^https?:\/\//i.test(message.data)) {
                            try {
                                vscode.env.openExternal(vscode.Uri.parse(message.data));
                            } catch (error) {
                                this.appendLog(`Invalid URL ignored: ${message.data}`);
                            }
                        }
                        break;
                    case 'oscNotification':
                        this.handleOscNotification(message);
                        break;
                }
            }
        ));

        // WebView が非表示になってもプロセスは維持する
        viewDisposables.push(webviewView.onDidChangeVisibility(() => {
            if (!webviewView.visible) {
                // WebView is not visible, but keeping shell process alive
            } else {
                // WebView が再び表示された時の処理
                // マルチタブ: 全タブのセッションを再接続
                // retainContextWhenHidden: true により内容は保持されているため、バッファ再送信はスキップ
                for (const tab of this._tabState.tabs) {
                    const compositeKey = this.getCompositeKey(tab.id);
                    this._sessionManager.connectViewWithTabId(compositeKey, webviewView, tab.id, true);
                }

                // HTMLが初期化されていない場合は再設定
                setTimeout(() => {
                    // フロントエンド側の状態確認とリセット用メッセージを送信
                    // マルチタブ: タブリストも送信
                    webviewView.webview.postMessage({
                        type: 'visibility_restored',
                        timestamp: Date.now(),
                        tabs: this._tabState.tabs,
                        activeTabId: this._tabState.activeTabId
                    });
                }, 100);
            }
        }));

        // WebView が破棄されたときはセッションから切断
        webviewView.onDidDispose(() => {
            // マルチタブ: 全タブのセッションを切断
            for (const tab of this._tabState.tabs) {
                const compositeKey = this.getCompositeKey(tab.id);
                this._sessionManager.disconnectView(compositeKey, webviewView);
                this._processManager.deactivateProcess(compositeKey);
            }
            // 後方互換性: 旧形式のセッションも切断
            this._sessionManager.disconnectView(this._workspaceKey, webviewView);
            this._processManager.deactivateProcess(this._workspaceKey);

            // 進行中のチャンクペーストセッションを破棄する (terminalInputEnd はもう届かない)
            this.clearChunkSessions();

            // このビューに紐づくリスナーを解放する
            viewDisposables.forEach(d => {
                try {
                    d.dispose();
                } catch (error) {
                    console.error('Error disposing view listener:', error);
                }
            });
        });
    }

    // 進行中のチャンクペーストセッションを全て破棄する
    private clearChunkSessions(): void {
        for (const session of this._chunkSessions.values()) {
            clearTimeout(session.timeoutTimer);
        }
        this._chunkSessions.clear();
    }

    // タブ指定での入力処理
    private handleInputForTab(data: string | undefined, tabId: string | undefined) {
        if (typeof data !== 'string') {
            return;
        }

        // タブIDがない場合は後方互換性のため旧形式を使用
        const compositeKey = tabId ? this.getCompositeKey(tabId) : this._workspaceKey;

        try {
            // プロセスマネージャー経由でデータを送信
            this._processManager.sendToProcess(compositeKey, data);
        } catch (error) {
            console.error('Failed to send input to process:', error);
            this.appendLog(`Failed to send input to process: ${error}`);
            // エラーをWebViewに通知
            this._view?.webview.postMessage({
                type: 'output',
                tabId: tabId,
                data: `\r\nError: Failed to send input - ${error}\r\n`
            });
        }
    }


    private startShell() {
        // プロセスマネージャーからプロセスを取得または作成
        this._processManager.getOrCreateProcess(
            this._workspaceKey,
            this._extensionContext.extensionPath,
            this._cwd,
            this._terminalCols,
            this._terminalRows
        );
    }


    public clearTerminal() {
        this.appendLog('Clear terminal requested');
        // セッションバッファをクリア
        this._sessionManager.clearBuffer(this._workspaceKey);
        // WebView をクリア
        this._view?.webview.postMessage({ type: 'clear' });
        // プロセスに clear コマンドを送信
        this._processManager.sendToProcess(this._workspaceKey, '\x0C'); // Form Feed (Ctrl+L)
    }

    // glyph atlas 破損による表示崩れを VSCode 再起動なしで復旧する。
    // webview 側で clearTextureAtlas → 失敗時に WebGL アドオンを再構築する。
    public refreshRenderer() {
        this.appendLog('Refresh renderer requested');
        this._view?.webview.postMessage({ type: 'refreshRenderer' });
    }

    public sendTextToTerminal(text: string) {
        if (!text) {
            return;
        }

        try {
            // プロセスマネージャー経由でテキストを送信
            this._processManager.sendToProcess(this._workspaceKey, text);
        } catch (error) {
            console.error('Failed to send text to terminal:', error);
            // エラーをWebViewに通知
            this._view?.webview.postMessage({
                type: 'output',
                data: `\r\nError: Failed to send text - ${error}\r\n`
            });
        }
    }

    public sendTextToEditor(text: string) {
        if (!text) {
            return;
        }

        try {
            // WebView の ACE エディタにテキストを送信
            this._view?.webview.postMessage({
                type: 'sendTextToEditor',
                text: text
            });
        } catch (error) {
            console.error('Failed to send text to editor:', error);
            vscode.window.showErrorMessage(`エディタへの送信に失敗しました: ${error}`);
        }
    }

    public sendTextToEditorIfEmpty(text: string) {
        if (!text) {
            return;
        }

        const handleError = (error: unknown) => {
            console.error('Failed to send text to editor (if empty):', error);
            vscode.window.showErrorMessage(`エディタへの送信に失敗しました: ${error}`);
        };

        try {
            const result = this._view?.webview.postMessage({
                type: 'sendTextToEditorIfEmpty',
                text: text
            });
            Promise.resolve(result).catch(handleError);
        } catch (error) {
            handleError(error);
        }
    }

    private handleButtonSendSelection() {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showWarningMessage('アクティブなエディターがありません');
            return;
        }
        const contextText = createContextTextForSelectedText(editor);

        // ACE エディタにテキストを送信
        if (this._view) {
            this._view.webview.postMessage({
                type: 'sendTextToEditor',
                text: contextText
            });
        }
    }

    private handleButtonCopySelection() {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showWarningMessage('アクティブなエディターがありません');
            return;
        }
        const contextText = createContextTextForSelectedText(editor);
        vscode.env.clipboard.writeText(contextText);
    }

    private handleEditorSendContent(message: WebViewMessage) {
        console.log('[Terminal] Received editorSendContent message:', message);
        if (message.data) {
            console.log('[Terminal] Sending editor content to terminal:', message.data);
            // プロンプト履歴をファイルに記録
            this.appendPromptHistory(message.data);
            // アクティブタブに送信（tabIdがない場合は後方互換性のためactiveTabIdを使用）
            const targetTabId = message.tabId || this._tabState.activeTabId || undefined;
            this.handleInputForTab(message.data, targetTabId);
        } else {
            console.log('[Terminal] No data in editorSendContent message');
        }
    }

    /**
     * プロンプト履歴をファイルに追記する
     */
    private appendPromptHistory(content: string): void {
        const historyPath = '/tmp/secondary-terminal-prompt-history.txt';
        const timestamp = new Date().toISOString();
        const separator = '---';
        const entry = `${separator}\n[${timestamp}] ${this._cwd}\n${content}\n\n`;

        try {
            fs.appendFileSync(historyPath, entry, 'utf8');
            this.appendLog(`Prompt history saved to ${historyPath}`);
        } catch (error) {
            console.error('Failed to save prompt history:', error);
            this.appendLog(`Failed to save prompt history: ${error}`);
        }
    }

    /**
     * プロンプト履歴ファイルを VSCode で開く
     */
    private handleOpenPromptHistory(): void {
        const historyPath = '/tmp/secondary-terminal-prompt-history.txt';

        // ファイルが存在しない場合は作成
        if (!fs.existsSync(historyPath)) {
            fs.writeFileSync(historyPath, '', 'utf8');
        }

        const uri = vscode.Uri.file(historyPath);
        vscode.window.showTextDocument(uri, { preview: false });
    }

    /**
     * ターミナル出力に含まれる OSC 通知シーケンス (OSC 9 / 777 / 99) を
     * VSCode のトースト通知 (通知センターに残る) として表示する。
     * 通知本文は信頼境界の外 (webview) から渡ってくるため、表示直前のここで必ず
     * サニタイズする。webview 側のサニタイズがすり抜けても、最終的にここで効く。
     */
    private handleOscNotification(message: WebViewMessage): void {
        const config = vscode.workspace.getConfiguration('secondaryTerminal');
        // 通知機能が無効なら何もしない (フラッシュもしない)
        if (!config.get<boolean>('notifications.enabled', true)) {
            return;
        }

        const title = this.sanitizeNotificationText(message.title);
        const body = this.sanitizeNotificationText(message.body);
        let text = title && body ? `${title}: ${body}` : title || body;
        if (!text) {
            // 制御文字のみ等で本文が空になった場合は通知しない
            return;
        }
        // 長すぎる通知本文は 100 文字に制限する
        const MAX_LENGTH = 100;
        if (text.length > MAX_LENGTH) {
            text = text.slice(0, MAX_LENGTH) + '…';
        }
        this.appendLog(`OSC notification (OSC ${message.osc ?? '?'}): ${text}`);
        // webview 全面を一瞬フラッシュさせて視覚的にも気づけるようにする (設定で無効化可能)
        if (config.get<boolean>('notifications.flashBackground', true)) {
            this._view?.webview.postMessage({ type: 'flashBackground' });
        }
        vscode.window.showInformationMessage(text);
    }

    /**
     * 通知テキストのサニタイズ。
     * - C0/C1 制御文字と DEL (改行・タブ含む) を除去してトースト 1 行に収める。
     * - 双方向制御文字 (U+202A-202E, U+2066-2069 等) とゼロ幅文字 (U+200B-200F, U+FEFF) も
     *   除去する。これらは通知本文の見た目を実際の文字列と食い違わせる視覚偽装に悪用できるため。
     */
    private sanitizeNotificationText(value: string | undefined): string {
        if (!value || typeof value !== 'string') {
            return '';
        }
        return value
            .replace(/[\x00-\x1f\x7f-\x9f]/g, '')
            .replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '')
            .trim();
    }

    private handleExtractToTodos(message: WebViewMessage) {
        const content = message.data;
        if (!content) {
            this._view?.webview.postMessage({
                type: 'extractToTodosResult',
                success: false,
                tabId: message.tabId,
                error: 'No content provided'
            });
            return;
        }

        // ワークスペースルートを取得
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceRoot) {
            this._view?.webview.postMessage({
                type: 'extractToTodosResult',
                success: false,
                tabId: message.tabId,
                error: 'No workspace folder found'
            });
            return;
        }

        const todosPath = path.join(workspaceRoot, 'TODOS.md');

        // プロンプト履歴に記録
        this.appendPromptHistory(content);

        try {
            // TODOS.md にコンテンツを書き込み（上書き）
            fs.writeFileSync(todosPath, content, 'utf8');
            this.appendLog(`[EXTRACT] Content written to ${todosPath}`);

            // 成功結果を返す (発行元タブに紐づけるため tabId をエコーバックする)
            this._view?.webview.postMessage({
                type: 'extractToTodosResult',
                success: true,
                tabId: message.tabId,
                filePath: todosPath
            });
        } catch (error) {
            console.error('[EXTRACT] Failed to write TODOS.md:', error);
            this.appendLog(`[EXTRACT] Failed to write TODOS.md: ${error}`);

            this._view?.webview.postMessage({
                type: 'extractToTodosResult',
                success: false,
                tabId: message.tabId,
                error: error instanceof Error ? error.message : String(error)
            });
        }
    }

    public async resetTerminal() {
        this.appendLog('Terminal reset requested');

        // 1. 全タブのプロセスとセッションを後始末する。
        //    レガシーキーだけを対象にすると、compositeKey で管理されている実プロセスが
        //    リセットのたびに孤立して蓄積するため、全タブを明示的に終了する。
        const tabs = [...this._tabState.tabs];
        for (const tab of tabs) {
            const compositeKey = this.getCompositeKey(tab.id);
            this._processManager.unregisterExitCallback(compositeKey);
            await this._processManager.terminateProcessAsync(compositeKey);
            this._sessionManager.removeSession(compositeKey);
        }
        this._tabState.tabs = [];
        this._tabState.activeTabId = null;

        // 2. 後方互換性: レガシーキーのプロセス・セッションも後始末する
        await this._processManager.terminateProcessAsync(this._workspaceKey);
        this._sessionManager.removeSession(this._workspaceKey);
        this._view?.webview.postMessage({ type: 'clear' });

        // 3. リセット完了通知（フロント側で完全再初期化→tabReady→startShellForTab。
        //    ウェルカムメッセージは startShellForTab が出力する）
        this._view?.webview.postMessage({ type: 'reset' });

        this.appendLog('Terminal reset completed');
    }

    private forceRefreshCliAgentStatus(message: WebViewMessage) {
        try {
            // PTY プロセスに特別なシーケンスを送信してステータスを強制チェック
            // この処理では、CLI Agent チェック間隔をリセットして即座に実行させる
            // PTY 側では特別な信号やシーケンスを受信する必要があるが、
            // 今回は簡単な方法として、非表示文字を送信することで次回のチェックを促進する
            const refreshSignal = '\x00'; // NULL文字（画面には表示されない）
            // タブ ID が指定されている場合はそのタブの実プロセス (compositeKey) に送る
            const key = message.tabId ? this.getCompositeKey(message.tabId) : this._workspaceKey;
            this._processManager.sendToProcess(key, refreshSignal);
        } catch (error) {
            console.error('Failed to force refresh CLI Agent status:', error);
        }
    }

    private handleBufferCleanupRequest(message: WebViewMessage) {
        try {
            const preserveScrollPosition = message.preserveScrollPosition || false;

            console.log('[BUFFER CLEANUP] Received buffer cleanup request from frontend', {
                currentLines: message.currentLines,
                threshold: message.threshold,
                preserveScrollPosition
            });

            // スクロール位置を保持する場合は、実際のバッファクリアをスキップするかもしれない
            // 現時点では、バッファクリアの頻度を下げるかバッファクリアを実行しない
            if (preserveScrollPosition) {
                console.log('[BUFFER CLEANUP] Scroll position preservation requested, skipping buffer cleanup');

                // スクロール位置を保持したい場合は、バッファクリアを実行しない
                // または、より控えめなクリア処理を実行
                this._view?.webview.postMessage({
                    type: 'bufferCleanupCompleted',
                    success: true,
                    timestamp: Date.now(),
                    message: 'Buffer cleanup skipped to preserve scroll position'
                });
            } else {
                // 通常のバッファクリアを実行
                // タブ ID が指定されている場合はそのタブのセッション (compositeKey) を対象にする
                const key = message.tabId ? this.getCompositeKey(message.tabId) : this._workspaceKey;
                this._sessionManager.trimBufferIfNeeded(key);

                console.log('[BUFFER CLEANUP] Backend buffer cleanup completed');

                this._view?.webview.postMessage({
                    type: 'bufferCleanupCompleted',
                    success: true,
                    timestamp: Date.now(),
                    message: 'Buffer cleanup completed'
                });
            }

        } catch (error) {
            console.error('[BUFFER CLEANUP] Error during backend buffer cleanup:', error);

            // エラーを WebView に通知
            this._view?.webview.postMessage({
                type: 'bufferCleanupCompleted',
                success: false,
                error: error instanceof Error ? error.message : String(error),
                timestamp: Date.now()
            });
        }
    }

    private _getHtmlForWebview(webview: vscode.Webview) {
        const xtermCssUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionContext.extensionUri, 'resources', 'xterm.css'));
        const xtermJsUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionContext.extensionUri, 'resources', 'xterm.js'));

        // アドオンの URI を生成
        const xtermWebglJsUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionContext.extensionUri, 'node_modules', '@xterm', 'addon-webgl', 'lib', 'addon-webgl.js'));
        const xtermUnicode11JsUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionContext.extensionUri, 'node_modules', '@xterm', 'addon-unicode11', 'lib', 'addon-unicode11.js'));
        const xtermSearchJsUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionContext.extensionUri, 'node_modules', '@xterm', 'addon-search', 'lib', 'addon-search.js'));

        // ACE エディタの URI を生成
        const aceJsUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionContext.extensionUri, 'node_modules', 'ace-builds', 'src-min-noconflict', 'ace.js'));
        const aceModeJavaScriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionContext.extensionUri, 'node_modules', 'ace-builds', 'src-min-noconflict', 'mode-javascript.js'));
        const aceModeMarkdownUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionContext.extensionUri, 'node_modules', 'ace-builds', 'src-min-noconflict', 'mode-markdown.js'));
        const aceKeybindingVscodeUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionContext.extensionUri, 'node_modules', 'ace-builds', 'src-min-noconflict', 'keybinding-vscode.js'));

        // HTMLテンプレートファイルを読み込み
        try {
            const htmlTemplatePath = path.join(this._extensionContext.extensionPath, 'resources', 'terminal.html');
            let htmlContent = fs.readFileSync(htmlTemplatePath, 'utf8');

            // VSCode 設定から scrollback 最大行数を取得
            // 設定キー: secondaryTerminal.maxHistoryLines
            const config = vscode.workspace.getConfiguration('secondaryTerminal');
            const maxHistoryLines = Math.max(50, Math.floor(config.get<number>('maxHistoryLines', 1000)));
            const versionInfo = this.getVersionInfo();

            // フォント・レイアウト設定を JSON で webview に注入する
            // JSON 内の "</script>" 等でスクリプトが分断されないよう "<" をエスケープする
            const fontSettingsJson = JSON.stringify(this.getFontSettings())
                .replace(/</g, '\\u003c');

            // プレースホルダーを実際の値に置換
            htmlContent = htmlContent
                .replace(/{{CSP_SOURCE}}/g, webview.cspSource)
                .replace(/{{XTERM_CSS_URI}}/g, xtermCssUri.toString())
                .replace(/{{XTERM_JS_URI}}/g, xtermJsUri.toString())
                .replace(/{{XTERM_WEBGL_JS_URI}}/g, xtermWebglJsUri.toString())
                .replace(/{{XTERM_UNICODE11_JS_URI}}/g, xtermUnicode11JsUri.toString())
                .replace(/{{XTERM_SEARCH_JS_URI}}/g, xtermSearchJsUri.toString())
                .replace(/{{ACE_JS_URI}}/g, aceJsUri.toString())
                .replace(/{{ACE_MODE_JAVASCRIPT_URI}}/g, aceModeJavaScriptUri.toString())
                .replace(/{{ACE_MODE_MARKDOWN_URI}}/g, aceModeMarkdownUri.toString())
                .replace(/{{ACE_KEYBINDING_VSCODE_URI}}/g, aceKeybindingVscodeUri.toString())
                .replace(/{{SCROLLBACK_MAX}}/g, String(maxHistoryLines))
                .replace(/{{FONT_SETTINGS_JSON}}/g, () => fontSettingsJson)
                .replace(/{{VERSION}}/g, versionInfo.version)
                .replace(/{{BUILD_DATE}}/g, versionInfo.buildDate);

            return htmlContent;
        } catch (error) {
            console.error('Failed to load HTML template:', error);
            // フォールバック: エラー時はセキュアなHTMLを返す
            const escapeMap: { [key: string]: string } = {
                '<': '&lt;',
                '>': '&gt;',
                '&': '&amp;',
                '"': '&quot;',
                "'": '&#39;'
            };
            const escapedError = String(error).replace(/[<>&"']/g, (char) => {
                return escapeMap[char] || char;
            });
            return `<!DOCTYPE html>
            <html>
            <head><title>Terminal Error</title></head>
            <body><p style="color: red;">Failed to load terminal template: ${escapedError}</p></body>
            </html>`;
        }
    }

    // バックプレッシャー制御付きの書き込み関数
    private async writeWithBackpressure(processKey: string, data: Buffer): Promise<void> {
        try {
            const success = this._processManager.sendToProcessWithBackpressure(processKey, data);
            if (!success) {
                // バックプレッシャーが発生した場合は drain を待つ
                await this._processManager.waitForDrain(processKey);
            }
        } catch (error) {
            console.error('Failed to write with backpressure:', error);
            throw error;
        }
    }

    // チャンクセッションの無通信タイムアウトを (再) 設定する
    private armChunkSessionTimeout(sessionId: string): NodeJS.Timeout {
        return setTimeout(() => {
            if (this._chunkSessions.delete(sessionId)) {
                console.warn('[CHUNKED INPUT] Session timed out and was discarded:', sessionId);
            }
        }, TerminalProvider.CHUNK_SESSION_TIMEOUT_MS);
    }

    // チャンク入力の書き込み先プロセスキーを決定する
    private getChunkProcessKey(tabId: string | undefined): string {
        const targetTabId = tabId || this._tabState.activeTabId;
        return targetTabId ? this.getCompositeKey(targetTabId) : this._workspaceKey;
    }

    // チャンク入力開始ハンドラー
    private handleChunkedInputBegin(message: WebViewMessage): void {
        if (!message.id) {
            console.error('Missing id in terminalInputBegin message');
            return;
        }

        console.log('[CHUNKED INPUT] Begin session', message.id, 'total bytes:', message.totalBytes);

        // セッション情報を保存
        this._chunkSessions.set(message.id, {
            totalBytes: message.totalBytes || 0,
            receivedBytes: 0,
            kind: message.kind,
            tabId: message.tabId,
            timeoutTimer: this.armChunkSessionTimeout(message.id)
        });

        // 最初の ACK を送信（次のチャンクを要求）
        this._view?.webview.postMessage({
            type: 'terminalInputAck',
            id: message.id
        });
    }

    // チャンク受信ハンドラー
    private async handleChunkedInputChunk(message: WebViewMessage): Promise<void> {
        if (!message.id || !message.b64) {
            console.error('Missing id or b64 in terminalInputChunk message');
            return;
        }

        const session = this._chunkSessions.get(message.id);
        if (!session) {
            console.error('Unknown chunk session:', message.id);
            return;
        }

        try {
            // base64 デコード
            const chunkData = Buffer.from(message.b64, 'base64');
            console.log('[CHUNKED INPUT] Received chunk', message.offset, 'size:', chunkData.length);

            session.receivedBytes += chunkData.length;

            // 受信のたびにタイムアウトを再設定する
            clearTimeout(session.timeoutTimer);
            session.timeoutTimer = this.armChunkSessionTimeout(message.id);

            // バックプレッシャー制御でプロセスに書き込み
            // 実プロセスは compositeKey で管理されているため、発行元タブのキーに書き込む
            await this.writeWithBackpressure(this.getChunkProcessKey(session.tabId), chunkData);

            // ACK を送信（次のチャンクを要求）
            this._view?.webview.postMessage({
                type: 'terminalInputAck',
                id: message.id
            });
        } catch (error) {
            console.error('Error handling chunked input:', error);
            // エラー時はセッションを終了
            clearTimeout(session.timeoutTimer);
            this._chunkSessions.delete(message.id);

            this._view?.webview.postMessage({
                type: 'terminalInputAck',
                id: message.id,
                done: true,
                error: error instanceof Error ? error.message : String(error)
            });
        }
    }

    // チャンク入力終了ハンドラー
    private handleChunkedInputEnd(message: WebViewMessage): void {
        if (!message.id) {
            console.error('Missing id in terminalInputEnd message');
            return;
        }

        const session = this._chunkSessions.get(message.id);
        if (!session) {
            console.error('Unknown chunk session:', message.id);
            return;
        }

        console.log('[CHUNKED INPUT] End session', message.id, 'received bytes:', session.receivedBytes);

        // セッション完了
        clearTimeout(session.timeoutTimer);
        this._chunkSessions.delete(message.id);

        // 完了 ACK を送信
        this._view?.webview.postMessage({
            type: 'terminalInputAck',
            id: message.id,
            done: true
        });
    }


    /**
     * ログを追加する
     * 500項目を超えた場合は300項目に削減する
     */
    private appendLog(message: string): void {
        const timestamp = new Date().toISOString();
        this._logs.push(`[${timestamp}] ${message}`);

        if (this._logs.length > 500) {
            this._logs = this._logs.slice(-300);
        }
    }

    /**
     * ログを表示する WebView パネルを開く
     */
    public showLogs(): void {
        const panel = vscode.window.createWebviewPanel(
            'secondaryTerminalLogs',
            'Secondary Terminal Logs',
            vscode.ViewColumn.One,
            {
                enableScripts: false
            }
        );

        const logsText = this._logs.length > 0
            ? this._logs.join('\n')
            : 'No logs available.';

        panel.webview.html = this._getLogsHtml(logsText);
    }

    /**
     * ログ表示用の HTML を生成
     */
    private _getLogsHtml(logsText: string): string {
        const escapedLogs = logsText
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');

        return `<!DOCTYPE html>
<html lang="ja">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
    <title>Secondary Terminal Logs</title>
    <style>
        body {
            font-family: 'Courier New', Consolas, monospace;
            padding: 10px;
            background-color: var(--vscode-editor-background);
            color: var(--vscode-editor-foreground);
        }
        textarea {
            width: 100%;
            height: calc(100vh - 40px);
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            font-family: 'Courier New', Consolas, monospace;
            font-size: 12px;
            padding: 8px;
            resize: none;
        }
    </style>
</head>
<body>
    <textarea readonly>${escapedLogs}</textarea>
</body>
</html>`;
    }
}
