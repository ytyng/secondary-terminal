import * as child_process from 'child_process';
import * as path from 'path';
import * as vscode from 'vscode';
import { TerminalSessionManager } from './terminalSessionManager';

interface ShellProcessInfo {
    process: child_process.ChildProcess;
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
    ): child_process.ChildProcess {
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
        
        const shellProcess = child_process.spawn('python3', [
            pythonScriptPath,
            cols.toString(),
            rows.toString(),
            cwd
        ], {
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
                processInfo.process.kill('SIGTERM');
                setTimeout(() => {
                    if (processInfo.process && !processInfo.process.killed) {
                        processInfo.process.kill('SIGKILL');
                    }
                }, 2000);
            } catch (error) {
                console.error('Error terminating process:', error);
            }
            this.processes.delete(workspaceKey);
        }
    }

    /**
     * 全てのプロセスを終了
     */
    public terminateAllProcesses(): void {
        for (const [workspaceKey] of this.processes) {
            this.terminateProcess(workspaceKey);
        }
    }
}