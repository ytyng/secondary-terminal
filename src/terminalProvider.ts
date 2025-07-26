import * as vscode from 'vscode';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { ShellProcessManager } from './shellProcessManager';
import { TerminalSessionManager } from './terminalSessionManager';

export class TerminalProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;
    private _currentInput: string = '';
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
                buildDate: versionData.buildDate || 'Unknown'
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
        context: vscode.WebviewViewResolveContext,
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
            message => {
                console.log('Received message from webview:', message);
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
                }
            },
            undefined,
            this._extensionContext.subscriptions
        );

        // WebView が非表示になってもプロセスは維持する
        webviewView.onDidChangeVisibility(() => {
            if (!webviewView.visible) {
                console.log('WebView is not visible, but keeping shell process alive');
            }
        });

        // WebView が破棄されたときはセッションから切断
        webviewView.onDidDispose(() => {
            console.log('WebView disposed, disconnecting from session');
            this._sessionManager.disconnectView(this._workspaceKey, webviewView);
            this._processManager.deactivateProcess(this._workspaceKey);
        }, null, this._extensionContext.subscriptions);
    }

    private handleInput(data: string) {
        // プロセスマネージャー経由でデータを送信
        this._processManager.sendToProcess(this._workspaceKey, data);
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


    private _getHtmlForWebview(webview: vscode.Webview) {
        const xtermCssUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionContext.extensionUri, 'resources', 'xterm.css'));
        const xtermJsUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionContext.extensionUri, 'resources', 'xterm.js'));
        
        // Canvas アドオンの URI を生成
        const xtermCanvasJsUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionContext.extensionUri, 'node_modules', '@xterm', 'addon-canvas', 'lib', 'addon-canvas.js'));

        // HTMLテンプレートファイルを読み込み
        try {
            const htmlTemplatePath = path.join(this._extensionContext.extensionPath, 'resources', 'terminal.html');
            let htmlContent = fs.readFileSync(htmlTemplatePath, 'utf8');

            // プレースホルダーを実際の値に置換（Canvas アドオン追加）
            htmlContent = htmlContent
                .replace(/{{CSP_SOURCE}}/g, webview.cspSource)
                .replace(/{{XTERM_CSS_URI}}/g, xtermCssUri.toString())
                .replace(/{{XTERM_JS_URI}}/g, xtermJsUri.toString())
                .replace(/{{XTERM_CANVAS_JS_URI}}/g, xtermCanvasJsUri.toString());

            return htmlContent;
        } catch (error) {
            console.error('Failed to load HTML template:', error);
            // フォールバック: エラー時はシンプルなHTMLを返す
            return `<!DOCTYPE html>
            <html>
            <head><title>Terminal Error</title></head>
            <body><p style="color: red;">Failed to load terminal template: ${error}</p></body>
            </html>`;
        }
    }
}
