import * as childProcess from 'child_process';
import * as path from 'path';
import * as vscode from 'vscode';
import { TerminalSessionManager } from './terminalSessionManager';

interface ShellProcessInfo {
    process: childProcess.ChildProcess;
    cols: number;
    rows: number;
    cwd: string;
    isActive: boolean;
}

/**
 * シェルプロセスをグローバルに管理するシングルトンクラス
 * 各ワークスペースフォルダごとに1つのプロセスを維持する
 */
export class ShellProcessManager {
    private static instance: ShellProcessManager;
    private processes: Map<string, ShellProcessInfo> = new Map();
    private sessionManager = TerminalSessionManager.getInstance();
    // startup commands をワークスペースごとに一度だけ実行するためのフラグ
    private startupExecuted: Set<string> = new Set();

    private constructor() {}

    public static getInstance(): ShellProcessManager {
        if (!ShellProcessManager.instance) {
            ShellProcessManager.instance = new ShellProcessManager();
        }
        return ShellProcessManager.instance;
    }

    /**
     * 指定されたワークスペースのシェルプロセスを取得または作成
     */
    public getOrCreateProcess(
        workspaceKey: string,
        extensionPath: string,
        cwd: string,
        cols: number,
        rows: number
    ): childProcess.ChildProcess {
        let processInfo = this.processes.get(workspaceKey);

        const shouldCreate = !processInfo
            || processInfo.process.killed
            || processInfo.process.exitCode !== null
            || !this.isProcessStdinWritable(processInfo.process);

        if (shouldCreate) {
            processInfo = this.createNewProcess(workspaceKey, extensionPath, cwd, cols, rows);
        }

        if (!processInfo) {
            throw new Error(`Failed to create or retrieve shell process for workspace ${workspaceKey}`);
        }

        // プロセスをアクティブにする
        processInfo.isActive = true;

        // サイズ更新
        this.updateProcessSize(workspaceKey, cols, rows);

        return processInfo.process;
    }

    /**
     * 新しいプロセスを作成
     */
    private createNewProcess(
        workspaceKey: string,
        extensionPath: string,
        cwd: string,
        cols: number,
        rows: number
    ): ShellProcessInfo {
        // Creating new shell process

        const pythonScriptPath = path.join(extensionPath, 'resources', 'pty-shell.py');
        
        // VSCode 設定から startup commands を取得（初回起動時のみ有効化）
        const config = vscode.workspace.getConfiguration('secondaryTerminal');
        const configuredStartup: string[] = config.get('startupCommands', []);
        const shouldIncludeStartup = !this.startupExecuted.has(workspaceKey) && configuredStartup.length > 0;
        
        const args = [
            pythonScriptPath,
            cols.toString(),
            rows.toString(),
            cwd
        ];
        
        // 初回のみ startup commands を引数に追加
        if (shouldIncludeStartup) {
            args.push('--startup-commands', JSON.stringify(configuredStartup));
        }
        
        // Python実行パスを動的に決定
        const pythonCommand = this.findPythonCommand();
        
        const shellProcess = childProcess.spawn(pythonCommand, args, {
            cwd: cwd,
            env: {
                ...process.env,
                TERM: 'xterm-256color',
                FORCE_COLOR: '1',
                COLORTERM: 'truecolor',
                COLUMNS: cols.toString(),
                LINES: rows.toString()
            },
            stdio: 'pipe'
        });

        const processInfo: ShellProcessInfo = {
            process: shellProcess,
            cols,
            rows,
            cwd,
            isActive: true
        };

        // 起動に成功したので、このワークスペースでは startup を実行済み扱いにする
        if (shouldIncludeStartup) {
            this.startupExecuted.add(workspaceKey);
        }

        // 出力データをセッションマネージャーに送信
        if (shellProcess.stdout) {
            shellProcess.stdout.on('data', (data: Buffer) => {
                const output = data.toString('utf8');
                this.sessionManager.addOutput(workspaceKey, output);
            });
        }

        if (shellProcess.stderr) {
            shellProcess.stderr.on('data', (data: Buffer) => {
                const output = data.toString('utf8').replace(/\n/g, '\r\n');
                this.sessionManager.addOutput(workspaceKey, output);
            });
        }

        shellProcess.on('exit', () => {
            this.processes.delete(workspaceKey);
        });

        shellProcess.on('error', (error: Error) => {
            console.error(`Shell process error for ${workspaceKey}:`, error);
            const errorMessage = `Shell error: ${error.message}\r\n`;
            this.sessionManager.addOutput(workspaceKey, errorMessage);
        });

        this.processes.set(workspaceKey, processInfo);
        return processInfo;
    }

