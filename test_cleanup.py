#\!/usr/bin/env python3
import subprocess
import time
import signal
import os

def test_pty_cleanup():
    """PTY スクリプトのクリーンアップ処理をテスト"""
    print("Testing PTY cleanup behavior...")
    
    # PTY プロセスを起動
    proc = subprocess.Popen([
        'python3', 'resources/pty-shell.py', '80', '24', os.getcwd()
    ], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    
    print(f"Started PTY process with PID: {proc.pid}")
    
    # 少し待つ
    time.sleep(2)
    
    # プロセスがまだ動いているか確認
    if proc.poll() is None:
        print("PTY process is running")
        
        # SIGTERM で終了を試す
        print("Sending SIGTERM...")
        proc.terminate()
        
        # 終了を待つ
        try:
            proc.wait(timeout=5)
            print("Process terminated gracefully")
        except subprocess.TimeoutExpired:
            print("Process did not terminate gracefully, force killing...")
            proc.kill()
            proc.wait()
            print("Process force killed")
    else:
        print("Process already terminated")
    
    print("Test completed")

if __name__ == '__main__':
    test_pty_cleanup()
