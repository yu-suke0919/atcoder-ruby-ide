# クラウドセッションでの開発

Claude Code のクラウドセッション（[claude.ai/code](https://claude.ai/code)）でLinux側の開発・テストを行うための準備をまとめる。WindowsのビルドとネイティブGUI、配布物の検証はGitHub ActionsのCIで確認する。

## 仕組み

- リポジトリの`CLAUDE.md`が[開発ルール](../AGENTS.md)を読み込む。実装の順番と範囲は[ロードマップ](roadmap.md)に従う。
- 環境の**セットアップスクリプト**がNode.js・Ruby・Rust・Chromiumを用意する。約5分以内に終わると、その状態が保存され、以後のセッションはインストール済みの状態で始まる。
- `CLAUDE.md`の指示により、セッションの最初に`scripts/cloud-session.sh`を実行し、npmパッケージ・gem・Ruby LSPを準備する。依存の入力が変わっていなければ何もしない。手元の環境では何もしない。結果は`/tmp/atcoder-ruby-ide-session.log`に残す。
- セッション開始時に自動で実行したい場合は、利用者が`.claude/settings.json`のSessionStartフックに`bash "$CLAUDE_PROJECT_DIR"/scripts/cloud-session.sh`を追加する（[フックの設定](https://code.claude.com/docs/en/cloud-environments#install-dependencies-with-a-sessionstart-hook)）。

## 環境の作成

claude.ai/code の新規セッション画面で、メッセージ欄の下の環境選択から**New environment**を選ぶ。

- **Name**：`atcoder-ruby-ide`
- **Network access**：**Custom**を選び、既定の許可リストを含める設定にして、次を追加する。
  - `atcoder.jp`・`img.atcoder.jp`（開催中のコンテストの挙動の確認と、明示実行する実サイトテスト用）
  - Playwrightのブラウザの取得先（`cdn.playwright.dev`、`playwright.download.prss.microsoft.com`、`playwright.azureedge.net`）。取得に失敗した場合は、ログに出た取得先を追加する。
- **Environment variables**：なし
- **Setup script**：次の内容。バージョンは`rust-toolchain.toml`、`config/ruby-windows.json`の`rubyVersion`、`package.json`の`engines`・`playwright`に合わせる。

```bash
#!/bin/bash
# AtCoder Ruby IDE: Claude Code クラウド環境の準備（ツールチェーンのみ）。
# 失敗してもセッションは開始させ、最後に結果をまとめて表示する。
set -uo pipefail
NODE_MAJOR=24
RUBY_VERSION=3.4.12
RUST_TOOLCHAIN=1.99.1
PLAYWRIGHT_VERSION=1.64.1
ENV_FILE="$HOME/.atcoder-ruby-ide-env.sh"
status=()

# Node.js
if ! /opt/node24/bin/node --version 2>/dev/null | grep -q "^v$NODE_MAJOR\."; then
  base="https://nodejs.org/dist/latest-v$NODE_MAJOR.x"
  tmp=$(mktemp -d)
  if curl -fsSL "$base/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt" \
    && file=$(awk '/linux-x64\.tar\.xz$/ {print $2}' "$tmp/SHASUMS256.txt") \
    && curl -fsSL "$base/$file" -o "$tmp/$file" \
    && (cd "$tmp" && grep " $file\$" SHASUMS256.txt | sha256sum -c -) \
    && mkdir -p /opt/node24 && tar -xJf "$tmp/$file" -C /opt/node24 --strip-components=1; then
    status+=("node: ok")
  else
    status+=("node: FAILED")
  fi
  rm -rf "$tmp"
fi

# Ruby（ruby/setup-rubyと同じビルド済み版。使えなければrbenvでビルド）
. /etc/os-release
ruby_prefix="$HOME/.rubies/ruby-$RUBY_VERSION"
if ! "$ruby_prefix/bin/ruby" -e 'require "openssl"; require "json"' 2>/dev/null; then
  mkdir -p "$HOME/.rubies"
  curl -fsSL "https://github.com/ruby/ruby-builder/releases/download/ruby-$RUBY_VERSION/ruby-$RUBY_VERSION-ubuntu-$VERSION_ID-x64.tar.gz" \
    | tar -xz -C "$HOME/.rubies"
fi
if ! "$ruby_prefix/bin/ruby" -e 'require "openssl"; require "json"' 2>/dev/null; then
  if command -v rbenv >/dev/null && RUBY_CONFIGURE_OPTS=--disable-install-doc rbenv install -s "$RUBY_VERSION"; then
    ruby_prefix="$(rbenv root)/versions/$RUBY_VERSION"
  fi
fi
"$ruby_prefix/bin/ruby" -v >/dev/null 2>&1 && status+=("ruby: ok") || status+=("ruby: FAILED")

# Rust（rust-toolchain.tomlの版）
command -v rustup >/dev/null || curl -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal
. "$HOME/.cargo/env" 2>/dev/null || true
rustup toolchain install "$RUST_TOOLCHAIN" --profile minimal --component rustfmt \
  && status+=("rust: ok") || status+=("rust: FAILED")

# 以後のシェルで使うPATH
cat > "$ENV_FILE" <<EOF
export PATH="/opt/node24/bin:$ruby_prefix/bin:\$HOME/.cargo/bin:\$PATH"
EOF
for rc in "$HOME/.bashrc" "$HOME/.profile"; do
  grep -qs atcoder-ruby-ide-env "$rc" || echo ". \"$ENV_FILE\"" >> "$rc"
done
. "$ENV_FILE"

# 画面テスト用のChromium
if npx -y "playwright@$PLAYWRIGHT_VERSION" install --with-deps chromium \
  || npx -y "playwright@$PLAYWRIGHT_VERSION" install chromium; then
  status+=("chromium: ok")
else
  status+=("chromium: FAILED")
fi

printf '[setup] %s\n' "${status[@]}"
exit 0
```

このスクリプトは叩き台で、クラウド環境では未検証。最初のセッションで次の「準備の確認」を行い、失敗した項目があればこの資料とスクリプトを直す。

## 準備の確認

最初のセッションで、次を実行して結果を確認する。

```bash
node --version          # v24.x
ruby -v                 # config/ruby-windows.json の rubyVersion
cargo --version         # rust-toolchain.toml の版
bash scripts/cloud-session.sh && tail -20 /tmp/atcoder-ruby-ide-session.log
npm test
cargo fmt --all --check
npm run test:e2e
```

## GitHubとの連携

- クラウドセッションからpush・PR作成を行うため、GitHubを連携する。PRのCI失敗やレビューコメントへ自動で対応させる場合は、Claude GitHub Appをリポジトリに入れて[Auto-fix](https://code.claude.com/docs/en/claude-code-on-the-web#auto-fix-pull-requests)を有効にする。
- GitHubの操作はREST API（`gh api`）を使う。クラウドセッションのGitHubプロキシはGraphQLを使う`gh pr`などを受け付けない。

## セッションの進め方

1つのセッションでロードマップの1項目を1つのPRにする。依頼の例：

```markdown
docs/roadmap.md の A2 を実装する。他の項目には手を付けない。
- AGENTS.md の順番（資料 → 失敗するテスト → 最小実装 → 不要コード・資料矛盾の確認）を守り、verification.md に記録する。
- Linux の npm test・cargo fmt --all --check・npm run test:e2e をセッション内で通す。
- PR を作成し、Linux と Windows の CI の成功を確認してから報告する。マージはしない。
- 判断が分かれる点や、調査で前提が崩れた点は、実装する前に報告する。
- 手元での確認が必要な項目（ログイン、WSL2）は、確認手順を PR 本文に書く。
```

## 制約

- WindowsのビルドとネイティブGUI、配布物の検証はクラウドセッションでは実行できない。CIで確認する。
- 実際のAtCoderアカウントでのログインと、WSL2での通しの動作は、利用者が手元で確認する。
- セットアップスクリプトの変更は、新しいセッションから反映される。