    /**
     * プロセスにデータを送信
     */
    public sendToProcess(workspaceKey: string, data: string): void {
        const processInfo = this.processes.get(workspaceKey);
        if (!processInfo || !processInfo.process || !processInfo.process.stdin) return;
        const stdinAny: any = processInfo.process.stdin as any;
        // リセット直後など、stdin が閉じている場合は書き込まない
        if (!this.isProcessStdinWritable(processInfo.process)) {
            console.warn(`Skip write: stdin closed (destroyed=${stdinAny.destroyed}, writable=${stdinAny.writable}, ended=${stdinAny.writableEnded}, finished=${stdinAny.writableFinished}) for ${workspaceKey}`);
            return;
        }
        processInfo.process.stdin.write(data, 'utf8');
    }

    /**
     * プロセスのサイズを更新
     */
    public updateProcessSize(workspaceKey: string, cols: number, rows: number): void {
        const processInfo = this.processes.get(workspaceKey);
        if (processInfo && processInfo.process && processInfo.process.stdin && !(processInfo.process.stdin as any).destroyed) {
            if (processInfo.cols !== cols || processInfo.rows !== rows) {
                processInfo.cols = cols;
                processInfo.rows = rows;
                const resizeSeq = `\x1b[8;${rows};${cols}t`;
                processInfo.process.stdin.write(resizeSeq, 'utf8');
            }
        }
    }

    /**
     * プロセスを非アクティブにする（終了はしない）
     */
    public deactivateProcess(workspaceKey: string): void {
        const processInfo = this.processes.get(workspaceKey);
        if (processInfo) {
            processInfo.isActive = false;
        }
    }

    /**
     * 特定のワークスペースのプロセスを明示的に終了
     */
    public terminateProcess(workspaceKey: string): void {
        const processInfo = this.processes.get(workspaceKey);
        if (processInfo && processInfo.process) {
            try {
                // 以降の getOrCreate で再利用されないように、まず Map から外す
                this.processes.delete(workspaceKey);

                const process = processInfo.process;
                
                // プロセスがまだ生きているかチェック
                if (process.killed || process.exitCode !== null) {
                    return;
                }
                
                // stdin を確実に閉じる（end ではなく destroy を優先）
                if (process.stdin && !process.stdin.destroyed) {
                    try {
                        (process.stdin as any).destroy?.();
                    } catch {
                        // destroy が無い/失敗時は end
                        try { process.stdin.end(); } catch {}
                    }
                }
                
                // 穏やかに終了を試みる (SIGTERM)
                process.kill('SIGTERM');
                
                // プロセス終了を監視
                const forceKillTimeout = setTimeout(() => {
                    if (!process.killed && process.exitCode === null) {
                        try {
                            // プロセスグループ全体を強制終了
                            if (process.pid) {
                                process.kill('SIGKILL');
                            }
                        } catch (killError) {
                            console.error('Error force killing process:', killError);
                        }
                    }
                }, 1500); // 短縮して再起動までの待ちを減らす
                
                // プロセス終了時にタイムアウトをクリア
                const exitHandler = () => {
                    clearTimeout(forceKillTimeout);
                };
                
                process.once('exit', exitHandler);
                process.once('error', (error) => {
                    console.error(`Process error for workspace ${workspaceKey}:`, error);
                    clearTimeout(forceKillTimeout);
                });
                
            } catch (error) {
                console.error('Error terminating process:', error);
            }
        }
    }

