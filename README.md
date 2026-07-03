# Secondary Terminal

A full-featured terminal extension that runs in the VSCode sidebar. With complete PTY emulation, interactive applications such as vim and less work correctly.

![](./documents/images/flashcap-20260130-105327.png)

## Features

- **Sidebar Terminal**: Terminal integrated into the VSCode sidebar
- **Full PTY Emulation**: Genuine pseudo-terminal implementation using Python
- **Interactive App Support**: Full support for vim, less, nano, etc.
- **Dynamic Resizing**: Automatically adjusts terminal size according to sidebar dimensions
- **UTF-8 Support**: Correctly displays multibyte characters including Japanese
- **Custom Font**: RobotoMono Nerd Font support
- **Multi-Tab Support**: Multiple independent terminal tabs, each with its own shell process and editor
- **ACE Editor Integration**: Built-in code editor (ACE) per tab for composing commands and text
- **Clipboard Image Paste**: Paste images from clipboard and insert file path reference (macOS only)
- **Drop Zone**: Drag & drop files from the explorer to insert file path references into the editor

## Requirements

- Visual Studio Code 1.101.0 or later
- Python 3.x (for PTY emulation)
- macOS / Linux (currently only Unix-based OS supported)

## Installation

### Development Installation

1. Clone this repository:
   ```bash
   git clone <repository-url>
   cd secondary-terminal
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Compile TypeScript:
   ```bash
   npm run compile
   ```

4. Run in development mode with VSCode:
   - Open the project in VSCode
   - Press F5 to launch the extension in debug mode
   - A new VSCode window will open with the extension available

### Local Installation

To install the extension to your local VSCode, copy the project directory path, then open the Command Palette (Cmd+Shift+P) and run:

```
Developer: Install Extension from Location...
```

Specify the project directory path (e.g., `/path/to/secondary-terminal`).

### Installation via Symlink

As a simpler alternative, you can create a symbolic link in the extensions directory:

```bash
# For standard VSCode
ln -s /path/to/secondary-terminal ~/.vscode/extensions/secondary-terminal

# For VSCode Insiders
ln -s /path/to/secondary-terminal ~/.vscode-insiders/extensions/secondary-terminal
```

Then restart VSCode.

### Updating After Code Changes

Steps to update after modifying the extension code:

1. **Compile TypeScript**:
   ```bash
   npm run compile
   # Or watch for changes and auto-compile
   npm run dev
   ```

2. **Reload the extension in VSCode**:
   - Open the Command Palette (Cmd+Shift+P)
   - Run `Developer: Reload Window`
   - Or fully restart VSCode

3. **Test in development mode**:
   - Open the project in VSCode
   - Press F5 to launch in debug mode
   - Test your changes in the new window

### Development Commands

```bash
# Auto-compile (file watcher)
npm run dev

# Clean output directory
npm run clean

# Clean and recompile
npm run rebuild

# Lint code
npm run lint
```

## Usage

1. After installing the extension, restart VSCode
2. A "Secondary Terminal" icon will appear in the sidebar
3. Click the icon to open the terminal panel
4. Use it like a regular terminal:
   - Execute commands
   - Edit files with vim (hjkl cursor movement supported)
   - Browse files with less
   - Other interactive applications
5. Use the built-in ACE editor to compose multi-line commands and send them to the terminal with `Cmd+Enter`
6. Paste images from clipboard using the 📷 button (macOS) — the image is saved to a temp file and inserted as `[@<filepath>]`
7. Drag & drop files onto the Drop Zone to insert file path references into the editor

## Settings

The following settings are available in VSCode Settings (search for "Secondary Terminal"):

| Setting | Type | Default | Description |
|---|---|---|---|
| `secondaryTerminal.fontFamily` | string | `"RobotoMono Nerd Font Mono", "RobotoMono Nerd Font", "Roboto Mono", Consolas, "Courier New", monospace` | Font family for the terminal and the ACE editor (CSS `font-family` format) |
| `secondaryTerminal.fontSize` | number | `13` | Font size in px for the terminal and the ACE editor (6–32) |
| `secondaryTerminal.lineHeight` | number | `1.2` | Terminal line height as a multiple of the font size (1–2) |
| `secondaryTerminal.letterSpacing` | number | `0` | Terminal letter spacing in px |
| `secondaryTerminal.layout.widthAdjustment` | number | `0.88` | Correction factor for character width used when calculating the number of columns. Font metrics differ between fonts, so adjust this when changing fonts. Smaller values produce more columns (0.5–1.5) |
| `secondaryTerminal.layout.heightAdjustment` | number | `1.34` | Correction factor for line height used when calculating the number of rows. Adjust when changing fonts. Smaller values produce more rows (0.5–2) |
| `secondaryTerminal.startupCommands` | array | `[]` | Commands automatically executed when the terminal starts |
| `secondaryTerminal.maxHistoryLines` | number | `1000` | Maximum number of history lines kept (applied to xterm scrollback and the session-restore buffer, minimum 50) |
| `secondaryTerminal.notifications.enabled` | boolean | `true` | Detect OSC notification sequences (OSC 9 / 777 / 99) in terminal output and show VSCode notifications |
| `secondaryTerminal.notifications.flashBackground` | boolean | `true` | Flash the terminal (webview) background briefly when an OSC notification is shown |

Font and layout settings are applied to all open terminal tabs immediately when changed. `maxHistoryLines` requires a webview reload (e.g. reopening the sidebar or `Developer: Reload Window`).

## Technical Specifications

- **Frontend**: High-performance terminal emulator using xterm.js
- **Backend**: Full pseudo-terminal implementation using Python's pty module
- **Communication**: Node.js child_process for communication between VSCode and Python
- **Character Encoding**: Full UTF-8 support
- **Shell**: zsh (default), with bash fallback

## Known Issues

- Currently only Unix-based OS (macOS, Linux) supported
- Some advanced terminal features (multiple panes, etc.) are not yet supported
- Does not work on Windows

### Performance Degradation with Large Scroll History
Terminal scrolling and UI responsiveness slow down as scroll history grows. This is a frontend-side issue unrelated to PTY. Rewriting PTY in Rust was attempted but showed no improvement (see feature/rust-pty branch), so the change was reverted.

## Developer Information

### File Structure

- `src/extension.ts`: Extension entry point
- `src/terminalProvider.ts`: Terminal provider implementation (tabs, ACE editor, PTY management)
- `src/clipboardImageHandler.ts`: macOS clipboard image extraction
- `src/dropZoneProvider.ts`: File drag & drop zone
- `src/terminalSessionManager.ts`: Terminal session persistence
- `src/shellProcessManager.ts`: Shell process lifecycle management
- `resources/terminal.html`: Main UI (xterm.js, ACE editor, tab bar)
- `resources/xterm.css`, `resources/xterm.js`: xterm.js library

### Key Features

1. **PTY Emulation**: Full pseudo-terminal implementation via Python script
2. **Dynamic Resizing**: Automatic resize based on HTML element dimensions
3. **Non-blocking I/O**: High-performance I/O processing using select

### Rust PTY Migration Attempt

A Rust-based PTY implementation was attempted to eliminate environment dependencies, but was abandoned due to macOS security restrictions. When spawning a binary located under `/Users/` from Node.js, PTY creation is blocked and the process immediately becomes a zombie. See `resources/pty-rs/README.md` in the feature/rust-pty-migration branch for details.

## License

MIT License

## Author

ytyng
