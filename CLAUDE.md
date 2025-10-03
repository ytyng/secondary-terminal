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

## ファイル構成

```
secondary-terminal/
├── src/
│   ├── extension.ts          # 拡張機能エントリーポイント
│   └── terminalProvider.ts   # ターミナルプロバイダー実装
├── resources/
│   ├── xterm.css            # xterm.js スタイルシート
│   └── xterm.js             # xterm.js ライブラリ
├── out/                     # コンパイル済み JavaScript
├── package.json             # プロジェクト設定
├── tsconfig.json           # TypeScript 設定
├── README.md               # ユーザー向けドキュメント
└── CLAUDE.md              # 開発者向けドキュメント（このファイル）
```

## 主要機能実装詳細

### TerminalProvider クラス
- WebView の HTML 生成と管理
- Python PTY プロセスの起動・管理
- 入出力データの変換・転送
- ターミナルサイズの動的調整

### Python PTY スクリプト
- 疑似ターミナル（PTY）の作成と管理
- シェルプロセス（zsh/bash）の起動
- 非ブロッキング I/O による入出力処理
- ターミナルサイズ変更の処理

### フロントエンド JavaScript
- xterm.js ターミナルの初期化
- フォントメトリクスの測定
- 動的サイズ調整ロジック
- VSCode との通信インターフェース

## 開発・テスト環境

- **OS**: macOS（開発・テスト対象）
- **Node.js**: 20.18.2
- **Python**: 3.13.3
- **VSCode**: 1.101.0+
- **TypeScript**: 5.8.3

## 既知の問題

使っていると、次第に動作が遅くなる。
原因は不明。

改善したいが原因がわからない。

遅くなる原因を調査するため、Performanc3e Metrics HID を表示する機能をつけて、それで計測しているが、原因はわからない。


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
- **ビルド情報**: `src/version.json` でバージョン番号とビルド日時を記録
- **自動更新**: ビルド時に自動的にビルド日時が更新される

#### バージョンアップ手順
1. **パッチバージョンアップ** (自動インクリメント):
   ```bash
   npm run increment-version
   ```
   - package.json のバージョンを自動で 0.0.1 増加
   - src/version.json のバージョンとビルド日時を自動更新

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
├── src/version.json          # バージョン + ビルド日時
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
**最終更新**: 2025年7月27日