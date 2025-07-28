---
description: VSCode Side Launcher のローカルリリースを実行
allowed-tools: Bash, Edit, Read
---

# タスク

1. 未コミットの内容があれば、コミットする

2. バージョンを更新する
  - `npm run update-version` を実行する

3. ビルド
  - `npm run compile` を実行

4. バージョンアップをコミット
  - `git add .` を実行する
  - `git commit -am "Bump version to <新しいバージョン>"` を実行する

5. プッシュ
  - `git push` を実行する
