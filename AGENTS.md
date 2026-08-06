# Secondary Terminal - VSCode 拡張機能

VSCode のサイドバーで動作する高機能ターミナル拡張機能の開発プロジェクトです。

## プロジェクト概要

この拡張機能は、VSCode のサイドバーに完全機能のターミナルを提供します。Python の PTY モジュールを使用した本格的な疑似ターミナル実装により、vim や less などのインタラクティブアプリケーションも正常に動作します。

## 技術的特徴

### アーキテクチャ

- **フロントエンド**: xterm.js による高性能ターミナルエミュレーター
- **ミドルウェア**: Node.js child_process による VSCode と Python 間の通信
- **バックエンド**: Python の pty モジュールによる疑似ターミナル実装

### 実装のポイント

1. **PTY エミュレーション**
   - Python の `pty.openpty()` を使用した本格的な疑似ターミナル作成
   - `fcntl` による非ブロッキング I/O の実装
   - `select.select()` を使用した効率的な入出力多重化

2. **動的サイズ調整**
   - ResizeObserver による HTML エレメントサイズ監視
   - フォントメトリクスの正確な測定
   - PTY ウィンドウサイズの自動調整（TIOCSWINSZ ioctl）

3. **文字エンコーディング**
   - UTF-8 完全対応
   - マルチバイト文字の正しい表示
   - エンコーディングエラー時のフォールバック処理

4. **インタラクティブアプリサポート**
   - vim の hjkl カーソル移動対応
   - less のページング機能
   - Control-C、Control-Z の適切な処理
   - SIGWINCH シグナルによるターミナルサイズ変更通知

## 開発経緯

### 初期実装
- 基本的な WebView ベースのターミナル表示
- xterm.js の統合
- 単純なコマンド実行機能

### 中間段階
- node-pty の導入試行（VSCode Electron 環境での互換性問題により断念）
- Python を使用した PTY エミュレーションへの切り替え

### 最終実装
- 完全な PTY サポートの実現
- インタラクティブアプリケーションの完全対応
- 動的サイズ調整機能の実装

## 技術的課題と解決策

### 1. VSCode 環境での node-pty 問題
**課題**: VSCode の Electron 環境で node-pty のネイティブモジュールが正しくビルドできない
**解決**: Python の pty モジュールを使用したカスタム PTY エミュレーション

### 2. 非ブロッキング I/O
**課題**: VSCode 環境での stdin 読み取りのブロッキング問題
**解決**: `fcntl` による非ブロッキング設定と `select` による多重化

### 3. 文字エンコーディング
**課題**: マルチバイト文字の文字化け
**解決**: UTF-8 統一処理とエラー時のフォールバック機能

### 4. ターミナルサイズ調整
**課題**: サイドバーサイズに応じた適切なターミナルサイズ設定
**解決**: HTML エレメントサイズからの正確な計算とリアルタイム調整

**cols は「見積もり」ではなく実測セル幅で決める** (`setTerminalSize` / `measureActualCellWidth`):
測定用 div の文字幅 × 補正係数から出した見積もりは、xterm が実際に使うセル幅と
一致するとは限らない (フォントのフォールバック、xterm 内部の丸め、letterSpacing の
扱いの差)。見積もりが 1px でも小さいと `cols × 実セル幅` がペイン幅を超え、
**長い行を表示した時だけ**右にはみ出して横スクロールが発生し、戻せなくなる
(`.xterm-viewport` は xterm.css が `overflow-y: scroll` だけを指定するため、CSS の
規則で overflow-x が実質 auto = 横スクロールコンテナになっている)。
描画済みの `.xterm-screen` の幅は `cols × セル幅` なので、`screen.width / term.cols`
で実セル幅が正確に逆算できる。この値は cols に依存しないので、そこから出した cols は
次回の計算でも同じ値になりリサイズが往復しない。初回描画前は測れないため見積もりで
暫定サイズを入れ、`requestAnimationFrame` で測れるまで再試行する (上限あり)。
列数を出す時は 1px 余らせる (`CELL_FIT_SLACK_PX`): xterm はキャンバス幅をデバイス
ピクセル単位に丸めてから CSS 幅にするため実測セル幅に丸め誤差が乗り、ぴったり
割り切れる幅では列数が 1 多く出る → 次の計算で 1 少なく出る、という往復が起きうる。
さらに**列数・行数を変えたら次のフレームで測り直す**: 実測セル幅の誤差は 1 セルあたり
最大 `0.5 / cols` px なので、ペインが大きく広がって列数が増えると誤差が積み上がって
1px のスラックを超えうる。リサイズ後の (列数が増えたぶん精度の上がった) 実測値で
計算し直せば正しい土台に載り直せる。変化が無くなった時点で止まる。
ユーザー設定 `widthAdjustment` は実測値にも掛けるが、**実測セル幅で実際に収まる
列数を上限にクランプする** (既定値 0.88 は見積もりのズレを埋める係数なので、
そのまま掛けるとはみ出しが復活する)。

