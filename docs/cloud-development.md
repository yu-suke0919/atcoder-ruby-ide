# クラウドセッションでの開発

Claude Code のクラウドセッション（[claude.ai/code](https://claude.ai/code)）でLinux側の開発・テストを行うための準備をまとめる。WindowsのビルドとネイティブGUI、配布物の検証はGitHub ActionsのCIで確認する。

## 仕組み

- リポジトリの`CLAUDE.md`が[開発ルール](../AGENTS.md)を読み込む。実装の順番と範囲は[ロードマップ](roadmap.md)に従う。
- 環境の**セットアップスクリプト**がNode.js・Ruby・Rust・Chromiumを用意する。約5分以内に終わると、その状態が保存され、以後のセッションはインストール済みの状態で始まる。
- セッションのコマンドは`~/.bashrc`・`~/.profile`を読まずに環境のPATHで動く。そのため、セットアップスクリプトはNode.jsとRubyの実行ファイルのリンクを、PATHで既存の`/opt/node22/bin`・`/usr/local/bin`より前にある`~/.local/bin`に置く。
- `CLAUDE.md`の指示により、セッションの最初に`scripts/cloud-session.sh`を実行し、npmパッケージ・gem・Ruby LSPを準備する。依存の入力が変わっていなければ何もしない。手元の環境では何もしない。結果は`/tmp/atcoder-ruby-ide-session.log`に残す。
- セッション開始時に自動で実行したい場合は、利用者が`.claude/settings.json`のSessionStartフックに`bash "$CLAUDE_PROJECT_DIR"/scripts/cloud-session.sh`を追加する（[フックの設定](https://code.claude.com/docs/en/cloud-environments#install-dependencies-with-a-sessionstart-hook)）。

## 環境の作成

claude.ai/code の新規セッション画面で、メッセージ欄の下の環境選択から**New environment**を選ぶ。

- **Name**：`atcoder-ruby-ide`
- **Network access**：**Custom**を選び、既定の許可リストを含める設定にして、次を追加する。
  - `atcoder.jp`・`img.atcoder.jp`（開催中のコンテストの挙動の確認と、明示実行する実サイトテスト用）
  - Playwrightのブラウザの取得先（`cdn.playwright.dev`、`playwright.download.prss.microsoft.com`、`playwright.azureedge.net`）。取得に失敗した場合は、ログに出た取得先を追加する。
- **Environment variables**：`LANG=C.UTF-8`。既定ではロケールが未設定で、Rubyが`-e`のコードをUS-ASCIIとして読み、日本語を含むテストが失敗する。
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
# セッションのPATHで /opt/node22/bin・/usr/local/bin より前にあるディレクトリ。
# シェルの初期化ファイルはセッションのコマンドに読み込まれないため、ここにリンクを置く。
BIN="$HOME/.local/bin"
mkdir -p "$BIN"
export PATH="$BIN:$HOME/.cargo/bin:$PATH"
status=()

# Node.js
node_prefix="/opt/node$NODE_MAJOR"
if ! "$node_prefix/bin/node" --version 2>/dev/null | grep -q "^v$NODE_MAJOR\."; then
  base="https://nodejs.org/dist/latest-v$NODE_MAJOR.x"
  tmp=$(mktemp -d)
  curl -fsSL "$base/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt" \
    && file=$(awk '/linux-x64\.tar\.xz$/ {print $2}' "$tmp/SHASUMS256.txt") \
    && curl -fsSL "$base/$file" -o "$tmp/$file" \
    && (cd "$tmp" && grep " $file\$" SHASUMS256.txt | sha256sum -c -) \
    && mkdir -p "$node_prefix" && tar -xJf "$tmp/$file" -C "$node_prefix" --strip-components=1
  rm -rf "$tmp"
fi
if "$node_prefix/bin/node" --version 2>/dev/null | grep -q "^v$NODE_MAJOR\."; then
  ln -sf "$node_prefix"/bin/* "$BIN"/ && status+=("node: ok")
else
  status+=("node: FAILED")
fi

# Ruby（ruby/setup-rubyと同じビルド済み版）。
# 実行ファイルはビルド時のパスでlibrubyを探すため、同じパスに展開する。
. /etc/os-release
ruby_prefix="/opt/hostedtoolcache/Ruby/$RUBY_VERSION/x64"
if ! "$ruby_prefix/bin/ruby" -e 'require "openssl"; require "json"' 2>/dev/null; then
  rm -rf "$ruby_prefix" && mkdir -p "${ruby_prefix%/x64}"
  curl -fsSL "https://github.com/ruby/ruby-builder/releases/download/ruby-$RUBY_VERSION/ruby-$RUBY_VERSION-ubuntu-$VERSION_ID-x64.tar.gz" \
    | tar -xz -C "${ruby_prefix%/x64}"
fi
if "$ruby_prefix/bin/ruby" -e 'require "openssl"; require "json"' 2>/dev/null; then
  ln -sf "$ruby_prefix"/bin/* "$BIN"/ && status+=("ruby: ok")
else
  status+=("ruby: FAILED")
fi

# Rust（rust-toolchain.tomlの版）
command -v rustup >/dev/null || curl -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal
rustup toolchain install "$RUST_TOOLCHAIN" --profile minimal --component rustfmt \
  && status+=("rust: ok") || status+=("rust: FAILED")

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

ruby-builderのRubyはビルド時のパス（`/opt/hostedtoolcache/Ruby/<版>/x64`）で`libruby`を探すため、同じパスに展開する。2026-10-31にクラウド環境（Ubuntu 24.04）で、このスクリプトと次の「準備の確認」を実行して確かめた。環境を変えたときや、確認で失敗した項目があれば、この資料とスクリプトを直す。

## 準備の確認

最初のセッションで、次を実行して結果を確認する。

```bash
node --version          # v24.x
ruby -v                 # config/ruby-windows.json の rubyVersion
ruby -e 'p __ENCODING__' # #<Encoding:UTF-8>
cargo --version         # rust-toolchain.toml の版
bash scripts/cloud-session.sh && tail -20 /tmp/atcoder-ruby-ide-session.log
npm test
cargo fmt --all --check
npm run test:e2e
```

クラウドセッションはrootで動くため、`npm test`のうち`r02_cleanup_failure_releases_reservation`（権限を外した一時ディレクトリの削除失敗を確かめるテスト）は、rootが権限を無視して削除できるため失敗する。それ以外が成功すればよい。

## GitHubとの連携

- クラウドセッションからpush・PR作成を行うため、GitHubを連携する。PRのCI失敗やレビューコメントへ自動で対応させる場合は、Claude GitHub Appをリポジトリに入れて[Auto-fix](https://code.claude.com/docs/en/claude-code-on-the-web#auto-fix-pull-requests)を有効にする。
- GitHubの操作はREST API（`gh api`）を使う。クラウドセッションのGitHubプロキシはGraphQLを使う`gh pr`などを受け付けない。

## セッションの進め方

1つのセッションでロードマップの1項目を1つのPRにする。依頼の例：

```markdown
docs/roadmap.md の U2 を実装する。他の項目には手を付けない。
- AGENTS.md の順番（資料 → 失敗するテスト → 最小実装 → 不要コード・資料矛盾の確認）を守り、verification.md に記録する。
- Linux の npm test・cargo fmt --all --check・npm run test:e2e をセッション内で通す。
- PR を作成し、Linux と Windows の CI の成功を確認してから報告する。マージはしない。
- 判断が分かれる点や、調査で前提が崩れた点は、実装する前に報告する。
- 手元での確認が必要な項目（ログイン・参加登録・提出、WSL2）は、確認手順を PR 本文に書く。
```

## 制約

- WindowsのビルドとネイティブGUI、配布物の検証はクラウドセッションでは実行できない。CIで確認する。
- 実際のAtCoderアカウントでのログインと、WSL2での通しの動作は、利用者が手元で確認する。
- セットアップスクリプトと環境変数の変更は、新しいセッションから反映される。
- クラウドセッションはrootで動く。権限による失敗を前提とするテストはrootでは確かめられないため、CIで確認する。
