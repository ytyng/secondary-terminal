#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

// パッケージ.json とバージョン.json のパス
const packageJsonPath = path.join(__dirname, '..', 'package.json');
const versionJsonPath = path.join(__dirname, '..', 'src', 'version.json');

// package.json を読み取り
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));

// 現在の日時を取得
const now = new Date();
const buildDate = now.getFullYear() + '-' + 
  String(now.getMonth() + 1).padStart(2, '0') + '-' + 
  String(now.getDate()).padStart(2, '0') + ' ' +
  String(now.getHours()).padStart(2, '0') + ':' + 
  String(now.getMinutes()).padStart(2, '0');

// version.json を更新
const versionData = {
  version: packageJson.version,
  buildDate: buildDate
};

fs.writeFileSync(versionJsonPath, JSON.stringify(versionData, null, 2));

console.log(`Version updated to ${packageJson.version} with build date ${buildDate}`);