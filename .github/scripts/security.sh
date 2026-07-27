#!/usr/bin/env bash
set -euo pipefail

has_dependency_manifest() {
  [ -f package.json ] || [ -f Cargo.toml ] || [ -f requirements.txt ] ||
    [ -f requirements-dev.txt ] || [ -f pyproject.toml ]
}

should_run() {
  if has_dependency_manifest; then
    printf '%s\n' 'applicable=true'
  else
    printf '%s\n' 'applicable=false'
  fi
}

if [ "${1:-audit}" = should_run ]; then
  should_run
  exit 0
fi

if [ "${1:-audit}" != audit ]; then
  echo "usage: $0 [audit|should_run]" >&2
  exit 2
fi

audits=0

package_manager() {
  if [ -f bun.lock ] || [ -f bun.lockb ]; then echo bun
  elif [ -f pnpm-lock.yaml ]; then echo pnpm
  elif [ -f yarn.lock ]; then echo yarn
  elif [ -f package-lock.json ]; then echo npm
  else echo none
  fi
}

if [ -f package.json ]; then
  audit_args=(--audit-level=high)
  if [ -f .github/security-audit-allowlist.txt ]; then
    while IFS= read -r advisory; do
      [[ -z "$advisory" || "$advisory" == \#* ]] && continue
      audit_args+=(--ignore "$advisory")
    done < .github/security-audit-allowlist.txt
  fi
  case "$(package_manager)" in
    bun) audits=$((audits + 1)); bun audit "${audit_args[@]}" ;;
    pnpm) audits=$((audits + 1)); corepack pnpm audit --audit-level high ;;
    yarn) audits=$((audits + 1)); corepack yarn npm audit --all --recursive ;;
    npm) audits=$((audits + 1)); npm audit --audit-level=high ;;
  esac
else
  echo "Skipping JavaScript/TypeScript audit (package.json not found)"
fi

if [ -f Cargo.toml ]; then
  audits=$((audits + 1))
  if ! command -v cargo-audit >/dev/null 2>&1; then cargo install cargo-audit --locked --quiet; fi
  cargo audit
else
  echo "Skipping Rust audit (Cargo.toml not found)"
fi

if [ -f requirements.txt ] || [ -f requirements-dev.txt ] || [ -f pyproject.toml ]; then
  audits=$((audits + 1))
  if command -v uv >/dev/null 2>&1; then
    pip_audit() { uv tool run --from pip-audit pip-audit "$@"; }
  else
    python -m pip install --disable-pip-version-check --quiet pip-audit
    pip_audit() { python -m pip_audit "$@"; }
  fi
  if [ -f requirements.txt ]; then pip_audit -r requirements.txt; fi
  if [ -f requirements-dev.txt ]; then pip_audit -r requirements-dev.txt; fi
  if [ -f pyproject.toml ] && [ ! -f requirements.txt ] && [ ! -f requirements-dev.txt ]; then pip_audit; fi
else
  echo "Skipping Python audit (Python dependency manifest not found)"
fi

if [ "$audits" -eq 0 ]; then echo "No supported dependency manifests found; nothing to audit"; fi
