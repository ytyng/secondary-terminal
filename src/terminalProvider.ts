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

                /* 選択機能の有効化 */
                .xterm {
                    /* user-select を none にしない（選択を可能にする） */
                }

                .xterm .xterm-selection-layer .xterm-selection {
                    background-color: var(--vscode-terminal-selection-background) !important;
                    opacity: 0.3 !important;
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
                            selection: 'rgba(255, 255, 255, 0.3)',
                            selectionBackground: 'rgba(255, 255, 255, 0.3)'
                        },
                        fontFamily: 'var(--vscode-terminal-font-family), "RobotoMono Nerd Font", "Roboto Mono", Consolas, "Courier New", monospace',
                        fontSize: 13,
                        letterSpacing: '-2px',
                        lineHeight: 22 / 13, // 22px ÷ 13px = 約1.69
                        cursorBlink: true,
                        convertEol: true,
                        allowTransparency: true,
                        rightClickSelectsWord: true,
                        macOptionIsMeta: true,
                        disableStdin: false,
                        customGlyphs: false,
                        drawBoldTextInBrightColors: true,
                        fastScrollModifier: 'alt',
                        fastScrollSensitivity: 5,
                        scrollSensitivity: 1,
                        wordSeparator: ' ()[]{}\\'":;,.$'
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
                        const availableWidth = Math.max(containerRect.width - 20, 300); // パディング考慮
                        const availableHeight = Math.max(containerRect.height - 20, 200); // パディング考慮

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
                            // Claude Code のステータスメッセージを処理（簡略化）
                            if (data.includes('claude_status')) {
                                console.log('Claude Code status message detected');
                            }
                        } catch (error) {
                            // エラーは無視
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
                                        var altEnterSequence = String.fromCharCode(27);

                                        vscode.postMessage({
                                            type: 'terminalInput',
                                            data: altEnterSequence
                                        });

                                        // false を返してデフォルト処理を停止
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

                    // カスタム選択機能の実装
                    let isSelecting = false;
                    let selectionStart = null;
                    let selectionEnd = null;
                    let selectedText = '';
                    let selectionOverlay = null;
                    let lastXtermSelection = '';  // xterm.js の選択を保持

                    // 選択範囲を視覚的に表示するオーバーレイを作成
                    function createSelectionOverlay() {
                        if (selectionOverlay) {
                            selectionOverlay.remove();
                        }
                        selectionOverlay = document.createElement('div');
                        selectionOverlay.style.position = 'absolute';
                        selectionOverlay.style.backgroundColor = 'rgba(178, 212, 255, 0.3)';
                        selectionOverlay.style.border = '1px solid rgba(178, 212, 255, 0.5)';
                        selectionOverlay.style.pointerEvents = 'none';
                        selectionOverlay.style.zIndex = '10';
                        return selectionOverlay;
                    }

                    // 選択範囲のハイライトを更新
                    function updateSelectionHighlight(start, end) {
                        if (!start || !end || !selectionOverlay) return;

                        const charWidth = 7.8015625;
                        const lineHeight = 20;
                        const padding = 5;

                        // 選択範囲の座標を計算
                        const startRow = Math.min(start.row, end.row);
                        const endRow = Math.max(start.row, end.row);
                        const startCol = start.row <= end.row ? start.col : end.col;
                        const endCol = start.row <= end.row ? end.col : start.col;

                        // ハイライトの位置とサイズを計算
                        const x = padding + startCol * charWidth;
                        const y = padding + startRow * lineHeight;
                        const width = Math.max((endCol - startCol + 1) * charWidth, charWidth);
                        const height = (endRow - startRow + 1) * lineHeight;

                        selectionOverlay.style.left = x + 'px';
                        selectionOverlay.style.top = y + 'px';
                        selectionOverlay.style.width = width + 'px';
                        selectionOverlay.style.height = height + 'px';
                    }

                    // マウスイベントで選択範囲を手動計算
                    const terminalElement = document.getElementById('terminal');
                    if (terminalElement) {
                        // ターミナル要素の position を relative に設定（オーバーレイ用）
                        terminalElement.style.position = 'relative';

                        terminalElement.addEventListener('mousedown', (e) => {
                            if (e.button === 0) { // 左ボタン
                                // 既存の選択をクリア
                                if (selectionOverlay) {
                                    selectionOverlay.remove();
                                    selectionOverlay = null;
                                }

                                isSelecting = true;
                                const rect = terminalElement.getBoundingClientRect();
                                const x = e.clientX - rect.left;
                                const y = e.clientY - rect.top;

                                // 文字位置を計算（padding考慮）
                                const charWidth = 7.8015625; // フォントメトリクスから
                                const lineHeight = 20;
                                const col = Math.floor((x - 5) / charWidth);
                                const row = Math.floor((y - 5) / lineHeight);

                                selectionStart = { col: Math.max(0, col), row: Math.max(0, row) };
                                selectionEnd = selectionStart; // 初期状態では開始点と同じ
                                selectedText = '';

                                // 選択オーバーレイを作成
                                selectionOverlay = createSelectionOverlay();
                                terminalElement.appendChild(selectionOverlay);

                                console.log('Selection start:', selectionStart);
                                e.preventDefault(); // デフォルトの選択動作を防止
                            }
                        });

                        terminalElement.addEventListener('mousemove', (e) => {
                            if (isSelecting && e.buttons === 1) {
                                const rect = terminalElement.getBoundingClientRect();
                                const x = e.clientX - rect.left;
                                const y = e.clientY - rect.top;

                                const charWidth = 7.8015625;
                                const lineHeight = 20;
                                const col = Math.floor((x - 5) / charWidth);
                                const row = Math.floor((y - 5) / lineHeight);

                                selectionEnd = { col: Math.max(0, col), row: Math.max(0, row) };

                                // 選択範囲から文字列を取得
                                selectedText = getTextFromSelection(selectionStart, selectionEnd);

                                // ハイライトを更新
                                updateSelectionHighlight(selectionStart, selectionEnd);

                                console.log('Selection updated:', selectedText);
                                e.preventDefault();
                            }
                        });

                        // 選択をクリアする関数
                        function clearSelection() {
                            if (selectionOverlay) {
                                selectionOverlay.remove();
                                selectionOverlay = null;
                            }
                            selectedText = '';
                            selectionStart = null;
                            selectionEnd = null;
                            console.log('Selection cleared');
                        }

                        terminalElement.addEventListener('mouseup', (e) => {
                            if (isSelecting && e.button === 0) {
                                console.log('Mouse up detected, isSelecting:', isSelecting);
                                isSelecting = false;

                                // 選択範囲が有効で、選択テキストがある場合のみコピー
                                if (selectionStart && selectionEnd && selectedText && selectedText.trim().length > 0) {
                                    console.log('Selection completed:', selectedText);
                                    console.log('Selection state preserved for manual copy');
                                    // 自動的にクリップボードにコピー
                                    navigator.clipboard.writeText(selectedText.trim()).then(() => {
                                        console.log('Selection auto-copied to clipboard:', selectedText.trim());
                                    }).catch(err => {
                                        console.error('Failed to auto-copy selection:', err);
                                    });
                                    // 注意: 選択状態を保持（selectedText, selectionStart, selectionEnd, selectionOverlay は残す）
                                } else {
                                    console.log('No valid selection to copy');
                                    // 選択が無効な場合のみクリア
                                    clearSelection();
                                }
                                e.preventDefault();
                            }
                        });

                        // ターミナル外でのマウスアップを処理
                        document.addEventListener('mouseup', (e) => {
                            if (isSelecting) {
                                console.log('Mouse up outside terminal');
                                isSelecting = false;
                                // 選択範囲が有効で、選択テキストがある場合のみコピー
                                if (selectionStart && selectionEnd && selectedText && selectedText.trim().length > 0) {
                                    console.log('Selection completed (outside):', selectedText);
                                    console.log('Selection state preserved for manual copy (outside)');
                                    navigator.clipboard.writeText(selectedText.trim()).then(() => {
                                        console.log('Selection auto-copied to clipboard (outside):', selectedText.trim());
                                    }).catch(err => {
                                        console.error('Failed to auto-copy selection (outside):', err);
                                    });
                                    // 注意: 選択状態を保持
                                } else {
                                    // 選択が無効な場合のみクリア
                                    clearSelection();
                                }
                            }
                        });

                        // クリックで選択をクリア（新しい選択が始まった時のみ）
                        terminalElement.addEventListener('click', (e) => {
                            // 選択中でない かつ 選択範囲が存在する場合のみクリア
                            if (!isSelecting && selectionOverlay) {
                                clearSelection();
                                console.log('Selection cleared by click');
                            }
                        });

                        // Escape キーで選択をクリア
                        document.addEventListener('keydown', (e) => {
                            if (e.key === 'Escape' && selectionOverlay) {
                                clearSelection();
                                console.log('Selection cleared by Escape key');
                                e.preventDefault();
                            }
                        });
                    }

                    // 選択範囲から文字列を取得する関数
                    function getTextFromSelection(start, end) {
                        if (!start || !end) return '';

                        try {
                            // ターミナルバッファから文字列を取得
                            let result = '';
                            const startRow = Math.min(start.row, end.row);
                            const endRow = Math.max(start.row, end.row);
                            const startCol = start.row <= end.row ? start.col : end.col;
                            const endCol = start.row <= end.row ? end.col : start.col;

                            for (let row = startRow; row <= endRow; row++) {
                                if (row < term.buffer.normal.length) {
                                    const line = term.buffer.normal.getLine(row);
                                    if (line) {
                                        let lineText = '';
                                        const fromCol = row === startRow ? startCol : 0;
                                        const toCol = row === endRow ? endCol : term.cols - 1;

                                        for (let col = fromCol; col <= toCol && col < term.cols; col++) {
                                            const cell = line.getCell(col);
                                            if (cell) {
                                                lineText += cell.getChars() || ' ';
                                            }
                                        }

                                        result += lineText;
                                        if (row < endRow) {
                                            result += '\\n';
                                        }
                                    }
                                }
                            }

                            return result.trim();
                        } catch (error) {
                            console.error('Error getting text from selection:', error);
                            return '';
                        }
                    }

                    // xterm.js の選択機能のイベントハンドラー（選択を保持）
                    term.onSelectionChange(() => {
                        const selection = term.getSelection();
                        const hasSelection = term.hasSelection();

                        // xterm.js の選択があれば保持
                        if (selection && selection.trim().length > 0) {
                            lastXtermSelection = selection;
                            console.log('xterm.js selection saved:', lastXtermSelection);
                        }

                        console.log('xterm.js Selection changed:', {
                            selection: selection,
                            hasSelection: hasSelection,
                            selectionLength: selection ? selection.length : 0,
                            lastSaved: lastXtermSelection
                        });
                    });

                    // Copy & Paste support
                    document.addEventListener('keydown', (e) => {
                        // Cmd+C (Mac) or Ctrl+C (Win/Linux) for copy
                        if ((e.metaKey || e.ctrlKey) && e.key === 'c') {
                            console.log('==== COPY OPERATION DEBUG ====');
                            console.log('1. Custom selectedText:', JSON.stringify(selectedText));
                            console.log('2. Has selection overlay:', !!selectionOverlay);
                            console.log('3. Selection start/end:', selectionStart, selectionEnd);
                            console.log('4. lastXtermSelection:', JSON.stringify(lastXtermSelection));

                            // 現在のxterm.js選択も確認
                            const currentXtermSelection = term.getSelection();
                            console.log('5. Current xterm selection:', JSON.stringify(currentXtermSelection));
                            console.log('6. Has current xterm selection:', term.hasSelection());

                            let textToCopy = '';

                            // 1. まずカスタム選択を試す
                            if (selectedText && selectedText.trim().length > 0) {
                                textToCopy = selectedText.trim();
                                console.log('Using custom selection:', textToCopy);
                            }
                            // 2. カスタム選択がない場合、選択範囲から再取得を試す
                            else if (selectionStart && selectionEnd && selectionOverlay) {
                                const refreshedText = getTextFromSelection(selectionStart, selectionEnd);
                                console.log('Refreshed selection text:', JSON.stringify(refreshedText));
                                if (refreshedText && refreshedText.trim().length > 0) {
                                    textToCopy = refreshedText.trim();
                                    selectedText = textToCopy; // 更新
                                    console.log('Using refreshed selection:', textToCopy);
                                }
                            }
                            // 3. 現在のxterm.js選択を試す
                            else if (currentXtermSelection && currentXtermSelection.trim().length > 0) {
                                textToCopy = currentXtermSelection.trim();
                                console.log('Using current xterm selection:', textToCopy);
                            }
                            // 4. 保存されたxterm.js選択を試す
                            else if (lastXtermSelection && lastXtermSelection.trim().length > 0) {
                                textToCopy = lastXtermSelection.trim();
                                console.log('Using saved xterm selection:', textToCopy);
                            }

                            // コピー実行
                            if (textToCopy) {
                                console.log('Attempting to copy:', JSON.stringify(textToCopy));
                                navigator.clipboard.writeText(textToCopy).then(() => {
                                    console.log('✅ Successfully copied to clipboard!');
                                    // 成功を視覚的に表示
                                    const message = document.createElement('div');
                                    message.textContent = 'Copied!';
                                    message.style.position = 'fixed';
                                    message.style.top = '10px';
                                    message.style.right = '10px';
                                    message.style.background = 'green';
                                    message.style.color = 'white';
                                    message.style.padding = '5px';
                                    message.style.borderRadius = '3px';
                                    message.style.zIndex = '1000';
                                    document.body.appendChild(message);
                                    setTimeout(() => message.remove(), 1000);
                                }).catch(err => {
                                    console.error('❌ Failed to copy to clipboard:', err);
                                });
                                e.preventDefault();
                            } else {
                                console.log('❌ No valid text found to copy');
                            }

                            console.log('==== END COPY DEBUG ====');
                        }

                        // Cmd+V (Mac) or Ctrl+V (Win/Linux) for paste
                        if ((e.metaKey || e.ctrlKey) && e.key === 'v') {
                            navigator.clipboard.readText().then(text => {
                                console.log('Paste triggered, text:', text);
                                vscode.postMessage({
                                    type: 'terminalInput',
                                    data: text
                                });
                            }).catch(err => {
                                console.error('Failed to read clipboard:', err);
                            });
                            e.preventDefault();
                        }
                    });

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