## ファイル構成

```
secondary-terminal/
├── src/
│   ├── extension.ts                # 拡張機能エントリーポイント、コマンド登録
│   ├── terminalProvider.ts         # ターミナルプロバイダー（タブ管理、ACE エディタ、PTY）
│   ├── clipboardImageHandler.ts    # macOS クリップボード画像抽出
│   ├── dropZoneProvider.ts         # ファイル Drag & Drop ゾーン
│   ├── terminalSessionManager.ts   # ターミナルセッション永続化
│   ├── agentSessionRestore.ts      # 前回使った CLI エージェント (Claude Code / Codex) の記録と復元提案
│   ├── shellProcessManager.ts      # シェルプロセスライフサイクル管理
│   └── utils.ts                    # ユーティリティ関数
├── resources/
│   ├── terminal.html        # メイン UI（xterm.js、ACE エディタ、タブバー）
│   ├── xterm.css            # xterm.js スタイルシート
│   ├── xterm.js             # xterm.js ライブラリ
│   └── version.json         # バージョン + ビルド日時 (src/ は .vscodeignore で除外されるためここに置く)
├── scripts/
│   └── update-version.js    # バージョン情報更新スクリプト
├── out/                     # コンパイル済み JavaScript
├── package.json             # プロジェクト設定
├── tsconfig.json            # TypeScript 設定
├── README.md                # ユーザー向けドキュメント
└── CLAUDE.md                # 開発者向けドキュメント（このファイル）
```

## 主要機能実装詳細

### TerminalProvider クラス (`terminalProvider.ts`)
- WebView の HTML 生成と管理
- Python PTY プロセスの起動・管理
- 入出力データの変換・転送
- ターミナルサイズの動的調整
- マルチタブ管理（タブごとに独立したシェルプロセスと ACE エディタ）

### CLI エージェントのセッション復元 (`agentSessionRestore.ts`)
- pty-shell.py が既に出している CLI エージェントの稼働状態 (OSC 777 の `cli_agent_status`。
  シェルの子孫プロセスを見て判定している) を**拡張ホスト側でも拾い**、
  「このワークスペースで使っていたエージェント」として `globalState` に記録する
  (キーは cwd、14 日で失効)。出力の覗き見は `ShellProcessManager.addOutputObserver` 経由
- **入力行からコマンド名を拾う方式にしないこと**: 履歴 (↑ キー) から呼び出した場合や補完で
  確定した場合、コマンド文字列は拡張を通らずシェル内で確定するため、最も普通の起動方法を
  取りこぼす。稼働プロセスを見ている PTY 側の判定の方が正確
- 空のターミナルが立ち上がったとき、記録があれば
  `Restore the previous <Claude Code|Codex> session?` を確認し、Yes なら
  `claude --continue` / `codex resume --last` をそのタブへ送る
