#!/usr/bin/env python3
import pty
import os
import sys
import subprocess
import signal
import struct
import select
import time

def set_winsize(fd, rows, cols):
    """ターミナルサイズを設定"""
    try:
        import termios
        winsize = struct.pack('HHHH', rows, cols, 0, 0)
        import fcntl
        fcntl.ioctl(fd, termios.TIOCSWINSZ, winsize)
    except (ImportError, OSError):
        pass

def main():
    # コマンドライン引数から初期設定を取得
    initial_cols = int(sys.argv[1]) if len(sys.argv) > 1 else 80
    initial_rows = int(sys.argv[2]) if len(sys.argv) > 2 else 24
    cwd = sys.argv[3] if len(sys.argv) > 3 else os.getcwd()
    
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
                cwd=cwd
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
                cwd=cwd
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
            fcntl.fcntl(sys.stdin.fileno(), fcntl.F_SETFL, stdin_flags | os.O_NONBLOCK)
        except (ImportError, OSError):
            pass
        
        # メイン I/O ループ
        try:
            while p.poll() is None:
                # 標準入力から PTY マスターへの入力を処理
                try:
                    ready, _, _ = select.select([sys.stdin, master], [], [], 0.1)
                    
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
                                                    cols = int(parts[2].rstrip('t'))
                                                    set_winsize(master, rows, cols)
                                                    os.environ['LINES'] = str(rows)
                                                    os.environ['COLUMNS'] = str(cols)
                                                    # SIGWINCH をシェルに送信
                                                    if p.pid:
                                                        try:
                                                            os.killpg(os.getpgid(p.pid), signal.SIGWINCH)
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
            sys.stdout.buffer.write(b'\r\n[Shell terminated. Restarting...]\r\n')
            sys.stdout.buffer.flush()
            time.sleep(1)
        else:
            break  # 正常終了の場合はループを抜ける

if __name__ == '__main__':
    main()