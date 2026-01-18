use std::env;
use std::ffi::CString;
use std::io::{Read, Write};
use std::os::fd::{AsRawFd, FromRawFd, RawFd};
use std::process::Command;
use std::thread;
use std::time::{Duration, Instant};

#[cfg(target_os = "macos")]
const TIOCSWINSZ: libc::c_ulong = 0x80087467;
#[cfg(target_os = "linux")]
const TIOCSWINSZ: libc::c_ulong = 0x5414;

#[repr(C)]
struct WinSize {
    ws_row: libc::c_ushort,
    ws_col: libc::c_ushort,
    ws_xpixel: libc::c_ushort,
    ws_ypixel: libc::c_ushort,
}

extern "C" {
    fn openpty(
        amaster: *mut libc::c_int,
        aslave: *mut libc::c_int,
        name: *mut libc::c_char,
        termp: *const libc::termios,
        winp: *const WinSize,
    ) -> libc::c_int;
}

fn set_winsize(fd: RawFd, rows: u16, cols: u16) {
    let ws = WinSize {
        ws_row: rows,
        ws_col: cols,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };
    unsafe {
        libc::ioctl(fd, TIOCSWINSZ, &ws);
    }
}

fn send_agent_status_message<W: Write>(mut out: W, active: bool, agent_type: Option<&str>) {
    let agent = match agent_type {
        Some(t) => format!("\"{}\"", t),
        None => "null".to_string(),
    };
    let msg = format!(
        "{{\"type\":\"cli_agent_status\",\"data\":{{\"active\":{},\"agent_type\":{}}}}}",
        active, agent
    );
    let seq = format!("\x1b]777;{}\x07", msg);
    let _ = out.write_all(seq.as_bytes());
    let _ = out.flush();
}

fn send_fg_process_message<W: Write>(mut out: W, name: &str) {
    let msg = format!(
        "{{\"type\":\"foreground_process\",\"data\":{{\"name\":\"{}\"}}}}",
        name
    );
    let seq = format!("\x1b]777;{}\x07", msg);
    let _ = out.write_all(seq.as_bytes());
    let _ = out.flush();
}

fn get_foreground_process_name(shell_pid: i32) -> Option<String> {
    // Get direct children of shell
    let children = list_children(shell_pid);
    if !children.is_empty() {
        // Get the last (newest) child process name
        for &child_pid in children.iter().rev() {
            if let Ok(o) = Command::new("ps")
                .args(["-p", &child_pid.to_string(), "-o", "comm="])
                .output()
            {
                if o.status.success() {
                    let name = String::from_utf8_lossy(&o.stdout).trim().to_string();
                    if !name.is_empty() {
                        // Extract basename if path
                        let basename = name.rsplit('/').next().unwrap_or(&name);
                        return Some(basename.to_string());
                    }
                }
            }
        }
    }

    // No child process, return shell itself
    if let Ok(o) = Command::new("ps")
        .args(["-p", &shell_pid.to_string(), "-o", "comm="])
        .output()
    {
        if o.status.success() {
            let name = String::from_utf8_lossy(&o.stdout).trim().to_string();
            if !name.is_empty() {
                let basename = name.rsplit('/').next().unwrap_or(&name);
                return Some(basename.to_string());
            }
        }
    }
    None
}

fn list_children(pid: i32) -> Vec<i32> {
    let out = Command::new("pgrep").arg("-P").arg(pid.to_string()).output();
    if let Ok(o) = out {
        if o.status.success() {
            let s = String::from_utf8_lossy(&o.stdout);
            return s
                .lines()
                .filter_map(|l| l.trim().parse::<i32>().ok())
                .collect();
        }
    }
    vec![]
}

