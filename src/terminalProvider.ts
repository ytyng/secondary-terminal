import * as vscode from 'vscode';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { ShellProcessManager } from './shellProcessManager';
import { TerminalSessionManager } from './terminalSessionManager';
import { createContextTextForSelectedText } from './utils';

// WebView メッセージの型定義
interface WebViewMessage {
    type: 'terminalInput' | 'terminalReady' | 'resize' | 'error' | 'buttonSendSelection' | 'buttonCopySelection' | 'refreshCliAgentStatus' | 'bufferCleanupRequest' | 'terminalInputBegin' | 'terminalInputChunk' | 'terminalInputEnd' | 'editorSendContent' | 'getEnv' | 'log' | 'extractToTodos' | 'openPromptHistory';
    data?: string;
    cols?: number;
    rows?: number;
    error?: string;
    message?: string;
    timestamp?: number;
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
    // Environment variable properties
    name?: string;
}

export class TerminalProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;
    private _cwd: string;
    private _terminalCols: number = 80;
    private _terminalRows: number = 24;
    private _workspaceKey: string;
    private _processManager = ShellProcessManager.getInstance();
    private _sessionManager = TerminalSessionManager.getInstance();

    // チャンクペースト用の状態管理
    private _chunkSessions: Map<string, {
        buffer: Buffer[];
        totalBytes: number;
        receivedBytes: number;
        kind?: string | undefined;
    }> = new Map();

    // ログ管理
    private _logs: string[] = [];

    constructor(private readonly _extensionContext: vscode.ExtensionContext) {
        this._cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || os.homedir();
        // ワークスペースキーはワークスペースフォルダのパスまたはホームディレクトリを使用
        this._workspaceKey = this._cwd;
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

        webviewView.webview.onDidReceiveMessage(
            (message: WebViewMessage) => {
                // 型ガード関数
                if (!message || typeof message.type !== 'string') {
                    return;
                }

                switch (message.type) {
                    case 'terminalInput':
                        this.handleInput(message.data);
                        break;
                    case 'terminalReady':
                        // セッションに WebView を接続
                        this._sessionManager.connectView(this._workspaceKey, webviewView);
                        // 既存のバッファがない場合のみウェルカムメッセージを表示
                        if (!this._sessionManager.getBuffer(this._workspaceKey)) {
                            const versionInfo = this.getVersionInfo();
                            const welcomeMessage = `Welcome to Secondary Terminal v${versionInfo.version} (${versionInfo.buildDate}).\r\n`;
                            this._sessionManager.addOutput(this._workspaceKey, welcomeMessage);
                            this.appendLog('Terminal ready - starting shell');
                        } else {
                            this.appendLog('Terminal ready - reconnecting to existing session');
                        }
                        this.startShell();
                        break;
                    case 'resize':
                        this._terminalCols = message.cols || 80;
                        this._terminalRows = message.rows || 24;
                        // プロセスマネージャー経由でサイズ更新
                        this._processManager.updateProcessSize(
                            this._workspaceKey,
                            this._terminalCols,
                            this._terminalRows
                        );
                        break;
                    case 'getEnv':
                        // 環境変数を取得して WebView に返す
                        if (message.name && typeof message.name === 'string') {
                            const envValue = process.env[message.name];
                            webviewView.webview.postMessage({
                                type: 'envValue',
                                name: message.name,
                                value: envValue || null
                            });
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
                        this.forceRefreshCliAgentStatus();
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
                }
            },
            undefined,
            this._extensionContext.subscriptions
        );

        // WebView が非表示になってもプロセスは維持する
        webviewView.onDidChangeVisibility(() => {
            if (!webviewView.visible) {
                // WebView is not visible, but keeping shell process alive
            } else {
                // WebView が再び表示された時の処理
                // セッションを再接続（既に接続されている場合は何もしない）
                this._sessionManager.connectView(this._workspaceKey, webviewView);

                // HTMLが初期化されていない場合は再設定
                setTimeout(() => {
                    // フロントエンド側の状態確認とリセット用メッセージを送信
                    webviewView.webview.postMessage({
                        type: 'visibility_restored',
                        timestamp: Date.now()
                    });
                }, 100);
            }
        });

        // WebView が破棄されたときはセッションから切断
        webviewView.onDidDispose(() => {
            this._sessionManager.disconnectView(this._workspaceKey, webviewView);
            this._processManager.deactivateProcess(this._workspaceKey);
        }, null, this._extensionContext.subscriptions);
    }

    private handleInput(data: string | undefined) {
        if (typeof data !== 'string') {
            return;
        }

        try {
            // プロセスマネージャー経由でデータを送信
            this._processManager.sendToProcess(this._workspaceKey, data);
        } catch (error) {
            console.error('Failed to send input to process:', error);
            this.appendLog(`Failed to send input to process: ${error}`);
            // エラーをWebViewに通知
            this._view?.webview.postMessage({
                type: 'output',
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
            this.handleInput(message.data);
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

    private handleExtractToTodos(message: WebViewMessage) {
        const content = message.data;
        if (!content) {
            this._view?.webview.postMessage({
                type: 'extractToTodosResult',
                success: false,
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

            // 成功結果を返す
            this._view?.webview.postMessage({
                type: 'extractToTodosResult',
                success: true,
                filePath: todosPath
            });
        } catch (error) {
            console.error('[EXTRACT] Failed to write TODOS.md:', error);
            this.appendLog(`[EXTRACT] Failed to write TODOS.md: ${error}`);

            this._view?.webview.postMessage({
                type: 'extractToTodosResult',
                success: false,
                error: error instanceof Error ? error.message : String(error)
            });
        }
    }

    public async resetTerminal() {
        this.appendLog('Terminal reset requested');

        // 1. 既存のプロセスを明示的に終了完了まで待つ
        await this._processManager.terminateProcessAsync(this._workspaceKey);

        // 2. セッションバッファとビューをクリア
        this._sessionManager.clearBuffer(this._workspaceKey);
        this._view?.webview.postMessage({ type: 'clear' });

        // 3. リセット完了通知（フロント側で完全再初期化→terminalReady→startShell）
        this._view?.webview.postMessage({ type: 'reset' });

        // 4. ウェルカムメッセージ（再初期化後に出力される）
        const versionInfo = this.getVersionInfo();
        const welcomeMessage = `Terminal has been reset.\r\nWelcome to Secondary Terminal v${versionInfo.version} (${versionInfo.buildDate}).\r\n`;
        this._sessionManager.addOutput(this._workspaceKey, welcomeMessage);

        this.appendLog('Terminal reset completed');
    }

    private forceRefreshCliAgentStatus() {
        try {
            // PTY プロセスに特別なシーケンスを送信してステータスを強制チェック
            // この処理では、CLI Agent チェック間隔をリセットして即座に実行させる
            // PTY 側では特別な信号やシーケンスを受信する必要があるが、
            // 今回は簡単な方法として、非表示文字を送信することで次回のチェックを促進する
            const refreshSignal = '\x00'; // NULL文字（画面には表示されない）
            this._processManager.sendToProcess(this._workspaceKey, refreshSignal);
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
                this._sessionManager.trimBufferIfNeeded(this._workspaceKey);

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
            // const config = vscode.workspace.getConfiguration('secondaryTerminal');
            // const maxHistoryLines = Math.max(50, Math.floor(config.get('maxHistoryLines', 1000)));
            const maxHistoryLines = 1000;

            // プレースホルダーを実際の値に置換
            htmlContent = htmlContent
                .replace(/{{CSP_SOURCE}}/g, webview.cspSource)
                .replace(/{{XTERM_CSS_URI}}/g, xtermCssUri.toString())
                .replace(/{{XTERM_JS_URI}}/g, xtermJsUri.toString())
                .replace(/{{XTERM_WEBGL_JS_URI}}/g, xtermWebglJsUri.toString())
                .replace(/{{XTERM_UNICODE11_JS_URI}}/g, xtermUnicode11JsUri.toString())
                .replace(/{{ACE_JS_URI}}/g, aceJsUri.toString())
                .replace(/{{ACE_MODE_JAVASCRIPT_URI}}/g, aceModeJavaScriptUri.toString())
                .replace(/{{ACE_MODE_MARKDOWN_URI}}/g, aceModeMarkdownUri.toString())
                .replace(/{{ACE_KEYBINDING_VSCODE_URI}}/g, aceKeybindingVscodeUri.toString())
                .replace(/{{SCROLLBACK_MAX}}/g, String(maxHistoryLines));

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
    private async writeWithBackpressure(data: Buffer): Promise<void> {
        try {
            const success = this._processManager.sendToProcessWithBackpressure(this._workspaceKey, data);
            if (!success) {
                // バックプレッシャーが発生した場合は drain を待つ
                await this._processManager.waitForDrain(this._workspaceKey);
            }
        } catch (error) {
            console.error('Failed to write with backpressure:', error);
            throw error;
        }
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
            buffer: [],
            totalBytes: message.totalBytes || 0,
            receivedBytes: 0,
            kind: message.kind
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

            // セッションに追加
            session.buffer.push(chunkData);
            session.receivedBytes += chunkData.length;

            // バックプレッシャー制御でプロセスに書き込み
            await this.writeWithBackpressure(chunkData);

            // ACK を送信（次のチャンクを要求）
            this._view?.webview.postMessage({
                type: 'terminalInputAck',
                id: message.id
            });
        } catch (error) {
            console.error('Error handling chunked input:', error);
            // エラー時はセッションを終了
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
