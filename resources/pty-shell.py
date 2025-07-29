#!/usr/bin/env python3
import pty
import os
import sys
import subprocess
import signal
import struct
import select
import time
import json


def set_winsize(fd, rows, cols):
    """ターミナルサイズを設定"""
    try:
        import termios

        winsize = struct.pack('HHHH', rows, cols, 0, 0)
        import fcntl

        fcntl.ioctl(fd, termios.TIOCSWINSZ, winsize)
    except (ImportError, OSError):
        pass


def check_cli_agent_active(shell_pid):
    """シェルプロセスでCLIエージェント（Claude、Gemini）がアクティブかチェック"""
    try:
        # プロセスツリーを取得して、シェルの子孫プロセスを調べる
        ps_result = subprocess.run(
            ['ps', '-eo', 'pid,ppid,comm,args'],
            capture_output=True,
            text=True,
            timeout=2,
            encoding='utf-8',
            errors='replace',
        )

        if ps_result.returncode != 0:
            return None

        lines = ps_result.stdout.strip().split('\n')

        # プロセスツリーを構築
        processes = {}
        for line in lines[1:]:  # ヘッダー行をスキップ
            parts = line.strip().split(None, 3)
            if len(parts) >= 3:
                try:
                    pid = int(parts[0])
                    ppid = int(parts[1])
                    comm = parts[2]
                    args = parts[3] if len(parts) >= 4 else comm
                    processes[pid] = {'ppid': ppid, 'comm': comm, 'args': args}
                except ValueError:
                    continue

        # シェルプロセスの子孫を再帰的に検索
        def find_descendants(parent_pid, visited=None, depth=0):
            if visited is None:
                visited = set()

            # 最大再帰深度を制限
            if depth > 50:
                return []

            # 循環参照を検出して回避
            if parent_pid in visited:
                return []

            visited.add(parent_pid)
            descendants = []

            for pid, info in processes.items():
                if info['ppid'] == parent_pid and pid not in visited:
                    descendants.append(pid)
                    # 新しいvisitedセットを作成して再帰的に子孫を検索
                    child_descendants = find_descendants(
                        pid, visited.copy(), depth + 1
                    )
                    descendants.extend(child_descendants)

            return descendants

        descendants = find_descendants(shell_pid)

        # 子孫プロセスの中でCLIエージェントを検索
        for pid in descendants:
            if pid in processes:
                proc_info = processes[pid]
                comm_lower = proc_info['comm'].lower()
                args_lower = proc_info['args'].lower()
                
                # Claude の検出
                if 'claude' in comm_lower or 'claude' in args_lower:
                    return {'active': True, 'agent_type': 'claude'}
                
                # Gemini の検出
                if 'gemini' in comm_lower or 'gemini' in args_lower:
                    return {'active': True, 'agent_type': 'gemini'}

        return {'active': False, 'agent_type': None}

    except (
        subprocess.TimeoutExpired,
        subprocess.SubprocessError,
        FileNotFoundError,
    ):
        return {'active': False, 'agent_type': None}


def send_status_message(message_type, data):
    """ステータスメッセージをフロントエンドに送信"""
    try:
        message = {"type": message_type, "data": data}
        # JSON メッセージを特別なエスケープシーケンスで送信
        message_json = json.dumps(message)
        # CSI シーケンスを使用してカスタムメッセージを送信
        status_sequence = f'\x1b]777;{message_json}\x07'
        sys.stdout.buffer.write(status_sequence.encode('utf-8'))
        sys.stdout.buffer.flush()
    except Exception:
        pass


