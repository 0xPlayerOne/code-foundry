#!/usr/bin/env bash

# Shared pull-request change detection. A failed or incomplete diff must be
# treated as relevant so checks never become silently optional.
repo_foundry_changed_files() {
  local base_sha="${REPO_FOUNDRY_BASE_SHA:-}"
  local head_sha="${GITHUB_SHA:-HEAD}"
  local changed_files=""

  if [ -n "$base_sha" ] && [ "$base_sha" != "0000000000000000000000000000000000000000" ]; then
    if ! git cat-file -e "$base_sha^{commit}" 2>/dev/null; then
      git fetch --no-tags --filter=blob:none --depth=1 origin "$base_sha" >/dev/null 2>&1 || return 1
    fi
    changed_files="$(git diff --name-only "$base_sha" "$head_sha" 2>/dev/null || true)"
  else
    changed_files="$(git diff --name-only HEAD^ HEAD 2>/dev/null || true)"
  fi

  [ -n "$changed_files" ] || return 1
  printf '%s\n' "$changed_files"
}

repo_foundry_pr_docs_only() {
  [ "${GITHUB_EVENT_NAME:-}" = pull_request ] || return 1

  local changed_files=""

  changed_files="$(repo_foundry_changed_files)" || return 1

  # An unavailable or empty diff is not evidence that a PR is documentation
  # only. Continue with the full check in that case.
  while IFS= read -r file; do
    case "$file" in
      README|README.*|LICENSE|NOTICE|.github/CODEOWNERS|.github/CODE_OF_CONDUCT.md|\
      .github/CONTRIBUTING.md|.github/PULL_REQUEST_TEMPLATE.md|.github/SECURITY.md|\
      .github/ISSUE_TEMPLATE/*)
        ;;
      *) return 1 ;;
    esac
  done <<< "$changed_files"

  return 0
}

# Return success when a pull request changed no dependency or audit inputs for
# the requested ecosystem. Unknown or unavailable diffs fail open so security
# checks never become silently optional.
repo_foundry_pr_dependencies_unchanged() {
  local ecosystem="${1:-all}"
  [ "${GITHUB_EVENT_NAME:-}" = pull_request ] || return 1

  local changed_files=""
  changed_files="$(repo_foundry_changed_files)" || return 1

  while IFS= read -r file; do
    case "$file" in
      .github/workflows/security.yml|.github/scripts/security.sh|.github/scripts/changed-files.sh|\
      .github/actions/setup/action.yml|.github/template.yml|.mise.toml|mise.lock|\
      .github/security-audit-allowlist.txt)
        return 1
        ;;
      package.json|*/package.json|bun.lock|bun.lockb|*/bun.lock|*/bun.lockb|\
      pnpm-lock.yaml|*/pnpm-lock.yaml|yarn.lock|*/yarn.lock|package-lock.json|*/package-lock.json|\
      .npmrc|*/.npmrc|.yarnrc*|*/.yarnrc*|.pnpmfile.cjs|*/.pnpmfile.cjs)
        case "$ecosystem" in javascript|all) return 1 ;; esac
        ;;
      Cargo.toml|*/Cargo.toml|Cargo.lock|*/Cargo.lock|.cargo/*|*/.cargo/*)
        case "$ecosystem" in rust|all) return 1 ;; esac
        ;;
      pyproject.toml|*/pyproject.toml|requirements*.txt|*/requirements*.txt|\
      setup.py|*/setup.py|setup.cfg|*/setup.cfg|Pipfile|*/Pipfile|Pipfile.lock|*/Pipfile.lock|\
      poetry.lock|*/poetry.lock|uv.lock|*/uv.lock)
        case "$ecosystem" in python|all) return 1 ;; esac
        ;;
    esac
  done <<< "$changed_files"

  return 0
}
