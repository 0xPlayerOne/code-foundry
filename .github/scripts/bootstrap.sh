#!/usr/bin/env bash
set -euo pipefail

git config core.hooksPath .githooks

if [ -f .mise.toml ] && command -v mise >/dev/null 2>&1; then
  mise trust --yes .mise.toml >/dev/null 2>&1 || true
  if [ -f .mise.toml ] && [ ! -f mise.lock ]; then
    if MISE_TRUSTED_CONFIG_PATHS="$PWD" mise lock >/dev/null 2>&1; then
      printf '%s\n' 'Initialized mise.lock for deterministic CI tool installs.'
    else
      printf '%s\n' 'Warning: mise.lock could not be generated; continuing with pinned tool resolution.' >&2
    fi
  fi
  mise install
else
  printf '%s\n' 'Using the repository-native toolchain (mise is optional).'
fi

bash .github/scripts/doctor.sh
