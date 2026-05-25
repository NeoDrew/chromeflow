#!/usr/bin/env bash
# Local anti-bot validation runner.
#
# Walks platforms/*.md and prints a summary of which are documented,
# which need re-verification (Last verified > 30 days ago), and which
# are explicitly Broken. Does NOT run live browser tests automatically —
# each platform's procedure must be performed manually (or via a
# subagent driving chromeflow) per the docs in platforms/<name>.md.
#
# Usage:
#   ./run-local.sh                  show summary of all platforms
#   ./run-local.sh --list           list platform names only
#   ./run-local.sh <name>           show one platform's procedure
#   ./run-local.sh --help

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
PLATFORMS_DIR="$HERE/platforms"

show_help() {
  cat <<EOF
chromeflow anti-bot validation harness

Usage:
  $(basename "$0")                 Show summary of all platforms
  $(basename "$0") --list          List platform names only
  $(basename "$0") <name>          Show one platform's procedure
  $(basename "$0") --help          This help

Platforms are documented under platforms/. Each file describes the
preconditions, the exact chromeflow tool calls, and the expected
response fields for a single validation. Run each platform by following
the procedure in its file, then update the "Last verified" date.

There is no live test executor today — chromeflow drives the user's
real Chrome and authenticated session cookies are required, so live
runs are an operator action, not a CI gate. The role of this script is
to surface what needs validation and capture state in last-run.json.
EOF
}

list_platforms() {
  if [[ ! -d "$PLATFORMS_DIR" ]]; then
    echo "(no platforms directory yet — create $PLATFORMS_DIR)" >&2
    return 1
  fi
  find "$PLATFORMS_DIR" -name "*.md" -type f -maxdepth 1 -print0 \
    | xargs -0 -n1 basename \
    | sed 's/\.md$//' \
    | sort
}

show_platform() {
  local name="$1"
  local file="$PLATFORMS_DIR/${name}.md"
  if [[ ! -f "$file" ]]; then
    echo "error: platform '$name' not found at $file" >&2
    echo "available:" >&2
    list_platforms >&2
    return 1
  fi
  cat "$file"
}

show_summary() {
  if [[ ! -d "$PLATFORMS_DIR" ]]; then
    echo "No platforms directory yet. Add platform docs to $PLATFORMS_DIR/"
    return 0
  fi
  local count=0
  local stale=0
  local broken=0
  echo "Chromeflow anti-bot validation summary"
  echo "======================================"
  printf "%-30s %-12s %-12s %-10s\n" "Platform" "Validated" "Stability" "Last"
  for f in "$PLATFORMS_DIR"/*.md; do
    [[ -e "$f" ]] || continue
    local name
    name=$(basename "$f" .md)
    local validated stability last
    validated=$(grep -m1 -i "^\*\*Validated:" "$f" | sed 's/.*Validated:\*\* *//' | awk '{print $1}' || echo "?")
    stability=$(grep -m1 -i "^\*\*Stability:" "$f" | sed 's/.*Stability:\*\* *//' | awk '{print $1}' || echo "?")
    last=$(grep -m1 -i "^\*\*Last verified:" "$f" | sed 's/.*Last verified:\*\* *//' | awk '{print $1}' || echo "?")
    printf "%-30s %-12s %-12s %-10s\n" "$name" "$validated" "$stability" "$last"
    count=$((count + 1))
    [[ "$stability" == "Broken" ]] && broken=$((broken + 1))
  done
  echo
  echo "$count platforms; $broken broken."
  echo "Run \`$(basename "$0") <name>\` to see one platform's procedure."
}

case "${1:-}" in
  --help|-h) show_help ;;
  --list) list_platforms ;;
  "") show_summary ;;
  *) show_platform "$1" ;;
esac
