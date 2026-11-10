const assert = require('node:assert/strict');
const { test } = require('node:test');
const Module = require('node:module');
const { AgentSessionRestore, parseActiveAgent } = require('../out/agentSessionRestore');

function context(records = []) {
    const state = new Map(records);
    return { globalState: {
        keys: () => [...state.keys()],
        get: (key) => state.get(key),
        update: async (key, value) => { state.set(key, value); },
    } };
}

function status(agent, cwd, active = true, pid = 42) {
    return '\x1b]777;' + JSON.stringify({
        type: 'cli_agent_status', data: { active, agent_type: agent, cwd, pid },
    }) + '\x07';
}

test('all supported agents survive restart with their working directory', () => {
    for (const agent of ['claude', 'codex', 'opencode']) {
        const storage = context();
        const before = new AgentSessionRestore(storage);
        const message = status(agent, "/project/sub folder/'quoted'");
        // OSC のプレフィックスと JSON が別チャンクになっても保持する。
        for (const char of message) before.observeOutput('tab1', '/project', char);
        before.observeOutput('tab1', '/project', status(null, null, false));
        const after = new AgentSessionRestore(storage);
        assert.deepEqual(after.getRestoreCandidate('/project'), {
            agent, cwd: "/project/sub folder/'quoted'",
        });
    }
});

test('workspace records and partial sequences are isolated', () => {
    const restore = new AgentSessionRestore(context());
    const message = status('claude', '/a/sub');
    restore.observeOutput('a', '/a', message.slice(0, 12));
    restore.observeOutput('b', '/b', status('codex', '/b/sub'));
    restore.observeOutput('a', '/a', message.slice(12));
    assert.equal(restore.getRestoreCandidate('/a').agent, 'claude');
    assert.equal(restore.getRestoreCandidate('/b').agent, 'codex');
    const snapshot = restore.getRestoreCandidate('/a');
    restore.observeOutput('a', '/a', status('opencode', '/a/other'));
    assert.deepEqual(snapshot, { agent: 'claude', cwd: '/a/sub' });
});

test('failed cwd lookup does not replace a known session location', () => {
    const restore = new AgentSessionRestore(context());
    restore.observeOutput('a', '/project', status('claude', '/project/sub'));
    for (const cwd of [null, '', 'relative', '/invalid\0path']) {
        restore.observeOutput('a', '/project', status('codex', cwd));
    }
    assert.deepEqual(restore.getRestoreCandidate('/project'), { agent: 'claude', cwd: '/project/sub' });
});

test('old tabs cannot replace the newest agent through heartbeats', () => {
    // Arrange
    const storage = context();
    const restore = new AgentSessionRestore(storage);
    let updates = 0;
    const update = storage.globalState.update;
    storage.globalState.update = (...args) => { updates++; return update(...args); };

    // Act
    restore.observeOutput('a', '/project', status('claude', '/project', true, 1));
    restore.observeOutput('b', '/project', status('codex', '/project/sub', true, 2));
    restore.observeOutput('a', '/project', status('claude', '/project', true, 1));

    // Assert
    assert.equal(updates, 2);
    assert.equal(restore.getRestoreCandidate('/project').agent, 'codex');
    restore.observeOutput('b', '/project', status('codex', '/project/sub', true, 2));
    assert.equal(updates, 3);
    restore.observeOutput('a', '/project', status('claude', '/project', true, 3));
    assert.equal(updates, 4);
    assert.equal(restore.getRestoreCandidate('/project').agent, 'claude');
});

test('legacy records, expiry, and unrecognized data', () => {
    const prefix = 'secondaryTerminal.lastAgentLaunch:';
    const restore = new AgentSessionRestore(context([
        [prefix + '/legacy', { agent: 'claude', at: Date.now() }],
        [prefix + '/old', { agent: 'codex', at: Date.now() - 15 * 86400000 }],
        [prefix + '/invalid', { agent: 'constructor', at: Date.now() }],
    ]));
    assert.deepEqual(restore.getRestoreCandidate('/legacy'), { agent: 'claude', cwd: '/legacy' });
    assert.equal(restore.getRestoreCandidate('/old'), undefined);
    assert.equal(restore.getRestoreCandidate('/invalid'), undefined);
    for (const payload of ['null', '{broken', '{"type":"other"}',
        '{"type":"cli_agent_status","data":{"active":true,"agent_type":"unknown"}}']) {
        assert.equal(parseActiveAgent(payload), undefined);
    }
    assert.equal(AgentSessionRestore.resumeCommand('claude'), 'claude --continue');
    assert.equal(AgentSessionRestore.resumeCommand('codex'), 'codex resume --last');
    assert.equal(AgentSessionRestore.resumeCommand('opencode'), 'opencode --continue');
});

// VSCode を起動せず、プロバイダーの起動経路を実際のメソッドで検証する。
let trusted = true;
let enabled = true;
const originalLoad = Module._load;
Module._load = function (id, ...args) {
    if (id === 'vscode') return { workspace: {
        get isTrusted() { return trusted; },
        getConfiguration: () => ({ get: () => enabled }),
    } };
    return originalLoad.call(this, id, ...args);
};
const { TerminalProvider } = require('../out/terminalProvider');
Module._load = originalLoad;

function provider({ buffer = '', startup = false, cwd = process.cwd() } = {}) {
    const calls = [];
    const p = Object.create(TerminalProvider.prototype);
    Object.assign(p, {
        _restoreAttempted: false,
        _restoreCandidate: { agent: 'codex', cwd },
        _workspaceKey: '/workspace', _cwd: '/workspace',
        _extensionContext: { extensionPath: '/extension' },
        _terminalCols: 80, _terminalRows: 24,
        _processManager: {
            registerExitCallback() {},
            willRunStartupCommands: () => startup,
            getOrCreateProcess: (...args) => calls.push(args),
        },
        _sessionManager: { getBuffer: () => buffer, addOutput() {} },
        getVersionInfo: () => ({ version: 'test', buildDate: '' }),
        appendLog() {},
    });
    return { p, calls };
}

test('first shell automatically resumes once in saved cwd without a dialog', () => {
    const { p, calls } = provider();
    p.startShellForTab('one');
    p.startShellForTab('two');
    assert.equal(calls[0][2], process.cwd());
    assert.equal(calls[0][6], 'codex resume --last');
    assert.equal(calls[1][2], '/workspace');
    assert.equal(calls[1][6], undefined);
});

test('startup commands, reconnects, removed directories, trust, and opt-out suppress restore', () => {
    for (const options of [{ startup: true }, { buffer: 'existing terminal' },
        { cwd: '/nonexistent-secondary-terminal-test-directory' }]) {
        const { p, calls } = provider(options);
        p.startShellForTab('one');
        p.startShellForTab('two');
        assert.ok(calls.every((args) => args[6] === undefined));
    }
    for (const mode of ['untrusted', 'disabled']) {
        trusted = mode !== 'untrusted';
        enabled = mode !== 'disabled';
        const { p, calls } = provider();
        p.startShellForTab('one');
        trusted = enabled = true;
        p.startShellForTab('two');
        assert.ok(calls.every((args) => args[6] === undefined));
    }
});
