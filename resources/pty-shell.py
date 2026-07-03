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
import fcntl
import termios
import traceback

# I/O バッファサイズ定数（vim などの対話的アプリに優しいサイズに調整）
IO_BUFFER_SIZE = 1024


def set_winsize(fd, rows, cols):
    """ターミナルサイズを設定"""
    try:
        winsize = struct.pack('HHHH', rows, cols, 0, 0)
        fcntl.ioctl(fd, termios.TIOCSWINSZ, winsize)
    except OSError:
        pass


def get_process_snapshot():
    """ps を 1 回だけ実行してプロセステーブルのスナップショットを取得する。

    以前は pgrep をプロセスツリーのノード 1 つにつき 1 回 spawn しており、
    子孫プロセス数 N に比例して 3 秒ごとに O(N) 回のプロセス起動が発生していた。
    ps 1 回で全プロセスの pid/ppid/comm を取得し、メモリ上でツリーを構築する。

    戻り値: {pid: (ppid, comm)} の辞書。取得失敗時は空辞書。
    """
    try:
        r = subprocess.run(
            ['ps', '-axo', 'pid=,ppid=,comm='],
            capture_output=True,
            text=True,
            timeout=2,
            encoding='utf-8',
            errors='ignore',
        )
        if r.returncode != 0:
            return {}
        table = {}
        for line in r.stdout.splitlines():
            # comm はパスにスペースを含み得るため、先頭 2 フィールドのみ分割する
            parts = line.split(None, 2)
            if len(parts) < 3:
                continue
            try:
                table[int(parts[0])] = (int(parts[1]), parts[2])
            except ValueError:
                continue
        return table
    except (OSError, subprocess.TimeoutExpired, subprocess.SubprocessError):
        return {}


def list_descendants(table, root_pid, max_depth=5):
    """スナップショットから root_pid の子孫 PID を BFS で列挙する (深さ max_depth まで)。"""
    children = {}
    for pid, (ppid, _comm) in table.items():
        children.setdefault(ppid, []).append(pid)

    result = []
    queue = [(root_pid, 0)]
    seen = {root_pid}
    while queue:
        pid, depth = queue.pop(0)
        if depth >= max_depth:
            continue
        for c in children.get(pid, []):
            if c in seen:
                continue
            seen.add(c)
            result.append(c)
            queue.append((c, depth + 1))
    return result


def get_foreground_process_name(shell_pid, table):
    """シェルプロセスのフォアグラウンド子プロセス名を取得する。

    シェルの直接の子プロセスを探し、その名前を返す。
    子プロセスがない場合はシェル自体の名前を返す。
    """
    child_comms = [
        comm for pid, (ppid, comm) in table.items() if ppid == shell_pid
    ]
    if child_comms:
        # 最後の (最新の) 子プロセスの名前を取得
        process_name = child_comms[-1]
    elif shell_pid in table:
        process_name = table[shell_pid][1]
    else:
        return None

    if '/' in process_name:
        process_name = os.path.basename(process_name)
    return process_name


def check_cli_agent_active(shell_pid, table):
    """シェルプロセス配下で CLI エージェント（Claude, Gemini, Codex, Copilot）の稼働有無を軽量に判定する。

    プロセステーブルのスナップショット (get_process_snapshot) から子孫 PID を求め、
    その PID 群に限定した ps 呼び出し (50 件ずつ) で args を取得して判定する。
    """
    try:
        descendants = list_descendants(table, shell_pid)

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
                    [
                        'ps',
                        '-o',
                        'comm=,args=',
                        '-p',
                        ','.join(str(x) for x in chunk),
                    ],
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
                    # 先頭のコマンド名と残りを args として分離
                    parts = line.strip().split(None, 1)
                    comm = parts[0].lower() if parts else ''
                    args = parts[1].lower() if len(parts) > 1 else ''

                    # Claude 検出
                    if 'claude' in comm or ' claude ' in args:
                        return {'active': True, 'agent_type': 'claude'}
                    # Gemini 検出
                    if (
                        '/bin/gemini' in args
                        or ' gemini ' in args
                        or comm == 'gemini'
                    ):
                        return {'active': True, 'agent_type': 'gemini'}
                    # Codex 検出
                    if (
                        'codex' in comm
                        or ' codex ' in args
                        or '/bin/codex' in args
                    ):
                        return {'active': True, 'agent_type': 'codex'}
                    # Copilot 検出
                    if (
                        'copilot' in comm
                        or ' copilot ' in args
                        or '/bin/copilot' in args
                    ):
                        return {'active': True, 'agent_type': 'copilot'}
            except (
                subprocess.TimeoutExpired,
                subprocess.SubprocessError,
                FileNotFoundError,
            ):
                continue

        return {'active': False, 'agent_type': None}
    except Exception as e:
        # 想定外のエラーは検出無効として扱う (内容はフロント経由でログに残す)
        log(
            f'[check_cli_agent_active] {e.__class__.__name__}: {e}\n'
            f'{traceback.format_exc()}'
        )
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
    except (TypeError, ValueError, OSError):
        # JSON 化できないデータ、または stdout (拡張ホストへのパイプ) の破損。
        # ログの送り先自体が stdout なので、ここで通知する手段は無い。
        pass


