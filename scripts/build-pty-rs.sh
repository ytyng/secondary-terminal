#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")"/.. && pwd)"
cd "$ROOT_DIR/resources/pty-rs"

if ! command -v cargo >/dev/null 2>&1; then
  echo "cargo not found. Please install Rust toolchain (rustup)." >&2
  exit 1
fi

echo "Building Rust PTY backend (release)..."
cargo build --release

BIN_PATH="$(pwd)/target/release/pty_rs"
OUT_BIN="$ROOT_DIR/resources/pty-shell-rs"
cp "$BIN_PATH" "$OUT_BIN"
chmod +x "$OUT_BIN"
echo "Built $OUT_BIN"
