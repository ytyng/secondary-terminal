import importlib.util
import io
from contextlib import ExitStack
from pathlib import Path
import subprocess
import unittest
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location(
    'pty_shell', Path(__file__).resolve().parents[1] / 'resources/pty-shell.py'
)
pty_shell = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pty_shell)


class AgentDetectionTests(unittest.TestCase):
    def test_supported_agents_and_npm_launchers(self):
        commands = [
            ('claude', '/usr/local/bin/claude --continue'),
            ('claude', 'node /usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js'),
            ('codex', '/opt/homebrew/bin/codex resume --last'),
            ('codex', 'node /usr/local/bin/codex'),
            ('opencode', '/opt/homebrew/bin/opencode'),
            ('opencode', 'bun /usr/local/bin/opencode'),
        ]
        for agent, command in commands:
            with self.subTest(command=command):
                comm = command.split()[0]
                result = subprocess.CompletedProcess([], 0, f'42 {comm} {command}\n')
                with patch.object(pty_shell.subprocess, 'run', return_value=result), \
                     patch.object(pty_shell, 'get_process_cwd', return_value='/project/sub folder'):
                    status = pty_shell.check_cli_agent_active(1, {42: (1, comm)})
                self.assertEqual(status, {
                    'active': True, 'agent_type': agent, 'pid': 42,
                    'cwd': '/project/sub folder',
                })

    def test_same_process_reuses_cwd(self):
        previous = {'active': True, 'agent_type': 'codex', 'pid': 42, 'cwd': '/project'}
        with patch.object(pty_shell, 'get_process_cwd') as read_cwd:
            self.assertEqual(pty_shell.agent_process_status('codex', 42, previous), previous)
            read_cwd.assert_not_called()
        with patch.object(pty_shell, 'get_process_cwd', return_value='/other') as read_cwd:
            self.assertEqual(pty_shell.agent_process_status('codex', 43, previous)['cwd'], '/other')
            read_cwd.assert_called_once_with(43)

    def test_mac_cwd_and_missing_process(self):
        result = subprocess.CompletedProcess([], 0, "p42\nfcwd\nn/project/sub folder/'quoted'\n")
        with patch.object(pty_shell.sys, 'platform', 'darwin'), \
             patch.object(pty_shell.subprocess, 'run', return_value=result):
            self.assertEqual(pty_shell.get_process_cwd(42), "/project/sub folder/'quoted'")
        with patch.object(pty_shell.sys, 'platform', 'darwin'), \
             patch.object(pty_shell.subprocess, 'run', side_effect=subprocess.TimeoutExpired('lsof', 1)):
            self.assertIsNone(pty_shell.get_process_cwd(42))

    def test_unrelated_process_is_not_an_agent(self):
        for command in ['vim README.md', 'vim /tmp/claude-code/README.md',
                        'python3 -c pass /tmp/claude-code/README.md']:
            with self.subTest(command=command):
                comm = command.split()[0]
                result = subprocess.CompletedProcess([], 0, f'42 {comm} {command}\n')
                with patch.object(pty_shell.subprocess, 'run', return_value=result):
                    self.assertEqual(pty_shell.check_cli_agent_active(1, {42: (1, comm)}), {
                        'active': False, 'agent_type': None,
                    })


class AgentResumeTests(unittest.TestCase):
    def run_main(self, chunks, command='codex resume --last'):
        """PTY・プロセス・時刻だけを置換し、実際の main の入出力経路を通す。"""
        process = Mock(pid=42)
        iterations = len(chunks) + 3
        process.poll.side_effect = [None] * iterations + [0, 0, 0]
        inputs = iter(chunks)
        selection = 0

        def select_io(_read, _write, _except, timeout):
            nonlocal selection
            if timeout == 0:
                return [], [], []
            selection += 1
            return ([pty_shell.sys.stdin] if selection <= len(chunks) else []), [], []

        writes = []
        patches = [
            patch.object(pty_shell.sys, 'argv', ['pty-shell.py', '80', '24', '/project', '--resume-command', command]),
            patch.object(pty_shell.sys, 'stdout', Mock(buffer=io.BytesIO())),
            patch.object(pty_shell.pty, 'openpty', return_value=(100, 101)),
            patch.object(pty_shell, 'set_winsize'),
            patch.object(pty_shell.fcntl, 'fcntl', return_value=0),
            patch.object(pty_shell.subprocess, 'Popen', return_value=process),
            patch.object(pty_shell.signal, 'signal'),
            patch.object(pty_shell.atexit, 'register'),
            patch.object(pty_shell.os, 'close'),
            patch.object(pty_shell.os, 'killpg'),
            patch.object(pty_shell.os, 'getpgid', return_value=42),
            patch.object(pty_shell.os, 'read', side_effect=lambda *_: next(inputs)),
            patch.object(pty_shell.os, 'write', side_effect=lambda _fd, data: writes.append(data) or len(data)),
            patch.object(pty_shell.time, 'time', side_effect=[0] + [0.1 + i for i in range(iterations)]),
            patch.object(pty_shell.select, 'select', side_effect=select_io),
            patch.object(pty_shell, 'get_process_snapshot', return_value={}),
            patch.object(pty_shell, 'send_status_message'),
        ]
        with ExitStack() as stack:
            for item in patches:
                stack.enter_context(item)
            pty_shell.main()
        return writes

    def test_main_resumes_once_and_keeps_terminal_responses(self):
        for chunks in [[], [b'\x00'], [b'\x1b[8;24;80t'], [b'\x1b[1;1R'],
                       [b'\x1b[1;', b'1R'], [b'\x1b]11;rgb:0000/0000/0000\x1b\\']]:
            with self.subTest(chunks=chunks):
                # Act
                writes = self.run_main(chunks)
                # Assert
                self.assertEqual(writes.count(b'codex resume --last\n'), 1)
                if chunks == [b'\x1b[1;1R']:
                    self.assertIn(chunks[0], writes)

    def test_main_cancels_for_actual_input_including_split_utf8(self):
        for chunks in [[b'x'], [b'\x03'], [b'\x1b[A'], [b'\x1b[1;1Rx'],
                       [b'\xe3', b'\x81\x82']]:
            with self.subTest(chunks=chunks):
                writes = self.run_main(chunks)
                self.assertNotIn(b'codex resume --last\n', writes)

    def test_main_only_accepts_fixed_resume_commands(self):
        self.assertEqual(self.run_main([], 'touch /tmp/not-a-resume-command'), [])

    def test_fragmented_terminal_responses_and_pending_escape(self):
        for response in [b'\x1b[?1;2c', b'\x1b[>0;276;0c', b'\x1b[0n', b'\x1b[?1;2R',
                         b'\x1b[?25;1$y', b'\x1b]4;1;rgb:ffff/0000/0000\x07',
                         b'\x1bP1$r0m\x1b\\', b'\x1b[I']:
            pending = pty_shell.PendingAgentResume('claude --continue')
            for value in response:
                pending.observe_input(bytes([value]))
            self.assertEqual(pending.command, 'claude --continue', response)
            self.assertEqual(pending.pending, b'')
        pending = pty_shell.PendingAgentResume('claude --continue')
        pending.observe_input(b'\x1b')
        self.assertTrue(pending.pending)
        pending.observe_input(b'x')
        self.assertIsNone(pending.command)


if __name__ == '__main__':
    unittest.main()