def log(message):
    """
    フロントにログを送る
    """
    send_status_message('log', message)


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
                log(f"Warning: Invalid startup commands format, ignoring")
                startup_commands = []
            else:
                # 各コマンドが文字列であることを確認
                startup_commands = [
                    cmd for cmd in startup_commands if isinstance(cmd, str)
                ]
        except (IndexError, json.JSONDecodeError) as e:
            log(f"Warning: Failed to parse startup commands: {e}")
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
            log(f"Error during cleanup: {e.__class__.__name__}: {e}")

    def signal_handler(signum, frame):
        """シグナルハンドラー"""
        log(f"Received signal {signum}, cleaning up...")
        cleanup_handler()
        sys.exit(0)

    # シグナルハンドラーを設定
    signal.signal(signal.SIGTERM, signal_handler)
    signal.signal(signal.SIGINT, signal_handler)
    signal.signal(signal.SIGHUP, signal_handler)

    # atexit でクリーンアップを保証
    atexit.register(cleanup_handler)

    def setup_child_process():
        """子プロセスの初期化: 新しいセッションを作成"""
        # 新しいセッションを作成（プロセスグループリーダーになる）
        # macOS では pty.openpty() + setsid() で制御端末が自動設定される
        os.setsid()

    # 注: このループは末尾で必ず break するため 1 回しか実行されない。
    # シェル終了時の再起動は Node.js 側 (タブを閉じる処理) が担当する。
    while True:
        # 環境変数を設定
        os.environ['TERM'] = 'xterm-256color'
        os.environ['COLUMNS'] = str(initial_cols)
        os.environ['LINES'] = str(initial_rows)
        os.environ['TERM_PROGRAM'] = 'secondary-terminal'

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
                preexec_fn=setup_child_process,
                cwd=cwd,
            )
            current_shell_process = p  # グローバル変数に保存
        except (OSError, subprocess.SubprocessError) as e:
            log(
                'zsh launch failed, falling back to bash. '
                f'{e.__class__.__name__}: {e}\n{traceback.format_exc()}'
            )

            # zsh が失敗した場合は bash にフォールバック
            shell_cmd = ['/bin/bash', '-l', '-i']
            p = subprocess.Popen(
                shell_cmd,
                stdin=slave,
                stdout=slave,
                stderr=slave,
                preexec_fn=setup_child_process,
                cwd=cwd,
            )
            current_shell_process = p  # グローバル変数に保存

        os.close(slave)

        # 非ブロッキング I/O を設定
        try:
            # PTY マスターを非ブロッキングに設定
            flags = fcntl.fcntl(master, fcntl.F_GETFL)
            fcntl.fcntl(master, fcntl.F_SETFL, flags | os.O_NONBLOCK)

            # 標準入力も非ブロッキングに設定
            stdin_flags = fcntl.fcntl(sys.stdin.fileno(), fcntl.F_GETFL)
            fcntl.fcntl(
                sys.stdin.fileno(), fcntl.F_SETFL, stdin_flags | os.O_NONBLOCK
            )
        except OSError:
            log("fcntl: Warning: Failed to set non-blocking I/O")

        # CLI エージェント監視のための変数
        last_agent_check = 0
        # NULL での強制チェックにレート制限を導入（過剰な発火での高負荷を防止）
        last_forced_check = 0.0
        forced_check_cooldown = 1.5  # 秒
        current_agent_state = {'active': False, 'agent_type': None}
        check_interval = 3.0  # 3秒間隔に変更

        # フォアグラウンドプロセス監視のための変数
        last_fg_process_check = 0
        fg_process_check_interval = 1.0  # 1秒間隔
        current_fg_process = None

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

                # プロセス監視 (エージェント検出とフォアグラウンドプロセス名) は
                # 同じ ps スナップショットを共有し、プロセス起動回数を抑える
                need_agent_check = (
                    current_time - last_agent_check >= check_interval
                )
                need_fg_check = (
                    current_time - last_fg_process_check
                    >= fg_process_check_interval
                )
                if need_agent_check or need_fg_check:
                    process_table = get_process_snapshot()

                # CLI エージェントアクティブチェック（3秒間隔で実行）
                if need_agent_check:
                    # Claude や Gemini の検出を実行（負荷軽減のため3秒間隔）
                    new_agent_state = check_cli_agent_active(
                        p.pid, process_table
                    )
                    if (
                        new_agent_state
                        and new_agent_state != current_agent_state
                    ):
                        current_agent_state = new_agent_state
                        send_status_message(
                            'cli_agent_status', current_agent_state
                        )

                    last_agent_check = current_time

                # フォアグラウンドプロセス名チェック（1秒間隔）
                if need_fg_check:
                    new_fg_process = get_foreground_process_name(
                        p.pid, process_table
                    )
                    if new_fg_process and new_fg_process != current_fg_process:
                        current_fg_process = new_fg_process
                        send_status_message(
                            'foreground_process', {'name': current_fg_process}
                        )
                    last_fg_process_check = current_time

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

                                # 不正データが続いた場合の暴走防止 (通常は到達しない)
                                if len(input_buffer) > 65536:
                                    log(
                                        'Input buffer overflow, discarding '
                                        f'{len(input_buffer)} bytes'
                                    )
                                    input_buffer = b''

                                # UTF-8 incomplete sequence を考慮したデコード。
                                # デコードできる部分を全て排出し、末尾の不完全な
                                # マルチバイト列だけをバッファに残す。
                                text_parts = []
                                while input_buffer:
                                    try:
                                        text_parts.append(
                                            input_buffer.decode('utf-8')
                                        )
                                        input_buffer = b''
                                    except UnicodeDecodeError as e:
                                        # エラー開始位置より前は正常にデコードできる
                                        text_parts.append(
                                            input_buffer[: e.start].decode(
                                                'utf-8'
                                            )
                                        )
                                        if (
                                            e.reason
                                            == 'unexpected end of data'
                                        ):
                                            # マルチバイト文字の途中で分断されて
                                            # いる。続きのバイトを待つため残す。
                                            # (先頭バイトを捨てると分断された
                                            # 日本語や絵文字が丸ごと失われる)
                                            input_buffer = input_buffer[
                                                e.start :
                                            ]
                                            break
                                        # 本当に不正なバイトは 1 バイトだけ捨てて
                                        # 続きのデコードを試みる
                                        input_buffer = input_buffer[
                                            e.start + 1 :
                                        ]
                                text = ''.join(text_parts)

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
                                        if (
                                            current_time - last_forced_check
                                            >= forced_check_cooldown
                                        ):
                                            new_agent_state = (
                                                check_cli_agent_active(
                                                    p.pid,
                                                    get_process_snapshot(),
                                                )
                                            )
                                            if new_agent_state:
                                                current_agent_state = (
                                                    new_agent_state
                                                )
                                                send_status_message(
                                                    'cli_agent_status',
                                                    current_agent_state,
                                                )
                                                last_agent_check = current_time
                                                last_forced_check = (
                                                    current_time
                                                )
                                        text = text.replace('\x00', '')

                                    # リサイズシーケンスを全て処理し、入力から取り除く
                                    # パターン: ESC [ 8 ; rows ; cols t
                                    resize_pattern = re.compile(
                                        r"\x1b\[8;(\d+);(\d+)t"
                                    )

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
                                        # 注: 起動済みのシェルの環境変数は変更
                                        # できないため os.environ の更新は行わない。
                                        # サイズ通知は ioctl と SIGWINCH で足りる。
                                        # シェルへウィンドウサイズ変更通知
                                        if p.pid:
                                            try:
                                                os.killpg(
                                                    os.getpgid(p.pid),
                                                    signal.SIGWINCH,
                                                )
                                            except OSError:
                                                pass

                                    # テキストから全てのリサイズシーケンスを除去しつつ適用
                                    tail = 0
                                    cleaned_parts = []
                                    for m in resize_pattern.finditer(text):
                                        # マッチ前の通常テキストを溜める
                                        if m.start() > tail:
                                            cleaned_parts.append(
                                                text[tail : m.start()]
                                            )
                                        # マッチ処理
                                        handle_resize_match(m)
                                        tail = m.end()
                                    # 最後の残り
                                    if tail < len(text):
                                        cleaned_parts.append(text[tail:])
                                    cleaned_text = ''.join(cleaned_parts)

                                    # 通常テキストを PTY に送信（大量データは分割して送信）
                                    if cleaned_text:
                                        # 大量データ（1KB超）は vim などの対話的アプリのためチャンク分割
                                        if len(cleaned_text) > 1024:
                                            # 512バイトずつ分割して送信
                                            for i in range(
                                                0, len(cleaned_text), 512
                                            ):
                                                chunk = cleaned_text[
                                                    i : i + 512
                                                ]
                                                try:
                                                    os.write(
                                                        master,
                                                        chunk.encode(
                                                            'utf-8',
                                                            errors='ignore',
                                                        ),
                                                    )
                                                    # チャンク間に短い遅延（vim の処理時間確保）
                                                    if i + 512 < len(
                                                        cleaned_text
                                                    ):
                                                        time.sleep(
                                                            0.01
                                                        )  # 10ms
                                                except OSError as e:
                                                    # EAGAIN などの場合は少し待ってリトライ
                                                    if e.errno == errno.EAGAIN:
                                                        time.sleep(0.05)
                                                        try:
                                                            os.write(
                                                                master,
                                                                chunk.encode(
                                                                    'utf-8',
                                                                    errors='ignore',
                                                                ),
                                                            )
                                                        except OSError:
                                                            # 2回目も失敗したら諦める
                                                            pass
                                                    else:
                                                        # EAGAIN 以外のエラーは再発生させる
                                                        raise
                                        else:
                                            # 小さなデータはそのまま送信
                                            # (EAGAIN 時は 1 回だけリトライする)
                                            encoded = cleaned_text.encode(
                                                'utf-8', errors='ignore'
                                            )
                                            try:
                                                os.write(master, encoded)
                                            except OSError as e:
                                                if e.errno == errno.EAGAIN:
                                                    time.sleep(0.05)
                                                    try:
                                                        os.write(
                                                            master, encoded
                                                        )
                                                    except OSError:
                                                        pass
                                                else:
                                                    raise
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
                                # バイト列をそのまま転送する。
                                # UTF-8 のデコードはフロントエンド (xterm.js) が
                                # ストリームとして行うため、ここで decode すると
                                # バッファ境界で分断されたマルチバイト文字を
                                # 破損させてしまう (errors='ignore' は不完全な
                                # 末尾バイト列を黙って捨てる)。
                                sys.stdout.buffer.write(data)
                                sys.stdout.buffer.flush()
                        except OSError as e:
                            # EAGAIN は PTY バッファが空なので無視
                            if e.errno == errno.EAGAIN:
                                pass
                            elif e.errno in (errno.EIO, errno.ENXIO):
                                # PTY が閉じられた場合はループを抜ける
                                break
                            # その他のエラーも基本的に無視（安定性向上）

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
                        # SIGKILL 後にゾンビを回収する
                        current_shell_process.wait(timeout=1)
                except (OSError, subprocess.TimeoutExpired):
                    pass
            finally:
                current_shell_process = None

        # シェルが終了した場合、スクリプトも終了（タブを閉じる処理はNode.js側で行う）
        if p.poll() is not None:
            sys.stdout.buffer.write(
                b'\r\n[Shell terminated.]\r\n'
            )
            sys.stdout.buffer.flush()
        break  # ループを抜けてスクリプト終了


if __name__ == '__main__':
    main()