    /**
     * 特定のワークスペースのプロセスを明示的に終了（完了を待つ）
     */
    public async terminateProcessAsync(workspaceKey: string): Promise<void> {
        const processInfo = this.processes.get(workspaceKey);
        if (!processInfo || !processInfo.process) return;

        return new Promise<void>((resolve) => {
            try {
                // 以降の再利用を防ぐため、先に Map から外す
                this.processes.delete(workspaceKey);

                const proc = processInfo.process;

                // 既に終了していれば即 resolve
                if (proc.killed || proc.exitCode !== null) {
                    resolve();
                    return;
                }

                // stdin を確実に閉じる
                if (proc.stdin && !(proc.stdin as any).destroyed) {
                    try { (proc.stdin as any).destroy?.(); } catch {}
                    try { proc.stdin.end(); } catch {}
                }

                let resolved = false;
                const done = () => {
                    if (resolved) return;
                    resolved = true;
                    resolve();
                };

                // 正常終了・エラーで完了
                proc.once('exit', done);
                proc.once('error', done);

                // 穏やかに終了
                try { proc.kill('SIGTERM'); } catch {}

                // 1秒待ってまだなら強制終了、その0.5秒後に resolve 保証
                setTimeout(() => {
                    try {
                        if (!proc.killed && proc.exitCode === null) {
                            proc.kill('SIGKILL');
                        }
                    } catch {}
                    setTimeout(done, 500);
                }, 1000);
            } catch {
                resolve();
            }
        });
    }

    /**
     * Python コマンドを動的に検索
     */
    private findPythonCommand(): string {
        const candidates = ['python3', 'python', 'python3.exe', 'python.exe'];
        
        for (const cmd of candidates) {
            try {
                // which コマンドでパスを確認
                const result = childProcess.execSync(`which ${cmd}`, { 
                    encoding: 'utf8', 
                    stdio: 'pipe' 
                });
                if (result.trim()) {
                    return cmd;
                }
            } catch {
                // このコマンドは見つからなかった
                continue;
            }
        }
        
        // フォールバック
        console.warn('Python not found, falling back to python3');
        return 'python3';
    }

    // stdin が書き込み可能かのユーティリティ
    private isProcessStdinWritable(proc: childProcess.ChildProcess): boolean {
        const s: any = proc.stdin as any;
        if (!s) return false;
        if (s.destroyed === true) return false;
        if (s.writable === false) return false;
        if (s.writableEnded === true) return false;
        if (s.writableFinished === true) return false;
        return true;
    }

    /**
     * 全てのプロセスを終了（非同期版）
     */
    public async terminateAllProcessesAsync(): Promise<void> {
        if (this.processes.size === 0) {
            return;
        }
        
        // すべてのプロセスに対して終了処理を並行実行
        const terminationPromises: Promise<void>[] = [];
        
        for (const [workspaceKey, processInfo] of this.processes) {
            if (processInfo && processInfo.process) {
                const promise = new Promise<void>((resolve) => {
                    const process = processInfo.process;
                    
                    // プロセスがすでに終了している場合
                    if (process.killed || process.exitCode !== null) {
                        this.processes.delete(workspaceKey);
                        resolve();
                        return;
                    }
                    
                    // stdin を閉じる
                    if (process.stdin && !process.stdin.destroyed) {
                        try {
                            process.stdin.end();
                        } catch (e) {
                            console.warn(`Error closing stdin for ${workspaceKey}:`, e);
                        }
                    }
                    
                    let resolved = false;
                    
                    const cleanup = () => {
                        if (!resolved) {
                            resolved = true;
                            this.processes.delete(workspaceKey);
                            resolve();
                        }
                    };
                    
                    // 終了イベントリスナー
                    process.once('exit', cleanup);
                    process.once('error', (error) => {
                        console.warn(`Process ${workspaceKey} error during termination:`, error);
                        cleanup();
                    });
                    
                    // SIGTERM で終了を試みる
                    try {
                        process.kill('SIGTERM');
                    } catch (e) {
                        console.warn(`Error sending SIGTERM to ${workspaceKey}:`, e);
                        cleanup();
                        return;
                    }
                    
                    // 2秒後に強制終了
                    setTimeout(() => {
                        if (!resolved && !process.killed && process.exitCode === null) {
                            try {
                                process.kill('SIGKILL');
                            } catch (e) {
                                console.warn(`Error sending SIGKILL to ${workspaceKey}:`, e);
                            }
                        }
                        // さらに1秒後にクリーンアップを保証
                        setTimeout(cleanup, 1000);
                    }, 2000);
                });
                
                terminationPromises.push(promise);
            }
        }
        
        // すべての終了処理が完了するまで待機
        try {
            await Promise.allSettled(terminationPromises);
        } catch (error) {
            console.error('Error during process termination:', error);
            throw error;
        }
    }

    /**
     * 全てのプロセスを終了（同期版、後方互換性のため保持）
     */
    public terminateAllProcesses(): void {
        this.terminateAllProcessesAsync().catch((error) => {
            console.error('Error during synchronous process termination:', error);
        });
    }
}