fn check_cli_agent_active(shell_pid: i32) -> (bool, Option<String>) {
    let mut descendants = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut queue = std::collections::VecDeque::new();
    seen.insert(shell_pid);
    queue.push_back((shell_pid, 0));
    let max_depth = 5;
    while let Some((pid, depth)) = queue.pop_front() {
        if depth >= max_depth {
            continue;
        }
        for c in list_children(pid) {
            if seen.insert(c) {
                descendants.push(c);
                queue.push_back((c, depth + 1));
            }
        }
    }
    if descendants.is_empty() {
        return (false, None);
    }
    for chunk in descendants.chunks(50) {
        let pids = chunk
            .iter()
            .map(|x| x.to_string())
            .collect::<Vec<_>>()
            .join(",");
        if let Ok(o) = Command::new("ps")
            .args(["-o", "comm=,args=", "-p"])
            .arg(pids)
            .output()
        {
            if !o.status.success() {
                continue;
            }
            let s = String::from_utf8_lossy(&o.stdout);
            for line in s.lines() {
                let mut parts = line.trim().split_whitespace();
                if let Some(comm) = parts.next() {
                    let args = parts.next().unwrap_or("").to_lowercase();
                    let comm_l = comm.to_lowercase();
                    if comm_l.contains("claude") {
                        return (true, Some("claude".into()));
                    }
                    if args.contains("/bin/gemini")
                        || args.contains(" gemini ")
                        || comm_l == "gemini"
                    {
                        return (true, Some("gemini".into()));
                    }
                    if comm_l.contains("codex") || args.contains("/bin/codex") {
                        return (true, Some("codex".into()));
                    }
                }
            }
        }
    }
    (false, None)
}

