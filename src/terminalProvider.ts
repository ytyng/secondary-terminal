import * as vscode from 'vscode';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { ShellProcessManager } from './shellProcessManager';
import { TerminalSessionManager } from './terminalSessionManager';
import { createContextTextForSelectedText } from './utils';

export class TerminalProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;
    private _cwd: string;
    private _terminalCols: number = 80;
    private _terminalRows: number = 24;
    private _workspaceKey: string;
    private _processManager = ShellProcessManager.getInstance();
    private _sessionManager = TerminalSessionManager.getInstance();

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
            console.warn('Failed to read version info:', error);
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

        // WebView メッセージの型定義
        interface WebViewMessage {
            type: 'terminalInput' | 'terminalReady' | 'resize' | 'error' | 'buttonSendSelection' | 'buttonCopySelection' | 'buttonReset' | 'buttonResetRequest' | 'refreshCliAgentStatus';
            data?: string;
            cols?: number;
            rows?: number;
            error?: string;
            timestamp?: number;
        }

        webviewView.webview.onDidReceiveMessage(
            (message: WebViewMessage) => {
                console.log('Received message from webview:', message);

                // 型ガード関数
                if (!message || typeof message.type !== 'string') {
                    console.warn('Invalid message received:', message);
                    return;
                }

                switch (message.type) {
                    case 'terminalInput':
                        console.log('Terminal input received:', JSON.stringify(message.data));
                        this.handleInput(message.data);
                        break;
                    case 'terminalReady':
                        console.log('Terminal ready');
                        // セッションに WebView を接続
                        this._sessionManager.connectView(this._workspaceKey, webviewView);
                        // 既存のバッファがない場合のみウェルカムメッセージを表示
                        if (!this._sessionManager.getBuffer(this._workspaceKey)) {
                            const versionInfo = this.getVersionInfo();
                            const welcomeMessage = `Welcome to Secondary Terminal v${versionInfo.version} (${versionInfo.buildDate}).\r\n`;
                            this._sessionManager.addOutput(this._workspaceKey, welcomeMessage);
                        }
                        this.startShell();
                        break;
                    case 'resize':
                        console.log('Terminal resize:', message.cols, 'x', message.rows);
                        this._terminalCols = message.cols || 80;
                        this._terminalRows = message.rows || 24;
                        // プロセスマネージャー経由でサイズ更新
                        this._processManager.updateProcessSize(
                            this._workspaceKey,
                            this._terminalCols,
                            this._terminalRows
                        );
                        break;
                    case 'error':
                        console.error('WebView error:', message.error);
                        break;
                    case 'buttonSendSelection':
                        this.handleButtonSendSelection();
                        break;
                    case 'buttonCopySelection':
                        this.handleButtonCopySelection();
                        break;
                    case 'buttonResetRequest':
                        this.handleResetRequest();
                        break;
                    case 'buttonReset':
                        this.resetTerminal();
                        break;
                    case 'refreshCliAgentStatus':
                        console.log('Received refreshCliAgentStatus request');
                        // PTY プロセスに強制的な CLI Agent ステータスチェックを要求
                        this.forceRefreshCliAgentStatus();
                        break;
                }
            },
            undefined,
            this._extensionContext.subscriptions
        );

        // WebView が非表示になってもプロセスは維持する
        webviewView.onDidChangeVisibility(() => {
            if (!webviewView.visible) {
                console.log('WebView is not visible, but keeping shell process alive');
            } else {
                // WebView が再び表示された時の処理
                console.log('WebView became visible, ensuring proper state');
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
            console.log('WebView disposed, disconnecting from session');
            this._sessionManager.disconnectView(this._workspaceKey, webviewView);
            this._processManager.deactivateProcess(this._workspaceKey);
        }, null, this._extensionContext.subscriptions);
    }

    private handleInput(data: string | undefined) {
        if (typeof data !== 'string') {
            console.warn('Invalid input data received:', data);
            return;
        }

        try {
            // プロセスマネージャー経由でデータを送信
            this._processManager.sendToProcess(this._workspaceKey, data);
        } catch (error) {
            console.error('Failed to send input to process:', error);
            // エラーをWebViewに通知
            this._view?.webview.postMessage({
                type: 'output',
                data: `\r\nError: Failed to send input - ${error}\r\n`
            });
        }
    }


    private startShell() {
        console.log('Connecting to shell process');

        // プロセスマネージャーからプロセスを取得または作成
        this._processManager.getOrCreateProcess(
            this._workspaceKey,
            this._extensionContext.extensionPath,
            this._cwd,
            this._terminalCols,
            this._terminalRows
        );

        console.log('Connected to shell process successfully');
    }


    public clearTerminal() {
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

    private handleButtonSendSelection() {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showWarningMessage('アクティブなエディターがありません');
            return;
        }
        this.sendTextToTerminal(createContextTextForSelectedText(editor));
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

    private async handleResetRequest() {
        const result = await vscode.window.showWarningMessage(
            'ターミナルをリセットしますか？\n実行中のプロセスはすべて終了します。',
            { modal: true },
            'リセット'
        );
        
        if (result === 'リセット') {
            this.resetTerminal();
        }
    }

    public resetTerminal() {
        console.log('Resetting terminal...');
        
        // 1. 既存のプロセスを強制終了
        this._processManager.terminateProcess(this._workspaceKey);
        
        // 2. セッションバッファとビューをクリア
        this._sessionManager.clearBuffer(this._workspaceKey);
        this._view?.webview.postMessage({ type: 'clear' });
        
        // 3. 少し待ってから新しいシェルを起動
        setTimeout(() => {
            // ウェルカムメッセージを表示
            const versionInfo = this.getVersionInfo();
            const welcomeMessage = `Terminal has been reset.\r\nWelcome to Secondary Terminal v${versionInfo.version} (${versionInfo.buildDate}).\r\n`;
            this._sessionManager.addOutput(this._workspaceKey, welcomeMessage);
            
            // 新しいシェルプロセスを開始
            this.startShell();
        }, 500);
    }

    private forceRefreshCliAgentStatus() {
        try {
            console.log('Forcing CLI Agent status refresh');
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

    private _getHtmlForWebview(webview: vscode.Webview) {
        const xtermCssUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionContext.extensionUri, 'resources', 'xterm.css'));
        const xtermJsUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionContext.extensionUri, 'resources', 'xterm.js'));

        // アドオンの URI を生成
        const xtermCanvasJsUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionContext.extensionUri, 'node_modules', '@xterm', 'addon-canvas', 'lib', 'addon-canvas.js'));
        const xtermUnicode11JsUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionContext.extensionUri, 'node_modules', '@xterm', 'addon-unicode11', 'lib', 'addon-unicode11.js'));

        // HTMLテンプレートファイルを読み込み
        try {
            const htmlTemplatePath = path.join(this._extensionContext.extensionPath, 'resources', 'terminal.html');
            let htmlContent = fs.readFileSync(htmlTemplatePath, 'utf8');

            // プレースホルダーを実際の値に置換
            htmlContent = htmlContent
                .replace(/{{CSP_SOURCE}}/g, webview.cspSource)
                .replace(/{{XTERM_CSS_URI}}/g, xtermCssUri.toString())
                .replace(/{{XTERM_JS_URI}}/g, xtermJsUri.toString())
                .replace(/{{XTERM_CANVAS_JS_URI}}/g, xtermCanvasJsUri.toString())
                .replace(/{{XTERM_UNICODE11_JS_URI}}/g, xtermUnicode11JsUri.toString());

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
}
