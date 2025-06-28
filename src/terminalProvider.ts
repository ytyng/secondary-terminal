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
                        this.startPersistentShell();
                        break;
                    case 'resize':
                        console.log('Terminal resize:', message.cols, 'x', message.rows);
                        this._terminalCols = message.cols || 80;
                        this._terminalRows = message.rows || 24;
                        // Python PTY にサイズ情報を送信
                        if (this._shellProcess && this._shellProcess.stdin) {
                            // SIGWINCH シグナルを送信してターミナルサイズ変更を通知
                            const resizeSeq = `\x1b[8;${this._terminalRows};${this._terminalCols}t`;
                            this._shellProcess.stdin.write(resizeSeq, 'utf8');
                        }
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
        // Python PTY に直接入力を送信（UTF-8エンコーディング）
        if (this._shellProcess && this._shellProcess.stdin) {
            this._shellProcess.stdin.write(data, 'utf8');
        }
    }

    
    private startPersistentShell() {
        if (this._shellProcess) {
            return; // 既に起動済み
        }
        
        console.log('Starting persistent shell with advanced Python PTY');
        
        // Node.js から制御する Python PTY
        const pythonScript = `
import pty
import os
import sys
import subprocess
import signal
import struct
import select
import time

def set_winsize(fd, rows, cols):
    """ターミナルサイズを設定"""
    try:
        import termios
        winsize = struct.pack('HHHH', rows, cols, 0, 0)
        import fcntl
        fcntl.ioctl(fd, termios.TIOCSWINSZ, winsize)
    except (ImportError, OSError):
        pass

def main():
    # 環境変数を設定
    os.environ['TERM'] = 'xterm-256color'
    os.environ['COLUMNS'] = str(${this._terminalCols})
    os.environ['LINES'] = str(${this._terminalRows})
    
    # PTY を作成
    master, slave = pty.openpty()
    
    # ターミナルサイズを設定
    set_winsize(master, ${this._terminalRows}, ${this._terminalCols})
    set_winsize(slave, ${this._terminalRows}, ${this._terminalCols})
    
    # シェルプロセスを起動
    shell_cmd = [os.environ.get('SHELL', '/bin/zsh'), '-l', '-i']
    try:
        p = subprocess.Popen(
            shell_cmd,
            stdin=slave,
            stdout=slave,
            stderr=slave,
            preexec_fn=os.setsid,
            cwd='${this._cwd}'
        )
    except Exception as e:
        # zsh が失敗した場合は bash にフォールバック
        shell_cmd = ['/bin/bash', '-l', '-i']
        p = subprocess.Popen(
            shell_cmd,
            stdin=slave,
            stdout=slave,
            stderr=slave,
            preexec_fn=os.setsid,
            cwd='${this._cwd}'
        )
    
    os.close(slave)
    
    # 非ブロッキング I/O を設定
    try:
        import fcntl
        # PTY マスターを非ブロッキングに設定
        flags = fcntl.fcntl(master, fcntl.F_GETFL)
        fcntl.fcntl(master, fcntl.F_SETFL, flags | os.O_NONBLOCK)
        
        # 標準入力も非ブロッキングに設定
        stdin_flags = fcntl.fcntl(sys.stdin.fileno(), fcntl.F_GETFL)
        fcntl.fcntl(sys.stdin.fileno(), fcntl.F_SETFL, stdin_flags | os.O_NONBLOCK)
    except (ImportError, OSError):
        pass
    
    # メイン I/O ループ
    try:
        while p.poll() is None:
            # 標準入力から PTY マスターへの入力を処理
            try:
                ready, _, _ = select.select([sys.stdin, master], [], [], 0.1)
                
                if sys.stdin in ready:
                    # Node.js からの入力を読み取り（非ブロッキング）
                    try:
                        # バイナリデータとして読み取り
                        data = os.read(sys.stdin.fileno(), 1024)
                        if data:
                            try:
                                # UTF-8でデコード
                                text = data.decode('utf-8')
                                # エスケープシーケンスでターミナルサイズ変更を検出
                                if text.startswith('\\x1b[8;'):
                                    # ターミナルサイズ変更シーケンス
                                    try:
                                        if 't' in text:
                                            parts = text.split(';')
                                            if len(parts) >= 3:
                                                rows = int(parts[1])
                                                cols = int(parts[2].rstrip('t'))
                                                set_winsize(master, rows, cols)
                                                os.environ['LINES'] = str(rows)
                                                os.environ['COLUMNS'] = str(cols)
                                                # SIGWINCH をシェルに送信
                                                if p.pid:
                                                    try:
                                                        os.killpg(os.getpgid(p.pid), signal.SIGWINCH)
                                                    except OSError:
                                                        pass
                                    except (ValueError, IndexError):
                                        pass
                                else:
                                    # 通常の入力を PTY に送信
                                    os.write(master, data)
                            except UnicodeDecodeError:
                                # デコードに失敗した場合はバイナリデータをそのまま送信
                                os.write(master, data)
                    except OSError:
                        pass
                
                if master in ready:
                    # PTY からの出力を読み取り
                    try:
                        data = os.read(master, 1024)
                        if data:
                            # バイナリデータをそのまま標準出力に送信
                            sys.stdout.buffer.write(data)
                            sys.stdout.buffer.flush()
                    except OSError:
                        pass
                        
            except (select.error, OSError):
                time.sleep(0.01)
                
    except KeyboardInterrupt:
        pass
    finally:
        # PTY を閉じる
        try:
            os.close(master)
        except OSError:
            pass
        
        # プロセスを終了
        try:
            if p.poll() is None:
                os.killpg(os.getpgid(p.pid), signal.SIGTERM)
                p.wait(timeout=2)
        except (OSError, subprocess.TimeoutExpired):
            try:
                os.killpg(os.getpgid(p.pid), signal.SIGKILL)
            except OSError:
                pass

if __name__ == '__main__':
    main()
        `;
        
        this._shellProcess = child_process.spawn('python3', ['-c', pythonScript], {
            cwd: this._cwd,
            env: {
                ...process.env,
                TERM: 'xterm-256color',
                FORCE_COLOR: '1',
                COLORTERM: 'truecolor',
                COLUMNS: this._terminalCols.toString(),
                LINES: this._terminalRows.toString()
            },
            stdio: 'pipe'
        });

        if (this._shellProcess.stdout) {
            this._shellProcess.stdout.on('data', (data) => {
                // バイナリデータを UTF-8 でデコードして送信
                try {
                    this.sendToTerminal(data.toString('utf8'));
                } catch (error) {
                    // UTF-8 デコードに失敗した場合は latin1 でフォールバック
                    this.sendToTerminal(data.toString('latin1'));
                }
            });
        }

        if (this._shellProcess.stderr) {
            this._shellProcess.stderr.on('data', (data) => {
                // エラー出力も改行変換
                const output = data.toString().replace(/\n/g, '\r\n');
                this.sendToTerminal(output);
            });
        }

        this._shellProcess.on('exit', (code) => {
            console.log('Python PTY process exited with code:', code);
            this._shellProcess = undefined;
            this.sendToTerminal(`\r\nShell exited with code: ${code}\r\n`);
        });
        
        this._shellProcess.on('error', (error) => {
            console.error('Python PTY process error:', error);
            this.sendToTerminal(`Shell error: ${error.message}\r\n`);
        });
        
        console.log('Python PTY process started successfully');
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

    public clearTerminal() {
        this._view?.webview.postMessage({ type: 'clear' });
        // Python PTY の場合は clear コマンドを送信
        if (this._shellProcess && this._shellProcess.stdin) {
            this._shellProcess.stdin.write('\x0C', 'utf8'); // Form Feed (Ctrl+L)
        }
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
                    height: 100vh;
                    padding: 0;
                    margin: 0;
                    background-color: #222;
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