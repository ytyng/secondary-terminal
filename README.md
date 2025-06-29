# Secondary Terminal

VSCode のサイドバーで動作する本格的なターミナル拡張機能です。完全な PTY エミュレーションにより、vim や less などのインタラクティブなアプリケーションも正常に動作します。

## 機能

- **サイドバーターミナル**: VSCode のサイドバーに統合されたターミナル
- **完全な PTY エミュレーション**: Python を使用した本格的な疑似ターミナル実装
- **インタラクティブアプリサポート**: vim、less、nano などが完全動作
- **動的サイズ調整**: サイドバーのサイズに応じて自動的にターミナルサイズを調整
- **UTF-8 対応**: 日本語などのマルチバイト文字を正しく表示
- **カスタムフォント**: RobotoMono Nerd Font に対応

## 必要条件

- Visual Studio Code 1.101.0 以上
- Python 3.x（PTY エミュレーション用）
- macOS / Linux（現在は Unix 系 OS のみサポート）

## インストール方法

### 開発版インストール

1. このリポジトリをクローン:
   ```bash
   git clone <repository-url>
   cd secondary-terminal
   ```

2. 依存関係をインストール:
   ```bash
   npm install
   ```

3. TypeScript をコンパイル:
   ```bash
   npm run compile
   ```

4. VSCode で開発モードで実行:
   - VSCode でプロジェクトを開く
   - F5 キーを押して拡張機能をデバッグモードで起動
   - 新しい VSCode ウィンドウが開き、拡張機能が利用可能になります

### ローカルインストール

拡張機能をローカルの VSCode にインストールするには、プロジェクトディレクトリのパスをコピーして、VSCode のコマンドパレット（Cmd+Shift+P）で：

```
Developer: Install Extension from Location...
```

を実行し、プロジェクトディレクトリのパス（例：`/Users/ytyng/workspace/secondary-terminal`）を指定してください。

### シンボリックリンクでインストール

より簡単な方法として、拡張機能ディレクトリにシンボリックリンクを作成できます：

```bash
# 通常の VSCode の場合
ln -s /Users/ytyng/workspace/secondary-terminal ~/.vscode/extensions/secondary-terminal

# VSCode Insiders の場合
ln -s /Users/ytyng/workspace/secondary-terminal ~/.vscode-insiders/extensions/secondary-terminal
```

その後、VSCode を再起動してください。

### コード修正後の再インストール

拡張機能のコードを修正した場合の更新手順：

1. **TypeScript をコンパイル**:
   ```bash
   npm run compile
   # または、変更を監視して自動コンパイル
   npm run dev
   ```

2. **VSCode で拡張機能を再読み込み**:
   - コマンドパレット（Cmd+Shift+P）を開く
   - `Developer: Reload Window` を実行
   - または VSCode を完全に再起動

3. **開発モードでのテスト**:
   - プロジェクトを VSCode で開く
   - F5 キーでデバッグモードで起動
   - 新しいウィンドウで修正内容をテスト

### 開発用コマンド

```bash
# 自動コンパイル（ファイル変更監視）
npm run dev

# 出力ディレクトリをクリーンアップ
npm run clean

# クリーンアップ後に再コンパイル
npm run rebuild

# コードの文法チェック
npm run lint
```

## 使用方法

1. 拡張機能をインストール後、VSCode を再起動
2. サイドバーに「Secondary Terminal」アイコンが表示されます
3. アイコンをクリックしてターミナルパネルを開く
4. 通常のターミナルと同様に使用可能：
   - コマンド実行
   - vim でのファイル編集（hjkl カーソル移動対応）
   - less でのファイル閲覧
   - その他インタラクティブアプリケーション

## 技術仕様

- **フロントエンド**: xterm.js による高性能ターミナルエミュレーター
- **バックエンド**: Python の pty モジュールによる完全な疑似ターミナル実装
- **通信**: Node.js child_process による VSCode と Python 間の通信
- **文字エンコーディング**: UTF-8 完全対応
- **シェル**: zsh（デフォルト）、bash へのフォールバック対応

## 既知の問題

- 現在は Unix 系 OS（macOS、Linux）のみサポート
- 一部の高度なターミナル機能（複数ペイン等）は未対応
- Windows では動作しません

## 開発者向け情報

### ファイル構成

- `src/extension.ts`: 拡張機能のエントリーポイント
- `src/terminalProvider.ts`: ターミナルプロバイダーの実装
- `resources/`: xterm.js のリソースファイル

### 主要機能

1. **PTY エミュレーション**: Python スクリプトによる完全な疑似ターミナル実装
2. **動的サイズ調整**: HTML エレメントサイズに基づく自動リサイズ
3. **非ブロッキング I/O**: select を使用した高性能な入出力処理

## ライセンス

MIT License

## 作者

ytyng

---

**楽しんでお使いください！**