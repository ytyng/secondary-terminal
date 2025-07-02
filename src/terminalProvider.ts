import * as vscode from 'vscode';
import * as os from 'os';
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
                            this._sessionManager.addOutput(this._workspaceKey, 'Welcome to Secondary Terminal!\r\n');
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

    private showPrompt() {
        // Python PTY を使用している場合はプロンプト表示不要
        // （PTY 自体がプロンプトを表示する）
    }
    
    private wrapLines(text: string): string {
        const lines = text.split('\r\n');
        const wrappedLines: string[] = [];
        
        for (const line of lines) {
            if (line.length <= this._terminalCols) {
                wrappedLines.push(line);
            } else {
                // 長い行を端末幅で折り返し
                for (let i = 0; i < line.length; i += this._terminalCols) {
                    wrappedLines.push(line.substring(i, i + this._terminalCols));
                }
            }
        }
        
        return wrappedLines.join('\r\n');
    }

    private terminateShell() {
        // 個別のターミナルビューでは終了処理を行わない
        // プロセスはグローバルに管理される
        console.log('TerminalProvider terminateShell called, but process is managed globally');
    }

    public clearTerminal() {
        // セッションバッファをクリア
        this._sessionManager.clearBuffer(this._workspaceKey);
        // WebView をクリア
        this._view?.webview.postMessage({ type: 'clear' });
        // プロセスに clear コマンドを送信
        this._processManager.sendToProcess(this._workspaceKey, '\x0C'); // Form Feed (Ctrl+L)
    }

    private sendToTerminal(text: string) {
        console.log('Sending to terminal:', JSON.stringify(text));
        // セッションマネージャーを経由して出力を管理
        this._sessionManager.addOutput(this._workspaceKey, text);
    }

    private _getHtmlForWebview(webview: vscode.Webview) {
        const xtermCssUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionContext.extensionUri, 'resources', 'xterm.css'));
        const xtermJsUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionContext.extensionUri, 'resources', 'xterm.js'));
        
        return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource} 'unsafe-inline';">
            <title>Secondary Terminal</title>
            <link rel="stylesheet" href="${xtermCssUri}" />
            <style>
                * {
                    margin: 0;
                    padding: 0;
                    box-sizing: border-box;
                }
                html {
                    height: 100%;
                    overflow: hidden;
                    padding: 0;
                    margin: 0;
                }
                body {
                    width: 100%;
                    height: 100vh;
                    padding: 0;
                    margin: 0;
                    background-color: var(--vscode-sideBar-background);
                    color: var(--vscode-editor-foreground);
                    font-family: "RobotoMono Nerd Font Mono", "Roboto Mono", Consolas, "Courier New", monospace;
                    overflow: hidden;
                    display: flex;
                    flex-direction: column;
                }
                
                .terminal-container {
                    flex: 1;
                    width: 100%;
                    height: 100%;
                    min-height: 0;
                    display: flex;
                    flex-direction: column;
                }
                
                #terminal {
                    flex: 1;
                    width: 100%;
                    height: 100%;
                }
                .terminal.xterm {
                    padding: 5px 0 0 5px;
                }
                
                /* xterm.js のコンテナを透明に */
                .xterm .xterm-viewport {
                    background-color: transparent !important;
                }
                
                .xterm .xterm-screen {
                    background-color: transparent !important;
                }
                
                .xterm .xterm-helper-textarea {
                    background-color: transparent !important;
                }
            </style>
        </head>
        <body>
            <div class="terminal-container">
                <div id="terminal"></div>
            </div>
            
            <script src="${xtermJsUri}"></script>
            <script>
                const vscode = acquireVsCodeApi();
                
                try {
                    console.log('Initializing terminal...');
                    
                    if (typeof Terminal === 'undefined') {
                        throw new Error('Terminal is not defined. xterm.js may not have loaded.');
                    }
                    
                    const term = new Terminal({
                    theme: {
                        background: 'transparent',
                        foreground: 'var(--vscode-terminal-foreground)',
                        cursor: 'var(--vscode-terminal-cursor-foreground)',
                        selection: 'var(--vscode-terminal-selection-background)'
                    },
                    fontFamily: 'var(--vscode-terminal-font-family), "RobotoMono Nerd Font", "Roboto Mono", Consolas, "Courier New", monospace',
                    fontSize: 13,
                    letterSpacing: '-2px',
                    lineHeight: 22 / 13, // 22px ÷ 13px = 約1.69
                    cursorBlink: true,
                    convertEol: true,
                    allowProposedApi: true
                });
                
                term.open(document.getElementById('terminal'));
                
                // ターミナルサイズを動的に設定
                function setTerminalSize() {
                    const container = document.querySelector('.terminal-container');
                    const terminal = document.getElementById('terminal');
                    
                    if (!container || !terminal) {
                        console.warn('Terminal container not found');
                        return;
                    }
                    
                    // コンテナの実際のサイズを取得
                    const containerRect = container.getBoundingClientRect();
                    const availableWidth = Math.max(containerRect.width - 10, 300); // パディング考慮
                    const availableHeight = Math.max(containerRect.height - 10, 200); // パディング考慮
                    
                    console.log('Container size:', availableWidth, 'x', availableHeight);

                    // フォント情報から文字サイズを正確に計算
                    const fontSize = 13;
                    const lineHeight = 20;
                    
                    // 一時的な測定用エレメントを作成して文字幅を正確に測定
                    const measurer = document.createElement('div');
                    measurer.style.position = 'absolute';
                    measurer.style.visibility = 'hidden';
                    measurer.style.fontFamily = 'var(--vscode-terminal-font-family), "RobotoMono Nerd Font", "Roboto Mono", Consolas, "Courier New", monospace';
                    measurer.style.fontSize = fontSize + 'px';
                    measurer.style.lineHeight = lineHeight + 'px';
                    measurer.style.whiteSpace = 'pre';
                    measurer.textContent = 'M'.repeat(10); // 等幅フォントのM文字で測定
                    
                    document.body.appendChild(measurer);
                    const charWidth = measurer.getBoundingClientRect().width / 10;
                    const actualLineHeight = measurer.getBoundingClientRect().height;
                    document.body.removeChild(measurer);
                    
                    // 列数と行数を計算
                    const cols = Math.floor(availableWidth / charWidth);
                    const rows = Math.floor(availableHeight / actualLineHeight);
                    
                    console.log('Font metrics - charWidth:', charWidth, 'lineHeight:', actualLineHeight);
                    console.log('Calculated terminal size:', cols, 'x', rows);
                    
                    // 最小サイズを保証
                    const finalCols = Math.max(cols, 20);
                    const finalRows = Math.max(rows, 5);
                    
                    // ターミナルサイズを設定
                    if (term.cols !== finalCols || term.rows !== finalRows) {
                        term.resize(finalCols, finalRows);
                        
                        // サイズ変更を VSCode に通知
                        vscode.postMessage({ 
                            type: 'resize', 
                            cols: finalCols, 
                            rows: finalRows 
                        });
                        
                        console.log('Terminal resized to:', finalCols, 'x', finalRows);
                    }
                }
                
                // 初期サイズ設定
                setTimeout(setTerminalSize, 100);
                
                // ウィンドウリサイズ時の処理
                window.addEventListener('resize', () => {
                    setTimeout(setTerminalSize, 50);
                });
                
                // ResizeObserver でコンテナサイズ変更を監視
                const resizeObserver = new ResizeObserver((entries) => {
                    for (const entry of entries) {
                        console.log('Container resized:', entry.contentRect.width, 'x', entry.contentRect.height);
                        setTimeout(setTerminalSize, 50);
                    }
                });
                
                // terminal-container を監視
                const container = document.querySelector('.terminal-container');
                if (container) {
                    resizeObserver.observe(container);
                }
                
                // 定期的なサイズチェック（VSCode の制約対応）
                setInterval(setTerminalSize, 2000);
                
                let currentInput = '';
                let claudeCodeActive = false; // Claude Code のアクティブ状態
                
                // ステータスメッセージの処理
                function handleStatusMessage(data) {
                    try {
                        // CSI シーケンス ]777; で始まるメッセージを処理
                        if (data.includes('\\x1b]777;')) {
                            const match = data.match(/\\x1b\\]777;(.+?)\\x07/);
                            if (match) {
                                const messageJson = match[1];
                                const message = JSON.parse(messageJson);
                                
                                if (message.type === 'claude_status') {
                                    claudeCodeActive = message.data.active;
                                    console.log('Claude Code active status changed:', claudeCodeActive);
                                }
                            }
                        }
                    } catch (error) {
                        // JSON パースエラーは無視
                    }
                }
                
                // Shift + Enter を Alt + Enter に変換するキーハンドラー
                try {
                    if (typeof term.attachCustomKeyEventHandler === 'function') {
                        console.log('Setting up custom key handler for Shift+Enter');
                        
                        term.attachCustomKeyEventHandler(function(event) {
                            // Shift + Enter の場合（claude code が動作中のときのみ）
                            if (event.type === 'keydown' && 
                                event.key === 'Enter' && 
                                event.shiftKey && 
                                !event.ctrlKey && 
                                !event.altKey && 
                                !event.metaKey) {
                                
                                // Claude Code がアクティブの場合のみ Alt+Enter に変換
                                if (claudeCodeActive) {
                                    console.log('Shift+Enter detected (Claude Code active), sending Alt+Enter sequence');
                                    
                                    // Alt + Enter のエスケープシーケンス (ESC のみ) を送信
                                    // String.fromCharCode() を使って安全にエンコード
                                    var altEnterSequence = String.fromCharCode(27);
                                    
                                    vscode.postMessage({
                                        type: 'terminalInput',
                                        data: altEnterSequence
                                    });
                                    
                                    // false を返してデフォルト処理を停止（xterm.js では false が停止、true が継続）
                                    return false;
                                } else {
                                    // Claude Code がアクティブでない場合は通常の Enter として処理
                                    console.log('Shift+Enter detected (Claude Code not active), processing as normal Enter');
                                    return true;
                                }
                            }
                            
                            // その他のキーはデフォルト処理を継続
                            return true;
                        });
                        
                        console.log('Custom key handler attached successfully');
                    } else {
                        console.warn('attachCustomKeyEventHandler is not available');
                    }
                } catch (error) {
                    console.error('Failed to attach custom key handler:', error);
                }
                
                term.onData((data) => {
                    vscode.postMessage({
                        type: 'terminalInput',
                        data: data
                    });
                });
                
                window.addEventListener('message', event => {
                    const message = event.data;
                    switch (message.type) {
                        case 'output':
                            // ステータスメッセージをチェック
                            handleStatusMessage(message.data);
                            // 通常の出力として書き込み
                            term.write(message.data);
                            break;
                        case 'clear':
                            term.clear();
                            break;
                    }
                });
                
                vscode.postMessage({ type: 'terminalReady' });
                
                console.log('Terminal initialized successfully');
                
                } catch (error) {
                    console.error('Error initializing terminal:', error);
                    vscode.postMessage({ type: 'error', error: error.message });
                    document.getElementById('terminal').innerHTML = '<p style="color: red;">Error loading terminal: ' + error.message + '</p>';
                }
            </script>
        </body>
        </html>`;
    }
}