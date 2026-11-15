#!/bin/bash
# Prepare repository dependencies at the start of a Claude Code cloud session.
# Local sessions return immediately. See docs/cloud-development.md.
[ "${CLAUDE_CODE_REMOTE:-}" = "true" ] || exit 0
cd "${CLAUDE_PROJECT_DIR:-$(git -C "$(dirname "$0")" rev-parse --show-toplevel)}" || exit 0

log=/tmp/atcoder-ruby-ide-session.log
stamp=node_modules/.cloud-session.sha256
inputs=(scripts/cloud-session.sh package.json package-lock.json config/atcoder-runtime.json config/ruby-lsp.json config/ruby-wsl.json)

# Gems and Ruby LSP are prepared for the pinned Ruby; another one fails part-way.
want=$(sed -n 's/.*"rubyVersion": *"\([^"]*\)".*/\1/p' config/ruby-wsl.json)
have=$(ruby -e 'print RUBY_VERSION' 2>/dev/null)
if [ "$have" != "$want" ]; then
  echo "Ruby ${have:-(not found)} is not the pinned Ruby $want (config/ruby-wsl.json). Update the environment's setup script as in docs/cloud-development.md, then start a new session."
  exit 0
fi

if sha256sum --check --status "$stamp" 2>/dev/null; then
  echo "Dependencies are already prepared ($stamp)."
  exit 0
fi
rm -f "$stamp"
if { npm ci && npm run prepare:gems && npm run prepare:lsp && npx playwright install chromium; } >"$log" 2>&1; then
  sha256sum "${inputs[@]}" >"$stamp"
  echo "Prepared npm packages, gems and Ruby LSP (log: $log)."
else
  echo "Dependency preparation failed. The end of $log:"
  tail -n 5 "$log"
fi
exit 0
