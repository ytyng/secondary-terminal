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
import atexit
import errno
import re

# I/O バッファサイズ定数
IO_BUFFER_SIZE = 8092


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
    """シェルプロセス配下で CLI エージェント（Claude, Gemini）の稼働有無を軽量に判定する。

    以前は `ps -eo pid,ppid,comm,args` で全プロセスを列挙していたが、
    環境によっては出力が大きくなり、3秒ごとの実行でも徐々に CPU 使用率が上がる可能性があった。
    ここでは pgrep を用いた親子探索(BFS)と、対象 PID 群に限定した ps 呼び出しにより負荷を抑える。
    """
    try:
        # BFS で深さ5までの子孫 PID を列挙
        def list_children(parent_pid):
            try:
                r = subprocess.run(
                    ['pgrep', '-P', str(parent_pid)],
                    capture_output=True,
                    text=True,
                    timeout=1,
                    encoding='utf-8',
                    errors='ignore',
                )
                if r.returncode not in (0, 1):
                    return []
                lines = r.stdout.strip().split('\n') if r.stdout else []
                result = []
                for line in lines:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        result.append(int(line))
                    except ValueError:
                        pass
                return result
            except (subprocess.TimeoutExpired, subprocess.SubprocessError, FileNotFoundError):
                return []

        max_depth = 5
        descendants = []
        queue = [(shell_pid, 0)]
        seen = {shell_pid}

        while queue:
            pid, depth = queue.pop(0)
            if depth >= max_depth:
                continue
            for c in list_children(pid):
                if c in seen:
                    continue
                seen.add(c)
                descendants.append(c)
                queue.append((c, depth + 1))

        if not descendants:
            return {'active': False, 'agent_type': None}

        # 収集した子孫 PID だけを対象に、最小限の ps で詳細を取得
        # macOS の ps は複数 PID をカンマ区切りで受け付ける
        def batched(iterable, size):
            it = iter(iterable)
            while True:
                chunk = []
                try:
                    for _ in range(size):
                        chunk.append(next(it))
                except StopIteration:
                    if chunk:
                        yield chunk
                    break
                yield chunk

        for chunk in batched(descendants, 50):
            try:
                r = subprocess.run(
                    ['ps', '-o', 'comm=,args=', '-p', ','.join(str(x) for x in chunk)],
                    capture_output=True,
                    text=True,
                    timeout=1,
                    encoding='utf-8',
                    errors='ignore',
                )
                if r.returncode != 0:
                    continue
                for line in r.stdout.splitlines():
                    if not line.strip():
                        continue
                    # comm と args はスペース区切りだが、args はスペースを含む。
                    # 'comm=,args=' により先頭フィールドはコマンド名のみ、それ以降を args として扱える。
                    try:
                        # 先頭のコマンド名と残りを args として分離
                        parts = line.strip().split(None, 1)
                        comm = parts[0].lower() if parts else ''
                        args = parts[1].lower() if len(parts) > 1 else ''

                        if 'claude' in comm:
                            return {'active': True, 'agent_type': 'claude'}
                        if '/bin/gemini' in args:
                            return {'active': True, 'agent_type': 'gemini'}
                    except Exception:
                        # 行のパース失敗は無視して続行
                        continue
            except (subprocess.TimeoutExpired, subprocess.SubprocessError, FileNotFoundError):
                continue

        return {'active': False, 'agent_type': None}
    except Exception:
        # 想定外のエラーは検出無効として扱う
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
                print(
                    f"Warning: Invalid startup commands format, ignoring",
                    file=sys.stderr,
                )
                startup_commands = []
            else:
                # 各コマンドが文字列であることを確認
                startup_commands = [
                    cmd for cmd in startup_commands if isinstance(cmd, str)
                ]
        except (IndexError, json.JSONDecodeError) as e:
            print(
                f"Warning: Failed to parse startup commands: {e}",
                file=sys.stderr,
            )
            startup_commands = []

    # グローバル変数でプロセス参照を保持
    global current_shell_process, current_master
    current_shell_process = None
    current_master = None

    def cleanup_handler():
        """プロセス終了時のクリーンアップ処理"""
        try:
            if current_shell_process and current_shell_process.poll() is None:
                # シェルプロセスとそのプロセスグループを終了
                try:
                    os.killpg(
                        os.getpgid(current_shell_process.pid), signal.SIGTERM
                    )
                    # 少し待って強制終了
                    time.sleep(0.5)
                    if current_shell_process.poll() is None:
                        os.killpg(
                            os.getpgid(current_shell_process.pid),
                            signal.SIGKILL,
                        )
                except (OSError, ProcessLookupError):
                    pass

            if current_master:
                try:
                    os.close(current_master)
                except OSError:
                    pass

        except Exception as e:
            print(f"Error during cleanup: {e}", file=sys.stderr)

    def signal_handler(signum, frame):
        """シグナルハンドラー"""
        print(f"Received signal {signum}, cleaning up...", file=sys.stderr)
        cleanup_handler()
        sys.exit(0)

    # シグナルハンドラーを設定
    signal.signal(signal.SIGTERM, signal_handler)
    signal.signal(signal.SIGINT, signal_handler)
    signal.signal(signal.SIGHUP, signal_handler)

    # atexit でクリーンアップを保証
    atexit.register(cleanup_handler)

    while True:  # シェルプロセスが終了したら再起動するループ
        # 環境変数を設定
        os.environ['TERM'] = 'xterm-256color'
        os.environ['COLUMNS'] = str(initial_cols)
        os.environ['LINES'] = str(initial_rows)

        # PTY を作成
        master, slave = pty.openpty()
        current_master = master  # グローバル変数に保存

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
            current_shell_process = p  # グローバル変数に保存
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
            current_shell_process = p  # グローバル変数に保存

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
        # NULL での強制チェックにレート制限を導入（過剰な発火での高負荷を防止）
        last_forced_check = 0.0
        forced_check_cooldown = 1.5  # 秒
        current_agent_state = {'active': False, 'agent_type': None}
        check_interval = 3.0  # 3秒間隔に変更

        # UTF-8 デコード用のバッファ（マルチバイト文字の分割対応）
        input_buffer = b''
        # stdin が EOF/クローズされたかどうかのフラグ（EOF 後は select 対象から外してスピンを防ぐ）
        stdin_open = True

        # startup commands を実行
        startup_commands_executed = False
        startup_delay_time = time.time() + 1.0  # 1秒後に実行

        # メイン I/O ループ
        try:
            while p.poll() is None:
                current_time = time.time()

                # startup commands を実行（シェル起動から1秒後）
                if (
                    not startup_commands_executed
                    and current_time >= startup_delay_time
                    and startup_commands
                ):
                    startup_commands_executed = True
                    for command in startup_commands:
                        if command.strip():
                            # コマンドを PTY に送信
                            command_with_newline = command + '\n'
                            os.write(
                                master, command_with_newline.encode('utf-8')
                            )
                            time.sleep(0.1)  # コマンド間に少し間隔を空ける

                # CLI エージェントアクティブチェック（3秒間隔で実行）
                if current_time - last_agent_check >= check_interval:
                    # Claude や Gemini の検出を実行（負荷軽減のため3秒間隔）
                    new_agent_state = check_cli_agent_active(p.pid)
                    if (
                        new_agent_state
                        and new_agent_state != current_agent_state
                    ):
                        current_agent_state = new_agent_state
                        send_status_message(
                            'cli_agent_status', current_agent_state
                        )
                    last_agent_check = current_time

                # 標準入力から PTY マスターへの入力を処理
                try:
                    read_fds = [master]
                    if stdin_open:
                        read_fds.append(sys.stdin)
                    ready, _, _ = select.select(read_fds, [], [], 1.0)

                    if stdin_open and sys.stdin in ready:
                        # Node.js からの入力を読み取り（非ブロッキング）
                        try:
                            # バイナリデータとして読み取り
                            data = os.read(sys.stdin.fileno(), IO_BUFFER_SIZE)
                            if not data:
                                # EOF（パイプが閉じられた）。以後 stdin を監視しない。
                                stdin_open = False
                            else:
                                # 前回の未完成バイト列と結合
                                input_buffer += data

                                # UTF-8 incomplete sequence を考慮したデコード
                                text = ''
                                try:
                                    # 全体をデコードしてみる
                                    text = input_buffer.decode('utf-8')
                                    # 成功したらバッファをクリア
                                    input_buffer = b''
                                except UnicodeDecodeError as e:
                                    # デコードエラーが発生した場合、完全にデコードできる部分だけを取り出す
                                    if e.start > 0:
                                        # エラー開始位置より前は正常にデコードできる
                                        text = input_buffer[: e.start].decode('utf-8')
                                        # 未処理部分をバッファに残す
                                        input_buffer = input_buffer[e.start :]
                                    else:
                                        # 先頭からエラーの場合、1文字分進めて再試行（破損データの回避）
                                        if len(input_buffer) > 1:
                                            input_buffer = input_buffer[1:]
                                        text = ''

                                if text:
                                    #
                                    # NOTE: WebView 側からの resize 通知は、
                                    # '\x1b[8;{rows};{cols}t' のエスケープシーケンスとして
                                    # 本プロセスの stdin に流入する。
                                    # これがユーザー入力（ペースト）に混在した場合、
                                    # 先頭一致のみの判定だと後続テキストが破棄され得る。
                                    # そのため、テキスト中の全シーケンスを検出して処理し、
                                    # 残余の通常テキストだけを PTY に流す。
                                    #

                                    # CLI Agent ステータス強制チェック信号を検出し、取り除く
                                    if '\x00' in text:
                                        # NULL 文字は取り除いたうえで残余を処理する
                                        if current_time - last_forced_check >= forced_check_cooldown:
                                            new_agent_state = check_cli_agent_active(p.pid)
                                            if new_agent_state:
                                                current_agent_state = new_agent_state
                                                send_status_message('cli_agent_status', current_agent_state)
                                                last_agent_check = current_time
                                                last_forced_check = current_time
                                        text = text.replace('\x00', '')

                                    # リサイズシーケンスを全て処理し、入力から取り除く
                                    # パターン: ESC [ 8 ; rows ; cols t
                                    resize_pattern = re.compile(r"\x1b\[8;(\d+);(\d+)t")

                                    def handle_resize_match(m: re.Match[str]):
                                        """リサイズ指示を反映する。
                                        rows, cols は xterm の CSI 8 ; rows ; cols t に対応。
                                        """
                                        try:
                                            rows = int(m.group(1))
                                            cols = int(m.group(2))
                                        except (ValueError, IndexError):
                                            return
                                        set_winsize(master, rows, cols)
                                        os.environ['LINES'] = str(rows)
                                        os.environ['COLUMNS'] = str(cols)
                                        # シェルへウィンドウサイズ変更通知
                                        if p.pid:
                                            try:
                                                os.killpg(os.getpgid(p.pid), signal.SIGWINCH)
                                            except OSError:
                                                pass

                                    # テキストから全てのリサイズシーケンスを除去しつつ適用
                                    tail = 0
                                    cleaned_parts = []
                                    for m in resize_pattern.finditer(text):
                                        # マッチ前の通常テキストを溜める
                                        if m.start() > tail:
                                            cleaned_parts.append(text[tail:m.start()])
                                        # マッチ処理
                                        handle_resize_match(m)
                                        tail = m.end()
                                    # 最後の残り
                                    if tail < len(text):
                                        cleaned_parts.append(text[tail:])
                                    cleaned_text = ''.join(cleaned_parts)

                                    # 通常テキストを PTY に送信
                                    if cleaned_text:
                                        os.write(
                                            master,
                                            cleaned_text.encode('utf-8', errors='ignore'),
                                        )
                                else:
                                    # デコードされたテキストがない場合は何もしない（バッファに残っている）
                                    pass
                        except OSError as e:
                            # EAGAIN は未準備、EIO/ENXIO などは実質クローズとみなす
                            if e.errno in (errno.EIO, errno.ENXIO):
                                stdin_open = False
                            # その他は無視
                            pass

                    if master in ready:
                        # PTY からの出力を読み取り
                        try:
                            data = os.read(master, IO_BUFFER_SIZE)
                            if data:
                                # UTF-8 でデコードしてから再エンコード（文字化け対策）
                                try:
                                    decoded_text = data.decode('utf-8', errors='ignore')
                                    encoded_data = decoded_text.encode('utf-8')
                                    sys.stdout.buffer.write(encoded_data)
                                    sys.stdout.buffer.flush()
                                except (UnicodeDecodeError, UnicodeEncodeError):
                                    # エラー時はバイナリデータをそのまま送信
                                    sys.stdout.buffer.write(data)
                                    sys.stdout.buffer.flush()
                        except OSError:
                            pass

                except (select.error, OSError):
                    time.sleep(0.1)  # CPU 負荷軽減のため少し長めに待機

        except KeyboardInterrupt:
            break  # Ctrl+C でループを抜ける
        finally:
            # PTY を閉じる
            try:
                if current_master:
                    os.close(current_master)
                    current_master = None
            except OSError:
                pass

            # プロセスを終了
            try:
                if (
                    current_shell_process
                    and current_shell_process.poll() is None
                ):
                    os.killpg(
                        os.getpgid(current_shell_process.pid), signal.SIGTERM
                    )
                    current_shell_process.wait(timeout=2)
            except (OSError, subprocess.TimeoutExpired):
                try:
                    if current_shell_process:
                        os.killpg(
                            os.getpgid(current_shell_process.pid),
                            signal.SIGKILL,
                        )
                except OSError:
                    pass
            finally:
                current_shell_process = None

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
