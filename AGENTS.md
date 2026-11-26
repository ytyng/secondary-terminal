# Secondary Terminal - VSCode Extension

Development project for a full-featured terminal extension that runs in the VSCode sidebar.

## Project Overview

This extension provides a fully functional terminal in the VSCode sidebar. Thanks to a real pseudo-terminal implementation built on Python's PTY module, interactive applications such as vim and less work correctly.

## Technical Features

### Architecture

- **Frontend**: High-performance terminal emulator using xterm.js
- **Middleware**: Communication between VSCode and Python via Node.js child_process
- **Backend**: Pseudo-terminal implementation using Python's pty module

### Implementation Highlights

1. **PTY emulation**
   - Real pseudo-terminal creation with Python's `pty.openpty()`
   - Non-blocking I/O implemented with `fcntl`
   - Efficient I/O multiplexing with `select.select()`

2. **Dynamic resizing**
   - Monitoring HTML element size with ResizeObserver
   - Accurate measurement of font metrics
   - Automatic adjustment of the PTY window size (TIOCSWINSZ ioctl)

3. **Character encoding**
   - Full UTF-8 support
   - Correct display of multibyte characters
   - Fallback handling on encoding errors

4. **Interactive app support**
   - vim hjkl cursor movement
   - less paging
   - Proper handling of Control-C and Control-Z
   - Terminal resize notification via the SIGWINCH signal

## Development History

### Initial implementation
- Basic WebView-based terminal display
- xterm.js integration
- Simple command execution

