#!/usr/bin/env bash
set -euo pipefail

if [ -d .venv/bin ]; then export PATH="$PWD/.venv/bin:$PATH"; fi

has_script() {
  [ -f package.json ] && node -e 'const p=require("./package.json"); process.exit(p.scripts?.[process.argv[1]] ? 0 : 1)' "$1"
}

package_manager() {
  if [ -f bun.lock ] || [ -f bun.lockb ]; then echo bun
  elif [ -f pnpm-lock.yaml ]; then echo pnpm
  elif [ -f yarn.lock ]; then echo yarn
  elif [ -f package-lock.json ]; then echo npm
  else echo bun
  fi
}

run_script() {
  if ! has_script "$1"; then echo "Skipping $1 (script not defined)"; return; fi
  case "$(package_manager)" in
    bun) bun run "$1" ;;
    pnpm) pnpm run "$1" ;;
    yarn) yarn "$1" ;;
    npm) npm run "$1" ;;
  esac
}

install() {
  if [ -f package.json ]; then
    case "$(package_manager)" in
      bun) bun install --frozen-lockfile ;;
      pnpm) corepack pnpm install --frozen-lockfile ;;
      yarn) corepack yarn install --immutable ;;
      npm) npm ci ;;
    esac
  fi
  if [ -f Cargo.toml ]; then cargo fetch --locked; fi
  if [ -f requirements.txt ] || [ -f requirements-dev.txt ]; then python -m venv .venv; fi
  if [ -f requirements.txt ]; then .venv/bin/python -m pip install --disable-pip-version-check -r requirements.txt; fi
  if [ -f requirements-dev.txt ]; then .venv/bin/python -m pip install --disable-pip-version-check -r requirements-dev.txt; fi
}

format() {
  run_script format:check
  if [ -f Cargo.toml ]; then cargo fmt --check; fi
}

lint() {
  run_script lint
  if [ -f Cargo.toml ]; then cargo clippy --all-targets -- -D warnings; fi
  if command -v ruff >/dev/null 2>&1; then ruff check .; fi
}

type_check() {
  if has_script type-check; then bun run type-check
  elif has_script typecheck; then bun run typecheck
  else echo "Skipping type-check (script not defined)"; fi
  if [ -f Cargo.toml ]; then cargo check; fi
  if command -v python >/dev/null 2>&1; then
    py_dirs=()
    for dir in tests src scripts; do [ -d "$dir" ] && py_dirs+=("$dir"); done
    if [ "${#py_dirs[@]}" -gt 0 ]; then python -m compileall -q "${py_dirs[@]}"; fi
  fi
}

build() { run_script build; }

test() {
  if has_script test:coverage; then bun run test:coverage
  elif has_script test; then bun run test
  else echo "Skipping JavaScript/TypeScript tests (script not defined)"; fi
  if [ -f Cargo.toml ]; then cargo test --all-features; fi
  if [ -d tests ] && python -c 'import importlib.util; raise SystemExit(importlib.util.find_spec("pytest") is None)' 2>/dev/null; then
    python -m pytest -q --cov --cov-report=term-missing
  else
    echo "Skipping Python tests (pytest or tests directory not found)"
  fi
}

case "${1:-}" in
  install|format|lint|type_check|build|test) "$1" ;;
  *) echo "usage: $0 {install|format|lint|type_check|build|test}" >&2; exit 2 ;;
esac
