const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const vm = require('node:vm');
const { Terminal } = require('../resources/xterm.js');

// 実際の WebView の設定と同梱 xterm.js を使い、OSC 8 の解析からクリックまで検証する。
const html = readFileSync(require.resolve('../resources/terminal.html'), 'utf8');
const optionsSource = html.match(/state\.term = new Terminal\((\{[\s\S]*?\n                \})\);/)[1];

function terminal(messages) {
    const options = vm.runInNewContext('(' + optionsSource + ')', {
        getTerminalThemeFromCssVars: () => ({}),
        fontSettings: {},
        MAX_BUFFER_LINES: 1000,
        vscode: { postMessage: message => messages.push(JSON.parse(JSON.stringify(message))) },
    });
    return new Terminal(options);
}

async function linksFor(term, output) {
    await new Promise(resolve => term.write(output, resolve));
    const links = [];
    // OSC 8 は xterm.js 内蔵プロバイダーが処理する。
    const provider = term._core._linkProviderService.linkProviders[0];
    for (let row = 1; row <= term.rows; row++) {
        provider.provideLinks(row, result => links.push(...(result || [])));
    }
    return links;
}

function hyperlink(url, label) {
    return '\x1b]8;;' + url + '\x07' + label + '\x1b]8;;\x07';
}

test('OSC 8 PR labels send their target URL to VSCode on a plain click', async () => {
    // Arrange
    const messages = [];
    const term = terminal(messages);
    try {
        const url = 'https://github.com/example/project/pull/58?tab=files#diff-123';
        // Act
        const links = await linksFor(term, hyperlink(url, '#58'));
        // Assert
        assert.equal(links.length, 1);
        assert.equal(term.buffer.active.getLine(0).translateToString(true), '#58');
        links[0].activate({ metaKey: false, ctrlKey: false }, links[0].text);
        assert.deepEqual(messages, [{ type: 'openLink', data: url }]);
    } finally {
        term.dispose();
    }
});

test('wrapped OSC 8 labels keep the original HTTP target', async () => {
    // Arrange
    const messages = [];
    const term = terminal(messages);
    try {
        term.resize(10, 5);
        const url = 'http://localhost:3000/path';
        // Act
        const links = await linksFor(term, hyperlink(url, 'A link label spanning rows'));
        // Assert
        assert.ok(links.length > 1);
        for (const link of links) {
            link.activate({ metaKey: false, ctrlKey: false }, link.text);
        }
        assert.ok(messages.length > 1);
        assert.ok(messages.every(message => message.type === 'openLink' && message.data === url));
    } finally {
        term.dispose();
    }
});

test('OSC 8 ignores non-HTTP targets', async () => {
    // Arrange
    const messages = [];
    const term = terminal(messages);
    try {
        for (const url of ['javascript:alert(1)', 'command:workbench.action.reloadWindow', 'file:///tmp/file']) {
            term.reset();
            // Act
            const links = await linksFor(term, hyperlink(url, '#58'));
            // Assert
            assert.deepEqual(links, []);
        }
        assert.deepEqual(messages, []);
    } finally {
        term.dispose();
    }
});
