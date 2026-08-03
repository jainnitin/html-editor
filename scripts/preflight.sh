#!/usr/bin/env bash
#
# Run everything CI runs, before pushing.
#
# CI takes several minutes per attempt, so discovering a formatting slip there
# is an expensive way to learn it. These are the same checks in the same order,
# and they finish locally in seconds.
#
#   npm run preflight
#
set -uo pipefail

cd "$(dirname "$0")/.."

fail=0
tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT

step() { printf '\n\033[1m%s\033[0m\n' "$1"; }

# Each check runs in a subshell so a `cd` inside one cannot leak into the next.
check() {
  if ( eval "$2" ) >"$tmp" 2>&1; then
    printf '  \033[32mok\033[0m   %s\n' "$1"
  else
    printf '  \033[31mFAIL\033[0m %s\n' "$1"
    sed 's/^/       /' "$tmp" | tail -25
    fail=1
  fi
}

step "Frontend"
check "vite build" "npm run build"
for f in src/main.js src/lib/*.js; do
  check "syntax $(basename "$f")" "node --check '$f'"
done

step "Rust"
check "cargo fmt --check"        "cd src-tauri && cargo fmt --check"
check "cargo clippy -D warnings" "cd src-tauri && cargo clippy --release -- -D warnings"

step "Workflows"
for w in .github/workflows/*.yml; do
  check "yaml $(basename "$w")" "ruby -ryaml -e 'YAML.load_file(\"$w\")'"
done

step "Consistency"
check "versions agree across manifests" '
  pkg=$(node -p "require(\"./package.json\").version")
  conf=$(node -p "require(\"./src-tauri/tauri.conf.json\").version")
  crate=$(grep -m1 "^version" src-tauri/Cargo.toml | cut -d\" -f2)
  if [ "$pkg" != "$conf" ] || [ "$pkg" != "$crate" ]; then
    echo "package.json=$pkg  tauri.conf.json=$conf  Cargo.toml=$crate"
    exit 1
  fi'

check "no credentials committed" '
  hits=$(grep -rIn -E "InstrumentationKey=|in\.applicationinsights\.azure\.com" \
           --include="*.js" --include="*.rs" --include="*.md" --include="*.yml" \
           src src-tauri/src .github ./*.md 2>/dev/null \
         | grep -v "<region>" || true)
  if [ -n "$hits" ]; then echo "$hits"; exit 1; fi'

if [ "$fail" -ne 0 ]; then
  printf '\n\033[31mPreflight failed — fix the above before pushing.\033[0m\n'
  exit 1
fi
printf '\n\033[32mPreflight passed.\033[0m\n'
