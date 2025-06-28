import * as vscode from 'vscode';
import * as child_process from 'child_process';
import * as os from 'os';

export class TerminalProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;
    private _shellProcess?: child_process.ChildProcess;
    private _currentInput: string = '';
    private _cwd: string;
    private _terminalCols: number = 80;
    private _terminalRows: number = 24;

    constructor(private readonly _extensionContext: vscode.ExtensionContext) {
        this._cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || os.homedir();
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
                        this.sendToTerminal('Welcome to Secondary Terminal!\r\n');
                        this.showPrompt();
                        break;
                    case 'resize':
                        console.log('Terminal resize:', message.cols, 'x', message.rows);
                        this._terminalCols = message.cols || 80;
                        this._terminalRows = message.rows || 24;
                        break;
                    case 'error':
                        console.error('WebView error:', message.error);
                        break;
                }
            },
            undefined,
            this._extensionContext.subscriptions
        );
    }

    private handleInput(data: string) {
        if (data === '\r') {
            // Enter が押された - コマンドを実行
            this.sendToTerminal('\r\n');
            if (this._currentInput.trim()) {
                this.executeCommand(this._currentInput.trim());
            } else {
                this.showPrompt();
            }
            this._currentInput = '';
        } else if (data === '\u007f') {
            // Backspace
            if (this._currentInput.length > 0) {
                this._currentInput = this._currentInput.slice(0, -1);
                this.sendToTerminal('\b \b');
            }
        } else {
            // 通常の文字入力
            this._currentInput += data;
            this.sendToTerminal(data);
        }
    }

    private executeCommand(command: string) {
        console.log('Executing command:', command);
        
        // cd コマンドの特別処理
        if (command.startsWith('cd ')) {
            const newPath = command.substring(3).trim();
            this.changeDirectory(newPath);
            return;
        }
        
        // pwd コマンドの特別処理
        if (command === 'pwd') {
            this.sendToTerminal(this._cwd + '\r\n');
            this.showPrompt();
            return;
        }
        
        // その他のコマンドを実行
        child_process.exec(command, {
            cwd: this._cwd,
            env: process.env
        }, (error, stdout, stderr) => {
            if (error) {
                this.sendToTerminal(`Error: ${error.message}\r\n`);
            } else {
                if (stdout) {
                    // Unix の \n を \r\n に変換
                    let output = stdout.replace(/\n/g, '\r\n');
                    // 長い行を端末幅に合わせて折り返し
                    output = this.wrapLines(output);
                    this.sendToTerminal(output);
                }
                if (stderr) {
                    // Unix の \n を \r\n に変換
                    const output = stderr.replace(/\n/g, '\r\n');
                    this.sendToTerminal(output);
                }
            }
            this.showPrompt();
        });
    }
    
    private changeDirectory(path: string) {
        const newPath = path.startsWith('/') ? path : require('path').join(this._cwd, path);
        try {
            process.chdir(newPath);
            this._cwd = process.cwd();
            this.sendToTerminal('');
        } catch (error) {
            this.sendToTerminal(`cd: ${path}: No such file or directory\r\n`);
        }
        this.showPrompt();
    }
    
    private showPrompt() {
        const prompt = `${this._cwd} $ `;
        this.sendToTerminal(prompt);
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

    public clearTerminal() {
        this._view?.webview.postMessage({ type: 'clear' });
        this.showPrompt();
    }

    private sendToTerminal(text: string) {
        console.log('Sending to terminal:', JSON.stringify(text));
        this._view?.webview.postMessage({ 
            type: 'output', 
            data: text 
        });
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
                    height: 100%;
                    min-height: 100vh;
                    padding: 5px 0 0 5px;
                    margin: 0;
                    /*background-color: var(--vscode-editor-background);*/
                    background-color: #222;
                    color: var(--vscode-editor-foreground);
                    /* font-family: var(--vscode-terminal-font-family), "RobotoMono Nerd Font", "Roboto Mono", Consolas, "Courier New", monospace; */
                    font-family: "RobotoMono Nerd Font Mono", "Roboto Mono", Consolas, "Courier New", monospace;
                    overflow: hidden;
                    display: flex;
                    flex-direction: column;
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
                        // background: 'transparent',
                        background: '#111',
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
                
                // 動的に高さを設定
                function setTerminalSize() {
                    const container = document.querySelector('.terminal-container');
                    const terminal = document.getElementById('terminal');
                    
                    // WebView の実際の高さを取得
                    const viewportHeight = Math.max(window.innerHeight, 400);
                    const viewportWidth = window.innerWidth;
                    
                    console.log('Viewport size:', viewportWidth, 'x', viewportHeight);

                    // xterm.js のサイズを手動で計算して設定
                    setTimeout(() => {
                        // フォントサイズとマージンを考慮してサイズを計算
                        const fontSize = 13;
                        // const lineHeight = 20; // 20px
                        const lineHeight = 20;
                        // const charWidth = Math.floor(fontSize * 0.6); // 一般的な等幅フォントの幅
                        // 小さくするほど左右幅は大きくなる
                        const charWidth = Math.floor(fontSize * 0.65);
                        
                        // 利用可能な幅と高さを計算
                        const availableWidth = viewportWidth - 5; // マージン考慮
                        const availableHeight = viewportHeight - 5; // マージン考慮
                        
                        // 列数と行数を計算
                        const cols = Math.floor(availableWidth / charWidth);
                        const rows = Math.floor(availableHeight / lineHeight);
                        
                        console.log('Calculated terminal size:', cols, 'x', rows, 'font:', fontSize, 'px');
                        
                        // ターミナルサイズを明示的に設定
                        term.resize(Math.max(cols, 20), Math.max(rows, 5));
                        
                        // その後 fit() を実行
                        term.fit();
                        
                        // サイズ情報を送信
                        vscode.postMessage({ 
                            type: 'resize', 
                            cols: term.cols, 
                            rows: term.rows 
                        });
                        
                        console.log('Final terminal size:', term.cols, 'x', term.rows);
                    }, 100);
                }
                
                // 初期サイズ設定
                setTimeout(setTerminalSize, 100);
                
                // ウィンドウリサイズ時も再設定
                window.addEventListener('resize', setTerminalSize);
                
                // 定期的にサイズをチェック（VSCode の制約回避）
                setInterval(() => {
                    const currentHeight = parseInt(document.getElementById('terminal').style.height);
                    const expectedHeight = Math.max(window.innerHeight, 400);
                    
                    if (Math.abs(currentHeight - expectedHeight) > 10) {
                        console.log('Height mismatch detected, resizing...', currentHeight, '->', expectedHeight);
                        setTerminalSize();
                    }
                }, 1000);
                
                let currentInput = '';
                
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
                            term.write(message.data);
                            break;
                        case 'clear':
                            term.clear();
                            break;
                    }
                });
                
                vscode.postMessage({ type: 'terminalReady' });
                
                const resizeObserver = new ResizeObserver(() => {
                    setTerminalSize();
                });
                resizeObserver.observe(document.getElementById('terminal'));
                
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