def main():
    # コマンドライン引数から初期設定を取得
    initial_cols = int(sys.argv[1]) if len(sys.argv) > 1 else 80
    initial_rows = int(sys.argv[2]) if len(sys.argv) > 2 else 24
    cwd = sys.argv[3] if len(sys.argv) > 3 else os.getcwd()
    
    # startup commands を安全に取得
    startup_commands = []
    if len(sys.argv) > 4 and sys.argv[4] == '--startup-commands':
        try:
            startup_commands = json.loads(sys.argv[5])
            # セキュリティチェック: 配列であることを確認
            if not isinstance(startup_commands, list):
                print(f"Warning: Invalid startup commands format, ignoring", file=sys.stderr)
                startup_commands = []
            else:
                # 各コマンドが文字列であることを確認
                startup_commands = [cmd for cmd in startup_commands if isinstance(cmd, str)]
        except (IndexError, json.JSONDecodeError) as e:
            print(f"Warning: Failed to parse startup commands: {e}", file=sys.stderr)
            startup_commands = []

    while True:  # シェルプロセスが終了したら再起動するループ
        # 環境変数を設定
        os.environ['TERM'] = 'xterm-256color'
        os.environ['COLUMNS'] = str(initial_cols)
        os.environ['LINES'] = str(initial_rows)

        # PTY を作成
        master, slave = pty.openpty()

        # ターミナルサイズを設定
        set_winsize(master, initial_rows, initial_cols)
        set_winsize(slave, initial_rows, initial_cols)

        # シェルプロセスを起動
        shell_cmd = [os.environ.get('SHELL', '/bin/zsh'), '-l', '-i']
        try:
            p = subprocess.Popen(
                shell_cmd,
                stdin=slave,
                stdout=slave,
                stderr=slave,
                preexec_fn=os.setsid,
                cwd=cwd,
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
                cwd=cwd,
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
            fcntl.fcntl(
                sys.stdin.fileno(), fcntl.F_SETFL, stdin_flags | os.O_NONBLOCK
            )
        except (ImportError, OSError):
            pass

        # CLI エージェント監視のための変数
        last_agent_check = 0
        current_agent_state = {'active': False, 'agent_type': None}
        check_interval = 2.0  # 2秒間隔でチェック

        # startup commands を実行
        startup_commands_executed = False
        startup_delay_time = time.time() + 1.0  # 1秒後に実行

        # メイン I/O ループ
        try:
            while p.poll() is None:
                current_time = time.time()
                
                # startup commands を実行（シェル起動から1秒後）
                if not startup_commands_executed and current_time >= startup_delay_time and startup_commands:
                    startup_commands_executed = True
                    for command in startup_commands:
                        if command.strip():
                            # コマンドを PTY に送信
                            command_with_newline = command + '\n'
                            os.write(master, command_with_newline.encode('utf-8'))
                            time.sleep(0.1)  # コマンド間に少し間隔を空ける
                
                # CLI エージェントアクティブチェック
                if current_time - last_agent_check >= check_interval:
                    new_agent_state = check_cli_agent_active(p.pid)
                    if new_agent_state and new_agent_state != current_agent_state:
                        current_agent_state = new_agent_state
                        send_status_message(
                            'cli_agent_status', current_agent_state
                        )
                    last_agent_check = current_time

                # 標準入力から PTY マスターへの入力を処理
                try:
                    ready, _, _ = select.select(
                        [sys.stdin, master], [], [], 0.1
                    )

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
                                    if text.startswith('\x1b[8;'):
                                        # ターミナルサイズ変更シーケンス
                                        try:
                                            if 't' in text:
                                                parts = text.split(';')
                                                if len(parts) >= 3:
                                                    rows = int(parts[1])
                                                    cols = int(
                                                        parts[2].rstrip('t')
                                                    )
                                                    set_winsize(
                                                        master, rows, cols
                                                    )
                                                    os.environ['LINES'] = str(
                                                        rows
                                                    )
                                                    os.environ['COLUMNS'] = (
                                                        str(cols)
                                                    )
                                                    # SIGWINCH をシェルに送信
                                                    if p.pid:
                                                        try:
                                                            os.killpg(
                                                                os.getpgid(
                                                                    p.pid
                                                                ),
                                                                signal.SIGWINCH,
                                                            )
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
            break  # Ctrl+C でループを抜ける
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

        # シェルが終了した場合、少し待ってから再起動
        if p.poll() is not None:
            sys.stdout.buffer.write(
                b'\r\n[Shell terminated. Restarting...]\r\n'
            )
            sys.stdout.buffer.flush()
            time.sleep(1)
        else:
            break  # 正常終了の場合はループを抜ける


if __name__ == '__main__':
    main()