- **セッション ID を拡張側で管理しない**のが要点。`~/.claude/projects/` や `~/.codex/sessions/`
  の場所・命名規則は CLI の内部実装なので、追随すると壊れる。「直前のセッションを継続する」
  コマンドはどちらの CLI も持っているので、その解決は CLI に任せる
- **復元候補はウィンドウ起動時の 1 回だけ読む** (`_restoreCandidate`)。提案する直前に読み直すと、
  同じウィンドウで今さっき起動したエージェントを「前回のセッション」として提案し、
  別タブで動いているセッションへ二重に接続しかねない
- 確認は 1 ウィンドウにつき 1 回、かつ**バッファが空の (新規に立ち上がった) タブだけ**。
  再接続時にも聞くと、既に動いているエージェントの上にもう 1 つ起動しかねない
- **記録はワークスペースごとに独立した `globalState` のキーへ書く** (`...lastAgentLaunch:<cwd>`)。
  1 つのオブジェクトにまとめると、同じプロファイルで開いた別ウィンドウが同じスナップショットを
  読んで丸ごと書き戻し、相手のワークスペースの記録を消す。拡張ホストはウィンドウごとに別プロセスなので
  こちら側の直列化では防げない。キーが増え続けないよう、起動時に失効分だけを掃除する
- 設定 `secondaryTerminal.restorePreviousAgentSession` (既定 true) で無効化できる
- pty-shell.py は gemini / copilot も検出するが、「直前のセッションを継続する」コマンドを
  持つ claude / codex だけを対象にしている

### クリップボード画像ハンドラー (`clipboardImageHandler.ts`)
- macOS の NSPasteboard から PNG/TIFF 画像を抽出（AppleScript 経由）
- `/tmp/secondary-terminal/attachments/` に UUID7 ベースのファイル名で保存
- ファイルパスを `[@<filepath>]` 形式でエディタに挿入

### Drop Zone プロバイダー (`dropZoneProvider.ts`)
- VSCode サイドバーの TreeView として実装
- `text/uri-list` MIME タイプのファイルドロップを受け付け
- ドロップされたファイルパスを `[@<path>]` 形式で ACE エディタに送信

### Python PTY スクリプト
- 疑似ターミナル（PTY）の作成と管理
- シェルプロセス（zsh/bash）の起動
- 非ブロッキング I/O による入出力処理
- ターミナルサイズ変更の処理

### フロントエンド (`resources/terminal.html`)
- xterm.js ターミナルの初期化
- フォントメトリクスの測定
- 動的サイズ調整ロジック
- VSCode との通信インターフェース
- タブごとに独立した ACE エディタインスタンス（ace-builds ライブラリ、VSCode キーバインド）
- `Cmd+Enter` でエディタ内容をターミナルに送信
- Trim Lines（各行の前後空白除去）機能

## 開発・テスト環境

- **OS**: macOS（開発・テスト対象）
- **Node.js**: 20.18.2
- **Python**: 3.13.3
- **VSCode**: 1.101.0+
- **TypeScript**: 5.8.3

## 既知の問題

### 「使っていると次第に動作が遅くなる」問題 (2026-07-03 に原因候補を修正済み)