### Intermediate stage
- Attempted to adopt node-pty (abandoned due to compatibility problems in VSCode's Electron environment)
- Switched to PTY emulation using Python

### Final implementation
- Full PTY support
- Full support for interactive applications
- Dynamic resizing

## Technical Challenges and Solutions

### 1. node-pty problems in the VSCode environment
**Challenge**: node-pty's native module cannot be built correctly for VSCode's Electron environment
**Solution**: Custom PTY emulation using Python's pty module

### 2. Non-blocking I/O
**Challenge**: Blocking when reading stdin in the VSCode environment
**Solution**: Non-blocking mode set with `fcntl` and multiplexing with `select`

### 3. Character encoding
**Challenge**: Garbled multibyte characters
**Solution**: Unified UTF-8 handling and a fallback on errors

### 4. Terminal resizing
**Challenge**: Setting an appropriate terminal size for the sidebar size
**Solution**: Accurate calculation from the HTML element size and real-time adjustment

**Decide cols from the measured cell width, not an "estimate"** (`setTerminalSize` / `measureActualCellWidth`):
An estimate derived from the character width of a measurement div × a correction factor does not
necessarily match the cell width xterm actually uses (font fallback, rounding inside xterm,
differences in how letterSpacing is handled). If the estimate is even 1px too small, `cols × actual cell width`
exceeds the pane width, and **only when a long line is displayed** the content overflows to the right,
horizontal scrolling kicks in, and it cannot be scrolled back
(xterm.css specifies only `overflow-y: scroll` for `.xterm-viewport`, so by CSS rules
overflow-x is effectively auto = it becomes a horizontal scroll container).
The width of the rendered `.xterm-screen` is `cols × cell width`, so `screen.width / term.cols`
gives the actual cell width exactly. This value does not depend on cols, so the cols derived from it
are the same on the next calculation and the resize does not oscillate. Before the first render it cannot be measured, so
a provisional size is set from the estimate, and measurement is retried via `requestAnimationFrame` until it succeeds (with a limit).
When computing the column count, leave 1px of slack (`CELL_FIT_SLACK_PX`): xterm rounds the canvas width to device
pixels before converting it to the CSS width, so the measured cell width carries rounding error; for a width that divides
exactly, the column count can come out 1 too high → 1 too low on the next calculation, and so on back and forth.
Furthermore, **after changing the column or row count, measure again on the next frame**: the error in the measured cell width is
at most `0.5 / cols` px per cell, so when the pane widens a lot and the column count increases, the error accumulates and
can exceed the 1px slack. Recalculating with the post-resize measurement (more precise because there are more columns)
puts it back on a correct footing. It stops once nothing changes.
The user setting `widthAdjustment` is also applied to the measured value, but **it is clamped to the number of columns that actually fit
with the measured cell width** (the default 0.88 is a factor that compensates for estimation error, so
applying it as-is would bring the overflow back).

### 5. Garbled glyphs with the WebGL renderer on non-Retina displays
**Challenge**: xterm 5.5 + addon-webgl 0.18 truncates the cell width to an integer number of device pixels.
At DPR 1, a cell whose actual character width is 7.8px becomes 7px, glyphs break, and Nerd Font icons turn into □.
The font is visible to the WebView (confirmed with canvas measureText), and rebuilding the glyph atlas does not fix it.
**Solution**: The setting `secondaryTerminal.gpuAcceleration` (`auto` / `on` / `off`). `auto` uses WebGL only at DPR 2 or higher,
and the DOM renderer otherwise (`shouldUseWebgl` / `applyRendererMode`). DPR changes caused by moving between displays are
also picked up with `matchMedia('(resolution: …dppx)')` and switched accordingly. Every path that loads WebGL (initialization, recovery from context lost,
Refresh Renderer) must go through `shouldUseWebgl()`. If even one bypasses it, it falls back to WebGL even when DOM is selected.
If the integer truncation is fixed in xterm 6.x, the `auto` decision can be revisited.

## File Structure

```
secondary-terminal/
├── src/
│   ├── extension.ts                # Extension entry point, command registration
│   ├── terminalProvider.ts         # Terminal provider (tab management, ACE editor, PTY)
│   ├── clipboardImageHandler.ts    # macOS clipboard image extraction
│   ├── dropZoneProvider.ts         # File Drag & Drop zone
│   ├── terminalSessionManager.ts   # Terminal session persistence
│   ├── agentSessionRestore.ts      # Records the last used CLI agent (Claude Code / Codex / OpenCode) and auto-continues it
│   ├── shellProcessManager.ts      # Shell process lifecycle management
│   └── utils.ts                    # Utility functions
├── resources/
│   ├── terminal.html        # Main UI (xterm.js, ACE editor, tab bar)
│   ├── xterm.css            # xterm.js stylesheet
│   ├── xterm.js             # xterm.js library
│   └── version.json         # Version + build date/time (placed here because src/ is excluded by .vscodeignore)
├── scripts/
│   └── update-version.js    # Script that updates version information
├── out/                     # Compiled JavaScript
├── package.json             # Project configuration
├── tsconfig.json            # TypeScript configuration
├── README.md                # User documentation
└── CLAUDE.md                # Developer documentation (this file)
```

## Implementation Details of Main Features

### TerminalProvider class (`terminalProvider.ts`)
- Generates and manages the WebView HTML
- Starts and manages the Python PTY process
- Converts and forwards input/output data
- Dynamically adjusts the terminal size
- Multi-tab management (an independent shell process and ACE editor per tab)

### CLI agent session restore (`agentSessionRestore.ts`)
- **The extension host also picks up** the CLI agent running state that pty-shell.py already emits (OSC 777 `cli_agent_status`;
  it is determined by looking at the shell's descendant processes),
  and records "the agent that was used in this workspace" and that process's working directory
  in `globalState` (keyed by the workspace cwd, expires after 14 days).
  Output is monitored via `ShellProcessManager.addOutputObserver`. While running, the record is refreshed every 60 seconds
- **Do not switch to picking up the command name from the input line**: when invoked from history (↑ key) or
  confirmed by completion, the command string is finalized inside the shell without passing through the extension, so it would
  miss the most common way of starting an agent. The PTY-side detection, which looks at running processes, is more accurate
- In the first empty terminal after a restart, automatically run
  `claude --continue` / `codex resume --last` / `opencode --continue` from the recorded working directory.
  A fixed command is passed as a PTY startup argument and injected 1 second after startup. If the user has typed anything first, it is cancelled.
  No restore happens for untrusted workspaces, when the working directory does not exist, or when there are startup commands.
  A suppressed candidate is not carried over to another tab opened later
- The key point is **not managing session IDs on the extension side**. The location and naming conventions of `~/.claude/projects/` and `~/.codex/sessions/`
  are internal implementation details of the CLIs, so following them would break. Each CLI has a
  "continue the previous session" command, so resolution is left to the CLI. If a new conversation in the same directory
  was started elsewhere, that conversation may be chosen (this is not a pinned restore of a specific ID)
- **The restore candidate is read only once, at window startup** (`_restoreCandidate`). Re-reading it right before suggesting
  would suggest an agent just launched in the same window as "the previous session",
  and could connect twice to a session running in another tab
- Auto-continue happens once per window, and **only in a tab whose buffer is empty (newly started)**.
  Running it on reconnect too could launch a second agent on top of one that is already running
- **Records are written to a separate `globalState` key per workspace** (`...lastAgentLaunch:<cwd>`).
  If they were combined into a single object, another window opened with the same profile would read the same snapshot and
  write the whole thing back, erasing the other workspace's record. The extension host is a separate process per window, so
  serialization on this side cannot prevent it. To keep the keys from growing forever, only the expired ones are cleaned up at startup
- Can be disabled with the setting `secondaryTerminal.restorePreviousAgentSession` (default true)
- pty-shell.py also detects gemini / copilot, but only claude / codex / opencode, which have a
  "continue the previous session" command, are targeted

### Clipboard image handler (`clipboardImageHandler.ts`)
- Extracts PNG/TIFF images from the macOS NSPasteboard (via AppleScript)
- Saves them under `/tmp/secondary-terminal/attachments/` with UUID7-based file names
- Inserts the file path into the editor in the `[@<filepath>]` format

### Drop Zone provider (`dropZoneProvider.ts`)
- Implemented as a TreeView in the VSCode sidebar
- Accepts file drops of the `text/uri-list` MIME type
- Sends dropped file paths to the ACE editor in the `[@<path>]` format

### Python PTY script
- Creates and manages the pseudo-terminal (PTY)
- Starts the shell process (zsh/bash)
- Handles input/output with non-blocking I/O
- Handles terminal resizing

### Frontend (`resources/terminal.html`)
- Initializes the xterm.js terminal
- Measures font metrics
- Dynamic resizing logic
- Communication interface with VSCode
- An independent ACE editor instance per tab (ace-builds library, VSCode keybindings)
- `Cmd+Enter` sends the editor contents to the terminal
- Trim Lines (strip leading/trailing whitespace from each line)

## Development and Test Environment

- **OS**: macOS (development and test target)
- **Node.js**: 20.18.2
- **Python**: 3.13.3
- **VSCode**: 1.101.0+
- **TypeScript**: 5.8.3

## Known Issues

### "Gets gradually slower with use" (likely causes fixed on 2026-07-03)

The cause was unknown for a long time, but the full code review on 2026-07-03 (PR #16) identified and fixed the following accumulating factors.

- The `TerminalSessionManager.sessions` Map grew without bound every time a tab was opened/closed (`removeSession` was unused)
- Orphaned pty-shell.py processes accumulated on every reset (`resetTerminal` did not support multiple tabs)
- pty-shell.py spawned pgrep every 3 seconds, as many times as there were descendant processes
- The 10ms infinite polling of `waitForSize` remained after a tab was closed
- WebviewView / listeners lingered when `resolveWebviewView` was resolved again

If it still slows down after the fixes, check the process count with `ps aux | grep pty-shell`
and the Map size with `getSessionInfo()` (for debugging).

### pty-shell.py cannot be exercised for real inside the Claude Code sandbox

The sandbox of Claude Code's Bash tool blocks access to `/dev/ptmx`, so
`pty.openpty()` fails with `OSError: out of pty devices`
(this is a separate layer that cannot be bypassed even with `dangerouslyDisableSandbox` or by disabling it via `/sandbox`).
Verify anything involving a PTY with unit simulations of the logic (decoding, etc.) and
by reloading the extension on a real machine.


## Installation and Development Steps

### Initial setup
```bash
# Clone the repository
git clone <repository-url>
cd secondary-terminal

# Install dependencies
npm install

# Compile TypeScript
npm run compile
```

### Running in the development environment
```bash
# Open the project in VSCode
code .

# Press F5 to start debugging
# or run "Run Extension" from the "Run and Debug" panel
```

### Local installation
In the VSCode command palette, run:
```
Developer: Install Extension from Location...
```
and select the project directory.

### Code change and update workflow

1. **Edit code**:
   - Edit `src/extension.ts` or `src/terminalProvider.ts`

2. **Compile**:
   ```bash
   npm run compile
   ```

3. **How to test**:
   - **Development mode**: Launch the debug window with F5
   - **Installed extension**: Reload with `Developer: Reload Window`

4. **Debugging**:
   - VSCode developer tools: `Help > Toggle Developer Tools`
   - Check behavior in the console log
   - Add `console.log()` to the code for debugging

### Version management and release workflow

#### Version number management
- **Current version**: Managed in the `version` field of `package.json`
- **Build information**: `resources/version.json` records the version number and build date/time (placed in resources/ because src/ is excluded from the package by .vscodeignore)
- **Automatic update**: The build date/time is updated automatically at build time

#### Version bump steps
1. **Patch version bump** (automatic increment):
   ```bash
   npm run increment-version
   ```
   - Automatically increments the package.json version by 0.0.1
   - Automatically updates the version and build date/time in resources/version.json
   - **Note**: The internal `npm version patch` fails unless the working tree is clean.
     When there are uncommitted changes (the normal flow right before committing), run the following instead:
     ```bash
     npm version patch --no-git-tag-version && npm run update-version
     ```
   - **What the patch number really is**: `scripts/update-version.js` overwrites the patch number with `git rev-list --count HEAD`
     (the commit count). It is normal for the final version to differ from what `npm version patch` shows.
   - **Syncing package-lock.json**: update-version.js rewrites package.json directly, so
     the version in the lockfile is left stale (pointed out by Codex in PR #15). After updating the version,
     run `npm install --package-lock-only` to sync the lockfile too, and commit them together.

2. **Manual version update**:
   ```bash
   # After manually changing the version in package.json
   npm run update-version
   ```

3. **Release preparation**:
   ```bash
   npm run increment-version  # Bump the version
   npm run compile           # Build
   git add .
   git commit -m "Release version X.X.X"
   git push origin main
   ```

#### Version management rules
- **Every commit**: Run `npm run increment-version` before each commit
- **Every build**: The build date/time is updated automatically when `npm run compile` runs
- **Release**: Bump the version and commit when a feature or fix is complete

#### File structure (version management)
```
secondary-terminal/
├── package.json              # Main version number
├── resources/version.json    # Version + build date/time
├── scripts/update-version.js # Script that updates version information
└── out/                      # Compiled output (includes version information)
```

### Common development tasks

#### Modifying the Python PTY script
- Edit the `pythonScript` variable in `terminalProvider.ts`
- After compiling, reload the extension

#### Modifying the frontend (HTML/JavaScript)
- Edit the HTML/CSS/JavaScript in the `_getHtmlForWebview()` method
- Change xterm.js settings
- Adjust the terminal size calculation logic

#### UI changes
- Change icons and menus in the `contributes` section of `package.json`
- Implement additional VSCode API features

#### Adding or changing settings (Japanese/English)
- Setting descriptions are localized into Japanese and English with VSCode's standard NLS mechanism (since PR #15)
- In `package.json`, write a `%configuration.<key>.description%` placeholder in `description`
- Write the actual text in `package.nls.json` (English, default) and `package.nls.ja.json` (Japanese).
  **When adding or changing a setting, always add the key to both files** (if one is missing, the key name is displayed as-is)
- Also add a row for the same setting to the Settings table (English) in README.md

### Troubleshooting

#### The extension is not recognized
```bash
# Check the package.json syntax
npm run compile
# Check for errors
```

#### The terminal does not start
- Check for errors in the developer tools console
- Check that Python 3.x is installed
- Check PTY-related error messages

#### Garbled characters or input errors
- Check the UTF-8 encoding
- Check the non-blocking I/O settings of the Python script

#### Rendering glitches (font, letter spacing, icons shown as □)
In the Console of the WebView DevTools (`Help > Toggle Developer Tools`), switch the execution context to
Secondary Terminal's `active-frame` and investigate (it goes back to `top` after a reload).
`tabState` / `fontSettings` are top-level variables, so they can be accessed from the Console.

- Whether the font is visible to the WebView: `document.fonts.check()` returns `true` for local fonts not registered via `@font-face`
  even if they do not exist, so it cannot be used. Use canvas `measureText` to compare the width of
  the target font against a nonexistent font name
- Cell dimensions used by xterm: `tabState.terminals.get(tabState.activeTabId)._core._renderService.dimensions`
- Isolating the renderer: drop to the DOM renderer with `tabState.terminalStates.get(tabState.activeTabId).webgl.dispose()`
  and see whether the display changes

Of the icons at the top of the panel, the palette (`$(symbol-color)`) is Refresh Renderer, and the circular arrow (`$(refresh)`) is
Restart Terminal (restarts the shell).

## Related Technologies and References

- [VSCode Extension API](https://code.visualstudio.com/api)
- [xterm.js](https://xtermjs.org/)
- [Python pty module](https://docs.python.org/3/library/pty.html)
- [Linux PTY documentation](https://man7.org/linux/man-pages/man7/pty.7.html)

## Investigation of the Emoji Display Width Problem

### Overview of the problem
- Emoji are displayed only at half width in the terminal (the standard VSCode terminal displays them correctly at full width)
- xterm.js's `wcwidth` parameter is ignored by the Canvas renderer

### Approaches investigated and results

#### 1. Specifying character width with the `wcwidth` parameter
```javascript
// ❌ No effect
wcwidth: (codepoint) => {
    // Treat emoji as full width (2)
    if (/* emoji range */) return 2;
    return 1;
}
```
**Result**: Completely ignored by the Canvas renderer

#### 2. Using the Unicode 11 addon
```javascript
// ❌ Only a partial effect
const unicode11 = new Unicode11Addon.Unicode11Addon();
term.loadAddon(unicode11);
unicode11.activate(term);
```
**Result**: The addon loads, but it does not affect the Canvas renderer's character width calculation

#### 3. VSCode-compatible settings
```javascript
// ❌ No effect
rescaleOverlappingGlyphs: true,
customGlyphs: true
```
**Result**: These options are not recognized by xterm.js v5.5.0

### Root cause of the problem
- xterm.js v5.5.0 + the Canvas renderer uses its own character width calculation
- It ignores character widths specified through the `wcwidth` option or addons
- The Canvas renderer implements character width handling differently from the DOM renderer

### Possible future directions
1. **Hacking the Canvas renderer's internal API**: Directly manipulate internals such as `_charAtlas._ctx.measureText`
2. **Switching to the DOM renderer**: Prioritize character width accuracy at the cost of performance
3. **Changing the xterm.js version**: Update to a version with improved emoji support
4. **Considering alternative libraries**: Adopt a terminal emulator library other than xterm.js

### What was kept
- Installation and basic configuration of the Unicode 11 addon
- Loading of the Canvas addon
- Groundwork code for a future solution

---

**Developer**: ytyng
**Created**: June 28, 2025
**Last updated**: January 30, 2026