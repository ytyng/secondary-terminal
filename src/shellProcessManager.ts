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

        if (!processInfo || !processInfo.process || processInfo.process.killed) {
            // プロセスが存在しないか終了している場合は新規作成
            processInfo = this.createNewProcess(workspaceKey, extensionPath, cwd, cols, rows);
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
        console.log(`Creating new shell process for workspace: ${workspaceKey}`);

        const pythonScriptPath = path.join(extensionPath, 'resources', 'pty-shell.py');
        
        // VSCode 設定から startup commands を取得
        const config = vscode.workspace.getConfiguration('secondaryTerminal');
        const startupCommands: string[] = config.get('startupCommands', []);
        
        const args = [
            pythonScriptPath,
            cols.toString(),
            rows.toString(),
            cwd
        ];
        
        // startup commands が設定されている場合は引数に追加
        if (startupCommands.length > 0) {
            args.push('--startup-commands', JSON.stringify(startupCommands));
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

        // 出力データをセッションマネージャーに送信
        if (shellProcess.stdout) {
            shellProcess.stdout.on('data', (data: Buffer) => {
                const output = data.toString('utf8');
                this.sessionManager.addOutput(workspaceKey, output);
            });
        }

        if (shellProcess.stderr) {
            shellProcess.stderr.on('data', (data: Buffer) => {
                const output = data.toString().replace(/\n/g, '\r\n');
                this.sessionManager.addOutput(workspaceKey, output);
            });
        }

        shellProcess.on('exit', (code: number | null) => {
            console.log(`Shell process for ${workspaceKey} exited with code:`, code);
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
        if (processInfo && processInfo.process && processInfo.process.stdin) {
            processInfo.process.stdin.write(data, 'utf8');
        }
    }

    /**
     * プロセスのサイズを更新
     */
    public updateProcessSize(workspaceKey: string, cols: number, rows: number): void {
        const processInfo = this.processes.get(workspaceKey);
        if (processInfo && processInfo.process && processInfo.process.stdin) {
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
            console.log(`Deactivated process for workspace: ${workspaceKey}`);
        }
    }

    /**
     * 特定のワークスペースのプロセスを明示的に終了
     */
    public terminateProcess(workspaceKey: string): void {
        const processInfo = this.processes.get(workspaceKey);
        if (processInfo && processInfo.process) {
            console.log(`Terminating shell process for workspace: ${workspaceKey}`);
            try {
                const process = processInfo.process;
                
                // プロセスがまだ生きているかチェック
                if (process.killed || process.exitCode !== null) {
                    this.processes.delete(workspaceKey);
                    return;
                }
                
                // stdin を閉じる
                if (process.stdin && !process.stdin.destroyed) {
                    process.stdin.end();
                }
                
                // 穏やかに終了を試みる (SIGTERM)
                process.kill('SIGTERM');
                
                // プロセス終了を監視
                const forceKillTimeout = setTimeout(() => {
                    if (!process.killed && process.exitCode === null) {
                        console.log(`Force killing process for workspace: ${workspaceKey}`);
                        try {
                            // プロセスグループ全体を強制終了
                            if (process.pid) {
                                process.kill('SIGKILL');
                            }
                        } catch (killError) {
                            console.error('Error force killing process:', killError);
                        }
                    }
                }, 3000); // 3秒待つ
                
                // プロセス終了時にタイムアウトをクリア
                const exitHandler = () => {
                    clearTimeout(forceKillTimeout);
                    this.processes.delete(workspaceKey);
                    console.log(`Process for workspace ${workspaceKey} has exited`);
                };
                
                process.once('exit', exitHandler);
                process.once('error', (error) => {
                    console.error(`Process error for workspace ${workspaceKey}:`, error);
                    clearTimeout(forceKillTimeout);
                    this.processes.delete(workspaceKey);
                });
                
            } catch (error) {
                console.error('Error terminating process:', error);
                this.processes.delete(workspaceKey);
            }
        }
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
                    console.log(`Using Python command: ${cmd}`);
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

    /**
     * 全てのプロセスを終了（非同期版）
     */
    public async terminateAllProcessesAsync(): Promise<void> {
        console.log(`Terminating ${this.processes.size} shell processes...`);
        
        if (this.processes.size === 0) {
            console.log('No shell processes to terminate');
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
                            console.log(`Process ${workspaceKey} cleanup completed`);
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
                        console.log(`Sent SIGTERM to process ${workspaceKey}`);
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
                                console.log(`Sent SIGKILL to process ${workspaceKey}`);
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
            console.log('All shell processes terminated successfully');
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