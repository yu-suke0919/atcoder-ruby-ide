#!/bin/bash
# Builds the runtime the app places in WSL: vendor/wsl/atcoder-runtime.tar.gz and runtime.json.
# Runs on Ubuntu 22.04 (CI) with the Ruby build dependencies, Node.js and Rust installed.
# See docs/architecture.md#wslのエージェント and docs/atcoder-runtime.md#rubyのビルドc3a.
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
setting() { node -p "const c = require('$root/config/ruby-wsl.json'); $1"; }
version=$(setting c.rubyVersion)
url=$(setting c.url)
sha256=$(setting c.sha256)
read -r -a configure <<<"$(setting "c.configure.join(' ')")"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cache="$root/.cache/wsl"
mkdir -p "$cache"
source_archive="$cache/ruby-$version.tar.gz"
if [ ! -f "$source_archive" ]; then
  curl -fsSL "$url" -o "$source_archive.part"
  mv "$source_archive.part" "$source_archive"
fi
echo "$sha256  $source_archive" | sha256sum -c -

tar -xzf "$source_archive" -C "$work"
source="$work/ruby-$version"
(
  cd "$source"
  ./configure --prefix=/opt/atcoder-ruby "${configure[@]}"
  make -j"$(nproc)"
  make install DESTDIR="$work/stage"
)
payload="$work/payload"
mkdir -p "$payload/licenses/ruby"
mv "$work/stage/opt/atcoder-ruby" "$payload/ruby"
# Not needed to run Ruby or load extensions; 151 MB of the 255 MB.
rm "$payload/ruby/lib/libruby-static.a"
strip "$payload/ruby/bin/ruby"
find "$payload/ruby" -name '*.so' -exec strip --strip-unneeded {} +
cp "$source"/{BSDL,COPYING,COPYING.ja,GPL,LEGAL} "$payload/licenses/ruby/"

ruby="$payload/ruby/bin/ruby"
RUBY_PATH="$ruby" node "$root/scripts/prepare-gems.cjs"
node -e "require('$root/scripts/prepare-lsp.cjs').prepareLsp({ root: process.argv[1], ruby: process.argv[2] }).catch(error => { console.error(error); process.exit(1); })" "$work/lsp" "$ruby"
mv "$work/lsp/vendor/ruby-lsp" "$payload/ruby-lsp"

(cd "$root" && cargo build --release --locked --bin atcoder-ruby-agent)
cp "$root/target/release/atcoder-ruby-agent" "$payload/"
strip "$payload/atcoder-ruby-agent"

out="$root/vendor/wsl"
rm -rf "$out"
mkdir -p "$out"
tar --sort=name --owner=0 --group=0 --numeric-owner --mtime=@0 -C "$payload" -cf - . | gzip -9n >"$out/atcoder-runtime.tar.gz"
hash=$(sha256sum "$out/atcoder-runtime.tar.gz" | cut -c1-64)
printf '{\n  "rubyVersion": "%s",\n  "sha256": "%s"\n}\n' "$version" "$hash" >"$out/runtime.json"
du -sh "$payload" "$out/atcoder-runtime.tar.gz"
cat "$out/runtime.json"
