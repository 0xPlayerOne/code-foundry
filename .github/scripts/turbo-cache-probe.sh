#!/usr/bin/env bash
set -euo pipefail

# A Turbo remote-cache hit can be resolved from package manifests alone. This
# probe lets CI skip the full dependency install when every executable task is
# already cached. It is deliberately conservative: only Bun projects with a
# pinned Turbo version are eligible, and synthetic dependency-only tasks are
# excluded from the hit decision.

task="${1:?task name required}"

set_output() {
  printf '%s=%s\n' "$1" "$2" >> "${GITHUB_OUTPUT:-/dev/null}"
}

set_output hit false

[ -n "${TURBO_TOKEN:-}" ] || exit 0
[ -n "${TURBO_TEAM:-}" ] || exit 0
[ -f package.json ] || exit 0
[ -f bun.lock ] || [ -f bun.lockb ] || exit 0

turbo_version="$(node <<'NODE'
const fs = require('node:fs');
const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const groups = [
  packageJson.devDependencies,
  packageJson.dependencies,
  packageJson.optionalDependencies,
  packageJson.pnpm?.overrides,
];
for (const group of groups) {
  const value = group?.turbo;
  const match = typeof value === 'string' && value.match(/(\d+\.\d+\.\d+)/);
  if (match) {
    console.log(match[1]);
    break;
  }
}
NODE
)"
[ -n "$turbo_version" ] || exit 0

probe_file="$(mktemp)"
cleanup() { rm -f "$probe_file"; }
trap cleanup EXIT

if ! bunx --package "turbo@${turbo_version}" turbo run "$task" \
  --dry=json --cache=remote:r --output-logs=none >"$probe_file" 2>&1; then
  exit 0
fi

if ! node - "$probe_file" <<'NODE'
const fs = require('node:fs');
const file = process.argv[2];
const text = fs.readFileSync(file, 'utf8');
const start = text.indexOf('{');
if (start < 0) process.exit(1);
let report;
try {
  report = JSON.parse(text.slice(start));
} catch {
  process.exit(1);
}
const runnable = (report.tasks || []).filter((entry) =>
  entry.command !== '<NONEXISTENT>' && entry.resolvedTaskDefinition?.cache !== false,
);
process.exit(runnable.length > 0 && runnable.every((entry) => entry.cache?.status === 'HIT') ? 0 : 1);
NODE
then
  exit 0
fi

bin_dir="${RUNNER_TEMP:-/tmp}/repo-foundry-turbo-bin"
mkdir -p "$bin_dir"
cat > "$bin_dir/turbo" <<EOF
#!/usr/bin/env bash
exec bunx --package "turbo@${turbo_version}" turbo "\$@"
EOF
chmod +x "$bin_dir/turbo"
echo "$bin_dir" >> "${GITHUB_PATH:-/dev/null}"
printf 'REPO_FOUNDRY_TURBO_REMOTE_ONLY=true\n' >> "${GITHUB_ENV:-/dev/null}"
set_output hit true
