#!/usr/bin/env bash
set -euo pipefail

if [ -d .venv/bin ]; then
  export PATH="$PWD/.venv/bin:$PATH"
fi

has_script() {
  [ -f package.json ] && node -e 'const p=require("./package.json"); process.exit(p.scripts?.[process.argv[1]] ? 0 : 1)' "$1"
}

run_script() {
  if has_script "$1"; then bun run "$1"; fi
}

install() {
  if [ -f bun.lock ] || [ -f bun.lockb ]; then bun install --frozen-lockfile; fi
  if [ -f Cargo.toml ]; then cargo fetch --locked; fi
  if [ -f requirements.txt ] || [ -f requirements-dev.txt ]; then python -m venv .venv; fi
  if [ -f requirements.txt ]; then .venv/bin/python -m pip install --disable-pip-version-check -r requirements.txt; fi
  if [ -f requirements-dev.txt ]; then .venv/bin/python -m pip install --disable-pip-version-check -r requirements-dev.txt; fi
}

quality() {
  run_script format:check
  run_script lint
  if has_script type-check; then bun run type-check; elif has_script typecheck; then bun run typecheck; fi
  run_script build
  if [ -f Cargo.toml ]; then cargo fmt --check; cargo clippy --all-targets -- -D warnings; cargo check; fi
  if command -v ruff >/dev/null 2>&1; then ruff check .; fi
  if command -v python >/dev/null 2>&1; then
    py_dirs=()
    for dir in tests src scripts; do [ -d "$dir" ] && py_dirs+=("$dir"); done
    if [ "${#py_dirs[@]}" -gt 0 ]; then python -m compileall -q "${py_dirs[@]}"; fi
  fi
}

test() {
  if has_script test:coverage; then bun run test:coverage; elif has_script test; then bun run test; fi
  if [ -f Cargo.toml ]; then cargo test --all-features; fi
  if [ -d tests ] && python -c 'import importlib.util; raise SystemExit(importlib.util.find_spec("pytest") is None)' 2>/dev/null; then python -m pytest -q --cov --cov-report=term-missing; fi
}

case "${1:-}" in
  install|quality|test) "$1" ;;
  *) echo "usage: $0 {install|quality|test}" >&2; exit 2 ;;
esac
