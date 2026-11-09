#!/bin/sh
# Install pinned WASI CPython; never used to execute app code on the host.
set -eu
repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
target_dir=${1:-"$repo_dir/engine/.python-wasm"}
version=3.13.17
archive=python-$version-wasi_sdk-24.zip
digest=ceec2512d4bf2d2377a4791603e9879329c9b6aa0e7514a19ef827cdefe3b274
if [ -f "$target_dir/.version" ] && [ "$(cat "$target_dir/.version")" = "$version" ] && [ -f "$target_dir/python.wasm" ] && [ -d "$target_dir/lib" ]; then
  echo "Python Wasm $version already installed at $target_dir"
  exit 0
fi
work_dir=$(mktemp -d)
trap 'rm -rf "$work_dir"' EXIT HUP INT TERM
curl -fsSL --retry 3 "https://github.com/brettcannon/cpython-wasi-build/releases/download/v$version/$archive" -o "$work_dir/$archive"
if command -v sha256sum >/dev/null 2>&1; then
  actual_digest=$(sha256sum "$work_dir/$archive" | cut -d ' ' -f 1)
else
  actual_digest=$(shasum -a 256 "$work_dir/$archive" | cut -d ' ' -f 1)
fi
[ "$actual_digest" = "$digest" ] || { echo "Python Wasm checksum mismatch" >&2; exit 1; }
mkdir -p "$target_dir"
unzip -oq "$work_dir/$archive" -d "$target_dir"
echo "$version" > "$target_dir/.version"
echo "Installed Python Wasm $version at $target_dir"
