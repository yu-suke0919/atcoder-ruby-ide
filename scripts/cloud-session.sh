#!/bin/bash
# Prepare repository dependencies at the start of a Claude Code cloud session.
# Local sessions return immediately. See docs/cloud-development.md.
[ "${CLAUDE_CODE_REMOTE:-}" = "true" ] || exit 0
cd "${CLAUDE_PROJECT_DIR:-$(git -C "$(dirname "$0")" rev-parse --show-toplevel)}" || exit 0
[ -f "$HOME/.atcoder-ruby-ide-env.sh" ] && . "$HOME/.atcoder-ruby-ide-env.sh"

log=/tmp/atcoder-ruby-ide-session.log
stamp=node_modules/.cloud-session.sha256
inputs=(scripts/cloud-session.sh package.json package-lock.json config/atcoder-runtime.json config/ruby-lsp.json config/ruby-windows.json)

if sha256sum --check --status "$stamp" 2>/dev/null; then
  echo "Dependencies are already prepared ($stamp)."
  exit 0
fi
rm -f "$stamp"
if { npm ci && npm run prepare:gems && npm run prepare:lsp && npx playwright install chromium; } >"$log" 2>&1; then
  sha256sum "${inputs[@]}" >"$stamp"
  echo "Prepared npm packages, gems and Ruby LSP (log: $log)."
else
  echo "Dependency preparation failed. See $log."
fi
exit 0
