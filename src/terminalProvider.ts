import * as vscode from 'vscode';
// import * as pty from 'node-pty';

export class TerminalProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;
    // private _ptyProcess?: pty.IPty;

    constructor(private readonly _extensionContext: vscode.ExtensionContext) {}

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

        // モック実装
        /*
        this._ptyProcess = pty.spawn(process.platform === 'win32' ? 'powershell.exe' : 'bash', [], {
            name: 'xterm-color',
            cols: 80,
            rows: 24,
            cwd: vscode.workspace.rootPath || process.cwd(),
            env: process.env
        });

        this._ptyProcess.onData((data) => {
            this._view?.webview.postMessage({
                type: 'output',
                data: data
            });
        });
        */

        webviewView.webview.onDidReceiveMessage(
            message => {
                console.log('Received message from webview:', message);
                switch (message.type) {
                    case 'terminalInput':
                        // モック実装
                        this.handleMockInput(message.data);
                        break;
                    case 'terminalReady':
                        console.log('Terminal ready, sending welcome message');
                        this.sendToTerminal('Welcome to Secondary Terminal!\r\n$ ');
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

    private handleMockInput(input: string) {
        if (input === '\r') {
            this.sendToTerminal('\r\n$ ');
        } else {
            this.sendToTerminal(input);
        }
    }

    public clearTerminal() {
        // モック実装
        this._view?.webview.postMessage({ type: 'clear' });
    }

    private sendToTerminal(text: string) {
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
                body {
                    margin: 0;
                    padding: 8px;
                    background-color: var(--vscode-editor-background);
                    color: var(--vscode-editor-foreground);
                    font-family: var(--vscode-editor-font-family);
                    overflow: hidden;
                }
                #terminal {
                    width: 100%;
                    height: calc(100vh - 16px);
                }
                .terminal-container {
                    height: 100%;
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
                        background: 'transparent',
                        foreground: 'var(--vscode-terminal-foreground)',
                        cursor: 'var(--vscode-terminal-cursor-foreground)',
                        selection: 'var(--vscode-terminal-selection-background)'
                    },
                    fontFamily: 'var(--vscode-editor-font-family)',
                    fontSize: 14,
                    rows: 24,
                    cols: 80,
                    cursorBlink: true
                });
                
                term.open(document.getElementById('terminal'));
                
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
                    term.fit();
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