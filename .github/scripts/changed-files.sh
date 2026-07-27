#!/usr/bin/env bash

# Shared pull-request change detection. A failed or incomplete diff must be
# treated as relevant so checks never become silently optional.
repo_foundry_pr_docs_only() {
  [ "${GITHUB_EVENT_NAME:-}" = pull_request ] || return 1

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

  # An unavailable or empty diff is not evidence that a PR is documentation
  # only. Continue with the full check in that case.
  [ -n "$changed_files" ] || return 1

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