長らく原因不明だったが、2026-07-03 の全体コードレビュー (PR #16) で以下の蓄積要因を特定し修正した。

- タブ開閉のたびに `TerminalSessionManager.sessions` Map が無限増加 (`removeSession` 未使用)
- リセットのたびに pty-shell.py プロセスが孤立して蓄積 (`resetTerminal` のマルチタブ未対応)
- pty-shell.py が子孫プロセス数に比例した回数の pgrep を 3 秒ごとに spawn
- タブクローズ後も残る `waitForSize` の 10ms 無限ポーリング
- `resolveWebviewView` 再解決時の WebviewView / リスナー残留

修正後も遅くなる場合は、`ps aux | grep pty-shell` でプロセス数、
`getSessionInfo()` (デバッグ用) で Map サイズを確認すること。

### pty-shell.py の実動テストは Claude Code のサンドボックスでは不可

Claude Code の Bash ツールのサンドボックスは `/dev/ptmx` へのアクセスをブロックするため、
`pty.openpty()` が `OSError: out of pty devices` で失敗する
(`dangerouslyDisableSandbox` や `/sandbox` での無効化でも回避できない別レイヤー)。
PTY を伴う動作確認は、ロジックの単体シミュレーション (デコード処理等) と、
拡張のリロードによる実機確認で行うこと。


## インストール・開発手順

### 初回セットアップ
```bash
# リポジトリをクローン
git clone <repository-url>
cd secondary-terminal

# 依存関係インストール
npm install

# TypeScript コンパイル
npm run compile
```

### 開発環境での実行
```bash
# VSCode でプロジェクトを開く
code .

# F5 キーでデバッグ実行
# または「Run and Debug」パネルから「Run Extension」を実行
```

### ローカルインストール
VSCode のコマンドパレットで：
```
Developer: Install Extension from Location...
```
を実行し、プロジェクトディレクトリを指定。

### コード修正・更新ワークフロー

1. **コード修正**:
   - `src/extension.ts` または `src/terminalProvider.ts` を編集

2. **コンパイル**:
   ```bash
   npm run compile
   ```

3. **テスト方法**:
   - **開発モード**: F5 でデバッグウィンドウを起動
   - **インストール済み拡張**: `Developer: Reload Window` で再読み込み

4. **デバッグ**:
   - VSCode の開発者ツール: `Help > Toggle Developer Tools`
   - コンソールログで動作確認
   - `console.log()` をコードに追加してデバッグ

### バージョン管理とリリースワークフロー

#### バージョン番号管理
- **現在のバージョン**: `package.json` の `version` フィールドで管理
- **ビルド情報**: `resources/version.json` でバージョン番号とビルド日時を記録 (src/ は .vscodeignore でパッケージから除外されるため resources/ に置く)
- **自動更新**: ビルド時に自動的にビルド日時が更新される

#### バージョンアップ手順
1. **パッチバージョンアップ** (自動インクリメント):
   ```bash
   npm run increment-version
   ```
   - package.json のバージョンを自動で 0.0.1 増加
   - resources/version.json のバージョンとビルド日時を自動更新
   - **注意**: 内部の `npm version patch` は working tree がクリーンでないと失敗する。
     未コミットの変更がある状態 (コミット直前の通常フロー) では、代わりに以下を実行する:
     ```bash
     npm version patch --no-git-tag-version && npm run update-version
     ```
   - **パッチ番号の実体**: `scripts/update-version.js` はパッチ番号を `git rev-list --count HEAD`
     (コミット数) で上書きする。`npm version patch` の表示と最終バージョンがずれるのは正常。
   - **package-lock.json の同期**: update-version.js は package.json を直接書き換えるため、
     lockfile のバージョンが古いまま残る (PR #15 で Codex に指摘された)。バージョン更新後は
     `npm install --package-lock-only` を実行して lockfile も同期し、一緒にコミットすること。

2. **手動バージョン更新**:
   ```bash
   # package.json のバージョンを手動変更後
   npm run update-version
   ```

3. **リリース準備**:
   ```bash
   npm run increment-version  # バージョンアップ
   npm run compile           # ビルド
   git add .
   git commit -m "バージョン X.X.X リリース"
   git push origin main
   ```

#### バージョン管理ルール
- **コミットごと**: 毎回のコミット前に `npm run increment-version` を実行
- **ビルドごと**: `npm run compile` 実行時に自動でビルド日時が更新
- **リリース**: 機能追加・修正完了時にバージョンアップしてコミット

#### ファイル構成（バージョン管理関連）
```
secondary-terminal/
├── package.json              # メインバージョン番号
├── resources/version.json    # バージョン + ビルド日時
├── scripts/update-version.js # バージョン情報更新スクリプト
└── out/                      # コンパイル済み（バージョン情報含む）
```

### よくある開発作業

#### Python PTY スクリプトの修正
- `terminalProvider.ts` 内の `pythonScript` 変数を編集
- コンパイル後、拡張機能を再読み込み

#### フロントエンド（HTML/JavaScript）の修正
- `_getHtmlForWebview()` メソッド内の HTML/CSS/JavaScript を編集
- xterm.js の設定変更
- ターミナルサイズ計算ロジックの調整

#### UI の変更
- `package.json` の `contributes` セクションでアイコンやメニューを変更
- VSCode API の追加機能実装

#### 設定項目の追加・変更 (日英対応)
- 設定の説明文は VSCode 標準の NLS 機構で日英対応している (PR #15 以降)
- `package.json` の `description` には `%configuration.<key>.description%` プレースホルダを書く
- 実際の文言は `package.nls.json` (英語・デフォルト) と `package.nls.ja.json` (日本語) に書く。
  **設定を追加・変更するときは必ず両ファイルにキーを追加すること** (片方に無いとキー名がそのまま表示される)
- README.md の Settings テーブル (英語) にも同じ設定の行を追記すること

### トラブルシューティング

#### 拡張機能が認識されない
```bash
# package.json の構文確認
npm run compile
# エラーがないか確認
```

#### ターミナルが起動しない
- 開発者ツールのコンソールでエラー確認
- Python 3.x がインストールされているか確認
- PTY 関連のエラーメッセージを確認

#### 文字化けや入力エラー
- UTF-8 エンコーディングの確認
- Python スクリプトの非ブロッキング I/O 設定確認

## 関連技術・参考資料

- [VSCode Extension API](https://code.visualstudio.com/api)
- [xterm.js](https://xtermjs.org/)
- [Python pty module](https://docs.python.org/3/library/pty.html)
- [Linux PTY documentation](https://man7.org/linux/man-pages/man7/pty.7.html)

## 絵文字表示幅問題の調査結果

### 問題の概要
- ターミナルで絵文字が半角幅でしか表示されない（VSCode 標準ターミナルでは全角幅で正常表示）
- xterm.js の `wcwidth` パラメーターが Canvas レンダラーで無視される

### 調査した解決方法と結果

#### 1. `wcwidth` パラメーターによる文字幅指定
```javascript
// ❌ 効果なし
wcwidth: (codepoint) => {
    // 絵文字を全角幅(2)として指定
    if (/* 絵文字の範囲 */) return 2;
    return 1;
}
```
**結果**: Canvas レンダラーでは完全に無視される

#### 2. Unicode 11 アドオンの使用
```javascript
// ❌ 部分的効果のみ
const unicode11 = new Unicode11Addon.Unicode11Addon();
term.loadAddon(unicode11);
unicode11.activate(term);
```
**結果**: アドオンは読み込まれるが、Canvas レンダラーの文字幅計算には影響しない

#### 3. VSCode 互換設定
```javascript
// ❌ 効果なし
rescaleOverlappingGlyphs: true,
customGlyphs: true
```
**結果**: xterm.js v5.5.0 ではこれらのオプションが認識されない

### 問題の根本原因
- xterm.js v5.5.0 + Canvas レンダラーは独自の文字幅計算を使用
- `wcwidth` オプションやアドオンによる文字幅指定を無視
- Canvas レンダラーは DOM レンダラーと異なる文字幅処理を実装

### 今後の解決方向性
1. **Canvas レンダラーの内部 API ハック**: `_charAtlas._ctx.measureText` 等の内部実装を直接操作
2. **DOM レンダラーへの切り替え**: パフォーマンスを犠牲にして文字幅精度を優先
3. **xterm.js のバージョン変更**: 絵文字対応が改善されたバージョンへの更新
4. **代替ライブラリの検討**: xterm.js 以外のターミナルエミュレーターライブラリの採用

### 保持したもの
- Unicode 11 アドオンのインストールと基本設定
- Canvas アドオンの読み込み
- 将来の解決に向けた基盤コード

---

**開発者**: ytyng
**作成日**: 2025年6月28日
**最終更新**: 2026年1月30日