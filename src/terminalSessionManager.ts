import * as vscode from 'vscode';

interface TerminalSession {
    workspaceKey: string;
    outputBuffer: string;
    currentView?: vscode.WebviewView;
    isConnected: boolean;
    maxBufferSize: number;
}

/**
 * ターミナルセッションの状態を管理するシングルトンクラス
 * WebView が再作成されても状態を維持する
 */
export class TerminalSessionManager {
    private static instance: TerminalSessionManager;
    private sessions: Map<string, TerminalSession> = new Map();
    private readonly MAX_BUFFER_SIZE = 100000; // 100KB のバッファサイズ

    private constructor() {}

    public static getInstance(): TerminalSessionManager {
        if (!TerminalSessionManager.instance) {
            TerminalSessionManager.instance = new TerminalSessionManager();
        }
        return TerminalSessionManager.instance;
    }

    /**
     * セッションを取得または作成
     */
    public getOrCreateSession(workspaceKey: string): TerminalSession {
        let session = this.sessions.get(workspaceKey);
        
        if (!session) {
            session = {
                workspaceKey,
                outputBuffer: '',
                currentView: undefined,
                isConnected: false,
                maxBufferSize: this.MAX_BUFFER_SIZE
            };
            this.sessions.set(workspaceKey, session);
            console.log(`Created new terminal session for workspace: ${workspaceKey}`);
        }
        
        return session;
    }

    /**
     * WebView をセッションに接続
     */
    public connectView(workspaceKey: string, view: vscode.WebviewView): void {
        const session = this.getOrCreateSession(workspaceKey);
        
        // 既存の接続がある場合は切断
        if (session.currentView && session.currentView !== view) {
            console.log(`Disconnecting previous view for workspace: ${workspaceKey}`);
            session.isConnected = false;
        }
        
        session.currentView = view;
        session.isConnected = true;
        
        // バッファに保存されている出力を新しいビューに送信
        if (session.outputBuffer) {
            console.log(`Restoring ${session.outputBuffer.length} characters to new view`);
            this.sendToView(session, session.outputBuffer);
            // バッファはクリアしない（次回の接続でも使用するため）
        }
        
        console.log(`Connected view to session: ${workspaceKey}`);
    }

    /**
     * WebView をセッションから切断
     */
    public disconnectView(workspaceKey: string, view: vscode.WebviewView): void {
        const session = this.sessions.get(workspaceKey);
        if (session && session.currentView === view) {
            session.currentView = undefined;
            session.isConnected = false;
            console.log(`Disconnected view from session: ${workspaceKey}`);
        }
    }

    /**
     * セッションにデータを追加し、接続されているビューに送信
     */
    public addOutput(workspaceKey: string, data: string): void {
        const session = this.sessions.get(workspaceKey);
        if (!session) {
            console.warn(`No session found for workspace: ${workspaceKey}`);
            return;
        }

        // バッファにデータを追加
        session.outputBuffer += data;
        
        // バッファサイズ制限
        if (session.outputBuffer.length > session.maxBufferSize) {
            // 前半を削除して後半を保持
            const excess = session.outputBuffer.length - session.maxBufferSize;
            session.outputBuffer = session.outputBuffer.substring(excess);
            console.log(`Buffer trimmed for workspace: ${workspaceKey}`);
        }

        // 接続されているビューに送信
        if (session.isConnected && session.currentView) {
            this.sendToView(session, data);
        }
    }

    /**
     * セッションのバッファをクリア
     */
    public clearBuffer(workspaceKey: string): void {
        const session = this.sessions.get(workspaceKey);
        if (session) {
            session.outputBuffer = '';
            console.log(`Cleared buffer for workspace: ${workspaceKey}`);
        }
    }

    /**
     * ビューにデータを送信
     */
    private sendToView(session: TerminalSession, data: string): void {
        if (session.currentView) {
            try {
                session.currentView.webview.postMessage({
                    type: 'output',
                    data: data
                });
            } catch (error) {
                console.error('Error sending data to view:', error);
                session.isConnected = false;
            }
        }
    }

    /**
     * セッションが接続されているかチェック
     */
    public isConnected(workspaceKey: string): boolean {
        const session = this.sessions.get(workspaceKey);
        return session ? session.isConnected : false;
    }

    /**
     * セッションの出力バッファを取得
     */
    public getBuffer(workspaceKey: string): string {
        const session = this.sessions.get(workspaceKey);
        return session ? session.outputBuffer : '';
    }

    /**
     * 指定されたワークスペースのセッションを削除
     */
    public removeSession(workspaceKey: string): void {
        const session = this.sessions.get(workspaceKey);
        if (session) {
            session.isConnected = false;
            session.currentView = undefined;
            this.sessions.delete(workspaceKey);
            console.log(`Removed session for workspace: ${workspaceKey}`);
        }
    }

    /**
     * 全てのセッションを削除
     */
    public removeAllSessions(): void {
        for (const [workspaceKey] of this.sessions) {
            this.removeSession(workspaceKey);
        }
        console.log('Removed all terminal sessions');
    }

    /**
     * デバッグ用：セッション情報を取得
     */
    public getSessionInfo(): Array<{ workspaceKey: string; bufferSize: number; isConnected: boolean }> {
        return Array.from(this.sessions.entries()).map(([key, session]) => ({
            workspaceKey: key,
            bufferSize: session.outputBuffer.length,
            isConnected: session.isConnected
        }));
    }
}