fn main() {
    let args: Vec<String> = env::args().collect();
    let cols: u16 = args.get(1).and_then(|s| s.parse().ok()).unwrap_or(80);
    let rows: u16 = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(24);
    let cwd = args.get(3).map(|s| s.as_str()).unwrap_or(".");

    let mut startup_commands: Vec<String> = Vec::new();
    if args.get(4).map(|s| s.as_str()) == Some("--startup-commands") {
        if let Some(json) = args.get(5) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(json) {
                if let Some(arr) = v.as_array() {
                    for item in arr {
                        if let Some(s) = item.as_str() {
                            startup_commands.push(s.to_string());
                        }
                    }
                }
            }
        }
    }

    // PTY 作成
    let mut master: libc::c_int = -1;
    let mut slave: libc::c_int = -1;
    let ws = WinSize {
        ws_row: rows,
        ws_col: cols,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };
    let rc = unsafe {
        openpty(
            &mut master as *mut _,
            &mut slave as *mut _,
            std::ptr::null_mut(),
            std::ptr::null(),
            &ws as *const _,
        )
    };
    if rc != 0 {
        eprintln!("openpty failed");
        std::process::exit(1);
    }

    unsafe {
        libc::fcntl(master, libc::F_SETFL, libc::O_NONBLOCK);
        libc::fcntl(0, libc::F_SETFL, libc::O_NONBLOCK);
    }

    // fork
    let pid = unsafe { libc::fork() };
    if pid < 0 {
        eprintln!("fork failed");
        std::process::exit(1);
    }
    if pid == 0 {
        // child
        unsafe {
            libc::setsid();
            libc::ioctl(slave, libc::TIOCSCTTY.into(), 0);
            libc::dup2(slave, 0);
            libc::dup2(slave, 1);
            libc::dup2(slave, 2);
        }
        if slave > 2 {
            unsafe {
                libc::close(slave);
            }
        }
        if master >= 0 {
            unsafe {
                libc::close(master);
            }
        }
        let _ = env::set_current_dir(cwd);
        env::set_var("TERM", "xterm-256color");
        let shell = env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
        let c_shell = CString::new(shell.clone())
            .unwrap_or_else(|_| CString::new("/bin/zsh").unwrap());
        let arg0 = c_shell.clone();
        let a1 = CString::new("-l").unwrap();
        let a2 = CString::new("-i").unwrap();
        unsafe {
            libc::execlp(
                c_shell.as_ptr(),
                arg0.as_ptr(),
                a1.as_ptr(),
                a2.as_ptr(),
                std::ptr::null::<libc::c_char>(),
            );
            let bash = CString::new("/bin/bash").unwrap();
            let b0 = CString::new("bash").unwrap();
            libc::execlp(
                bash.as_ptr(),
                b0.as_ptr(),
                a1.as_ptr(),
                a2.as_ptr(),
                std::ptr::null::<libc::c_char>(),
            );
            libc::exit(127);
        }
    }

    // parent
    unsafe {
        libc::close(slave);
    }
    let mut master_file = unsafe { std::fs::File::from_raw_fd(master) };

    // スタートアップコマンドは 1 秒後に順次投入
    if !startup_commands.is_empty() {
        let mut master_clone = master_file.try_clone().unwrap();
        let cmds = startup_commands.clone();
        thread::spawn(move || {
            thread::sleep(Duration::from_millis(1000));
            for (i, cmd) in cmds.iter().enumerate() {
                thread::sleep(Duration::from_millis((i as u64) * 100));
                let _ = master_clone.write_all(format!("{}\n", cmd).as_bytes());
            }
        });
    }

    // CLI Agent 監視
    let mut last_agent_check = Instant::now() - Duration::from_secs(10);
    let mut last_state: (bool, Option<String>) = (false, None);

    // フォアグラウンドプロセス監視
    let mut last_fg_check = Instant::now() - Duration::from_secs(10);
    let mut last_fg_process: Option<String> = None;

    // I/O ループ
    let mut stdin_buf = [0u8; 8192];
    let mut pty_buf = [0u8; 8192];
    let mut out = std::io::stdout();
    loop {
        // 子が死んだか？
        let mut status: libc::c_int = 0;
        let r = unsafe { libc::waitpid(pid, &mut status as *mut _, libc::WNOHANG) };
        if r == pid {
            break;
        }

        // 3 秒おきにエージェント確認
        if last_agent_check.elapsed() >= Duration::from_secs(3) {
            let state = check_cli_agent_active(pid);
            if state != last_state {
                send_agent_status_message(&mut out, state.0, state.1.as_deref());
                last_state = state;
            }
            last_agent_check = Instant::now();
        }

        // 1 秒おきにフォアグラウンドプロセス確認
        if last_fg_check.elapsed() >= Duration::from_secs(1) {
            let fg_process = get_foreground_process_name(pid);
            if fg_process != last_fg_process {
                if let Some(ref name) = fg_process {
                    send_fg_process_message(&mut out, name);
                }
                last_fg_process = fg_process;
            }
            last_fg_check = Instant::now();
        }

        // select
        let mut rfds: libc::fd_set = unsafe { std::mem::zeroed() };
        unsafe {
            libc::FD_ZERO(&mut rfds);
            libc::FD_SET(0, &mut rfds);
            libc::FD_SET(master_file.as_raw_fd(), &mut rfds);
        }
        let mut tv = libc::timeval {
            tv_sec: 0,
            tv_usec: 300_000,
        };
        let nfds = if master_file.as_raw_fd() > 0 {
            master_file.as_raw_fd() + 1
        } else {
            1 + 1
        };
        let sel = unsafe {
            libc::select(
                nfds,
                &mut rfds,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                &mut tv,
            )
        };
        if sel < 0 {
            continue;
        }

        // stdin → pty
        if unsafe { libc::FD_ISSET(0, &mut rfds) } {
            if let Ok(n) = std::io::stdin().read(&mut stdin_buf) {
                if n > 0 {
                    let mut slice = &stdin_buf[..n];
                    // 強制チェック: NULL を検出
                    let mut owned_buf: Option<Vec<u8>> = None;
                    if slice.contains(&0u8) {
                        let filtered: Vec<u8> =
                            slice.iter().copied().filter(|b| *b != 0u8).collect();
                        let state = check_cli_agent_active(pid);
                        send_agent_status_message(&mut out, state.0, state.1.as_deref());
                        last_agent_check = Instant::now();
                        owned_buf = Some(filtered);
                    }
                    if let Some(ref v) = owned_buf {
                        slice = &v[..];
                    }
                    // リサイズシーケンス
                    if slice.starts_with(b"\x1b[8;") {
                        if let Some(pos) = slice.iter().position(|b| *b == b't') {
                            let body = &slice[3..pos]; // after '\x1b[8'
                            let parts: Vec<&[u8]> = body.split(|b| *b == b';').collect();
                            if parts.len() >= 2 {
                                if let (Ok(r), Ok(c)) = (
                                    std::str::from_utf8(parts[0]).unwrap_or("").parse::<u16>(),
                                    std::str::from_utf8(parts[1]).unwrap_or("").parse::<u16>(),
                                ) {
                                    set_winsize(master_file.as_raw_fd(), r, c);
                                    unsafe {
                                        libc::kill(-pid, libc::SIGWINCH);
                                    }
                                }
                            }
                            slice = &slice[pos + 1..];
                        }
                    }
                    if !slice.is_empty() {
                        let _ = master_file.write_all(slice);
                    }
                }
            }
        }

        // pty → stdout
        if unsafe { libc::FD_ISSET(master_file.as_raw_fd(), &mut rfds) } {
            if let Ok(n) = master_file.read(&mut pty_buf) {
                if n > 0 {
                    let _ = out.write_all(&pty_buf[..n]);
                    let _ = out.flush();
                }
            }
        }
    }

    // Shell terminated message
    let _ = out.write_all(b"\r\n[Shell terminated.]\r\n");
    let _ = out.flush();
}
