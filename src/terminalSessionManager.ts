import * as vscode from 'vscode';

interface TerminalSession {
    workspaceKey: string;
    outputBuffer: string;
    currentView: vscode.WebviewView | undefined;
    isConnected: boolean;
    maxBufferSize: number;
}

/**
 * ターミナルセッションの状態を管理するシングルトンクラス
 * WebView が再作成されても状態を維持する
 */
// 定数定義
const TERMINAL_CONSTANTS = {
    MAX_BUFFER_SIZE: 50000,  // 50KB に削減してメモリ使用量とCPU負荷を軽減
    BUFFER_TRIM_RATIO: 0.7,  // バッファ削除時により多く削除してトリミング頻度を減らす
} as const;

export class TerminalSessionManager {
    private static instance: TerminalSessionManager;
    private sessions: Map<string, TerminalSession> = new Map();
    private readonly MAX_BUFFER_SIZE = TERMINAL_CONSTANTS.MAX_BUFFER_SIZE;

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
        const existingSession = this.sessions.get(workspaceKey);
        
        if (existingSession) {
            return existingSession;
        }
        
        const newSession: TerminalSession = {
            workspaceKey,
            outputBuffer: '',
            currentView: undefined,
            isConnected: false,
            maxBufferSize: this.MAX_BUFFER_SIZE
        };
        
        this.sessions.set(workspaceKey, newSession);
        console.log(`Created new terminal session for workspace: ${workspaceKey}`);
        return newSession;
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
        
        // バッファサイズ制限（効率的なトリミング）
        if (session.outputBuffer.length > session.maxBufferSize) {
            // CPU 負荷軽減のため、単純なトリミングに変更
            const targetSize = Math.floor(session.maxBufferSize * TERMINAL_CONSTANTS.BUFFER_TRIM_RATIO);
            const excess = session.outputBuffer.length - targetSize;
            session.outputBuffer = session.outputBuffer.substring(excess);
            
            console.log(`Buffer trimmed for workspace: ${workspaceKey} (new size: ${session.outputBuffer.length})`);
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