#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// パッケージ.json とバージョン.json のパス
const packageJsonPath = path.join(__dirname, '..', 'package.json');
const versionJsonPath = path.join(__dirname, '..', 'src', 'version.json');

// package.json を読み取り
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));

// 現在のバージョンの major.minor 部分を取得
const currentVersion = packageJson.version;
const versionParts = currentVersion.split('.');
const major = versionParts[0];
const minor = versionParts[1];

// Git のコミット数を取得
let commitCount;
try {
  commitCount = execSync('git rev-list --count HEAD', { encoding: 'utf8' }).trim();
} catch (error) {
  console.error('Error getting git commit count:', error.message);
  // Git リポジトリが存在しない場合は現在のパッチバージョンを使用
  commitCount = versionParts[2] || '0';
}

// 新しいバージョン番号を構築
const newVersion = `${major}.${minor}.${commitCount}`;

// package.json のバージョンを更新
packageJson.version = newVersion;
fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2) + '\n');

// 現在の日時を取得
const now = new Date();
const updatedAt = now.getFullYear() + '-' +
  String(now.getMonth() + 1).padStart(2, '0') + '-' +
  String(now.getDate()).padStart(2, '0') + ' ' +
  String(now.getHours()).padStart(2, '0') + ':' +
  String(now.getMinutes()).padStart(2, '0');

// version.json を更新
const versionData = {
  version: newVersion,
  updatedAt: updatedAt
};

fs.writeFileSync(versionJsonPath, JSON.stringify(versionData, null, 2));

console.log(`Version updated to ${newVersion} with updated date ${updatedAt}`);
