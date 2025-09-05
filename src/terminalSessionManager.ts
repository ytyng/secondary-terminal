import * as vscode from 'vscode';

interface TerminalSession {
    workspaceKey: string;
    // 出力のリングバッファ（O(n) 連結/トリミング回避のため）
    outputChunks: string[];
    totalBufferLength: number;
    currentView: vscode.WebviewView | undefined;
    isConnected: boolean;
    maxBufferSize: number;
    pendingOutput: string;        // デバウンス用の一時バッファ
    outputTimer: NodeJS.Timeout | undefined;  // デバウンス用タイマー
    lastOutputTime: number;       // 最後の出力時刻
    pendingSince: number | null;  // 最初に pendingOutput が溜まり始めた時刻
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
            outputChunks: [],
            totalBufferLength: 0,
            currentView: undefined,
            isConnected: false,
            maxBufferSize: this.MAX_BUFFER_SIZE,
            pendingOutput: '',
            outputTimer: undefined,
            lastOutputTime: 0,
            pendingSince: null
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
        if (session.totalBufferLength > 0 && session.outputChunks.length > 0) {
            const snapshot = session.outputChunks.join('');
            console.log(`Restoring ${snapshot.length} characters to new view`);
            this.sendToView(session, snapshot);
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

        // バッファ（リングバッファ）にデータを追加
        session.outputChunks.push(data);
        session.totalBufferLength += data.length;
        
        // バッファサイズ制限（効率的なトリミング）
        if (session.totalBufferLength > session.maxBufferSize) {
            const trimStart = performance.now();
            
            // 目標サイズまで先頭からチャンクを削除
            const targetSize = Math.floor(session.maxBufferSize * TERMINAL_CONSTANTS.BUFFER_TRIM_RATIO);
            const originalSize = session.totalBufferLength;
            while (session.totalBufferLength > targetSize && session.outputChunks.length > 0) {
                const removed = session.outputChunks.shift()!;
                session.totalBufferLength -= removed.length;
            }
            
            const trimEnd = performance.now();
            console.log(`[PERF] Buffer trimmed for workspace: ${workspaceKey} (${originalSize} → ${session.totalBufferLength} chars, took ${(trimEnd - trimStart).toFixed(2)}ms)`);
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
            session.outputChunks = [];
            session.totalBufferLength = 0;
            console.log(`Cleared buffer for workspace: ${workspaceKey}`);
        }
    }

    /**
     * ビューにデータを送信（デバウンス機能付き）
     */
    private sendToViewDebounced(session: TerminalSession, data: string): void {
        const now = Date.now();
        session.pendingOutput += data;
        if (session.pendingSince === null) {
            session.pendingSince = now;
        }

        const MAX_DEBOUNCE_MS = 32;           // 最長待機
        const IMMEDIATE_FLUSH_THRESHOLD = 8192; // 8KB 以上は即送信

        // 即時フラッシュ条件
        const elapsedSincePending = now - (session.pendingSince || now);
        if (session.pendingOutput.length >= IMMEDIATE_FLUSH_THRESHOLD || elapsedSincePending >= MAX_DEBOUNCE_MS) {
            if (session.outputTimer) {
                clearTimeout(session.outputTimer);
                session.outputTimer = undefined;
            }
            this.flushPendingOutput(session);
            return;
        }

        // 前回の出力から間隔が短い場合はデバウンス
        const timeSinceLastOutput = now - session.lastOutputTime;
        const shouldDebounce = timeSinceLastOutput < 16; // 60FPS（約16.67ms）を基準

        if (shouldDebounce && session.outputTimer) {
            // 既存のタイマーを更新
            clearTimeout(session.outputTimer);
        }

        if (shouldDebounce) {
            // デバウンス：16ms後に送信
            session.outputTimer = setTimeout(() => this.flushPendingOutput(session), 16);
        } else {
            // 即座に送信
            this.flushPendingOutput(session);
        }
    }

    private flushPendingOutput(session: TerminalSession): void {
        if (session.pendingOutput && session.currentView) {
            try {
                const outputData = session.pendingOutput;
                session.pendingOutput = '';
                session.lastOutputTime = Date.now();
                session.pendingSince = null;
                session.currentView.webview.postMessage({
                    type: 'output',
                    data: outputData
                });
            } catch (error) {
                console.error('Error sending data to view:', error);
                session.isConnected = false;
                session.pendingOutput = '';
                session.pendingSince = null;
            }
        }
        session.outputTimer = undefined;
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
        if (!session) return '';
        if (session.outputChunks.length === 0) return '';
        return session.outputChunks.join('');
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
                session.outputChunks = [];
                session.totalBufferLength = 0;
                session.pendingSince = null;
                
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
            bufferSize: session.totalBufferLength,
            isConnected: session.isConnected
        }));
    }
}
