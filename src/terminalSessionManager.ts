import * as vscode from 'vscode';

interface TerminalSession {
    workspaceKey: string;
    outputBuffer: string;
    currentView: vscode.WebviewView | undefined;
    isConnected: boolean;
    maxBufferSize: number;
    pendingOutput: string;        // デバウンス用の一時バッファ
    outputTimer: NodeJS.Timeout | undefined;  // デバウンス用タイマー
    lastOutputTime: number;       // 最後の出力時刻
}

/**
 * ターミナルセッションの状態を管理するシングルトンクラス
 * WebView が再作成されても状態を維持する
 */
// 定数定義
const TERMINAL_CONSTANTS = {
    MAX_BUFFER_SIZE: 50000,  // 50KB に削減してメモリ使用量とCPU負荷を軽減
    BUFFER_TRIM_RATIO: 0.7,  // バッファ削除時により多く削除してトリミング頻度を減らす
    TRIM_THRESHOLD: 55000,   // トリミング開始のしきい値を分離
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
            maxBufferSize: this.MAX_BUFFER_SIZE,
            pendingOutput: '',
            outputTimer: undefined,
            lastOutputTime: 0
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
        const performanceStart = performance.now();
        
        const session = this.sessions.get(workspaceKey);
        if (!session) {
            console.warn(`No session found for workspace: ${workspaceKey}`);
            return;
        }

        // バッファにデータを追加
        session.outputBuffer += data;
        
        // バッファサイズ制限（効率的なトリミング）
        if (session.outputBuffer.length > session.maxBufferSize) {
            const trimStart = performance.now();
            
            // CPU 負荷軽減のため、単純なトリミングに変更
            const targetSize = Math.floor(session.maxBufferSize * TERMINAL_CONSTANTS.BUFFER_TRIM_RATIO);
            const excess = session.outputBuffer.length - targetSize;
            const originalSize = session.outputBuffer.length;
            session.outputBuffer = session.outputBuffer.substring(excess);
            
            const trimEnd = performance.now();
            console.log(`[PERF] Buffer trimmed for workspace: ${workspaceKey} (${originalSize} → ${session.outputBuffer.length} chars, took ${(trimEnd - trimStart).toFixed(2)}ms)`);
        }

        // 接続されているビューに送信（デバウンス処理付き）
        if (session.isConnected && session.currentView) {
            this.sendToViewDebounced(session, data);
        }

        const performanceEnd = performance.now();
        if (performanceEnd - performanceStart > 1) { // 1ms以上かかった場合のみログ出力
            console.log(`[PERF] addOutput took ${(performanceEnd - performanceStart).toFixed(2)}ms for ${data.length} chars`);
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
     * ビューにデータを送信（デバウンス機能付き）
     */
    private sendToViewDebounced(session: TerminalSession, data: string): void {
        const now = Date.now();
        session.pendingOutput += data;
        
        // 前回の出力から間隔が短い場合はデバウンス
        const timeSinceLastOutput = now - session.lastOutputTime;
        const shouldDebounce = timeSinceLastOutput < 16; // 60FPS（約16.67ms）を基準
        
        if (shouldDebounce && session.outputTimer) {
            // 既存のタイマーをクリア
            clearTimeout(session.outputTimer);
        }
        
        const flushOutput = () => {
            if (session.pendingOutput && session.currentView) {
                try {
                    const outputData = session.pendingOutput;
                    session.pendingOutput = ''; // 先にクリアして重複送信を防ぐ
                    session.lastOutputTime = Date.now();
                    
                    session.currentView.webview.postMessage({
                        type: 'output',
                        data: outputData
                    });
                } catch (error) {
                    console.error('Error sending data to view:', error);
                    session.isConnected = false;
                    session.pendingOutput = ''; // エラー時もクリア
                }
            }
            session.outputTimer = undefined;
        };
        
        if (shouldDebounce) {
            // デバウンス：16ms後に送信
            session.outputTimer = setTimeout(flushOutput, 16);
        } else {
            // 即座に送信
            flushOutput();
        }
    }

    /**
     * ビューにデータを送信（従来のメソッド、復元時などで使用）
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
            // タイマーをクリーンアップ
            if (session.outputTimer) {
                clearTimeout(session.outputTimer);
                session.outputTimer = undefined;
            }
            
            session.isConnected = false;
            session.currentView = undefined;
            session.pendingOutput = '';
            this.sessions.delete(workspaceKey);
            console.log(`Removed session for workspace: ${workspaceKey}`);
        }
    }

    /**
     * 全てのセッションを削除
     */
    public removeAllSessions(): void {
        console.log(`Removing ${this.sessions.size} terminal sessions...`);
        
        // 各セッションのタイマーを確実にクリーンアップ
        for (const [workspaceKey, session] of this.sessions) {
            try {
                // 出力タイマーをクリア
                if (session.outputTimer) {
                    clearTimeout(session.outputTimer);
                    session.outputTimer = undefined;
                    console.log(`Cleared output timer for session: ${workspaceKey}`);
                }
                
                // セッション状態をクリア
                session.isConnected = false;
                session.currentView = undefined;
                session.pendingOutput = '';
                session.outputBuffer = '';
                
                console.log(`Cleaned up session: ${workspaceKey}`);
            } catch (error) {
                console.error(`Error cleaning up session ${workspaceKey}:`, error);
            }
        }
        
        // Map をクリア
        this.sessions.clear();
        console.log('Removed all terminal sessions successfully');
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