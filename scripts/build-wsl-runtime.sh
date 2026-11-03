#!/bin/bash
# Builds the app's own WSL distribution: vendor/wsl-image/atcoder-linux.tar.gz, and
# vendor/wsl/runtime.json, which the app carries to download and check that image.
# Runs on Ubuntu 22.04 (CI) with the Ruby build dependencies, Node.js, Rust and Docker installed.
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
strip "$payload/ruby/bin/ruby"
cp "$source"/{BSDL,COPYING,COPYING.ja,GPL,LEGAL} "$payload/licenses/ruby/"

ruby="$payload/ruby/bin/ruby"
RUBY_PATH="$ruby" node "$root/scripts/prepare-gems.cjs"
node -e "require('$root/scripts/prepare-lsp.cjs').prepareLsp({ root: process.argv[1], ruby: process.argv[2] }).catch(error => { console.error(error); process.exit(1); })" "$work/lsp" "$ruby"
mv "$work/lsp/vendor/ruby-lsp" "$payload/ruby-lsp"
# mkmf links the gems' C extensions against it; not needed to run Ruby or load extensions (151 MB).
rm "$payload/ruby/lib/libruby-static.a"
# Ruby's extension libraries and the C extensions of the gems built above.
find "$payload/ruby" -name '*.so' -exec strip --strip-unneeded {} +

(cd "$root" && cargo build --release --locked --bin atcoder-ruby-agent)
cp "$root/target/release/atcoder-ruby-agent" "$payload/"
strip "$payload/atcoder-ruby-agent"

# The app's own distribution: Ubuntu 22.04 with only the libraries Ruby needs, a user that runs
# Ruby, and the payload in /opt/atcoder-ruby-ide. The version is a hash of the payload, so a new
# build is imported again while the same build is kept.
version_id=$(tar --sort=name --owner=0 --group=0 --numeric-owner --mtime=@0 -C "$payload" -cf - . | sha256sum | cut -c1-64)
out="$root/vendor/wsl"
image="$root/vendor/wsl-image/atcoder-linux.tar.gz"
rm -rf "$out" "$(dirname "$image")"
mkdir -p "$out" "$(dirname "$image")"
container="atcoder-ruby-ide-linux-$$"
docker rm -f "$container" >/dev/null 2>&1 || true
docker run --name "$container" -e VERSION="$version_id" -v "$payload:/payload:ro" ubuntu:22.04 sh -euc '
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends libssl3 libyaml-0-2 libffi8 libgmp10 zlib1g
  rm -rf /var/lib/apt/lists/*
  useradd --create-home --shell /bin/bash atcoder
  cp -a /payload /opt/atcoder-ruby-ide
  chown -R root:root /opt/atcoder-ruby-ide
  # Readable by atcoder but not writable; mkdtemp left some folders private.
  chmod -R u=rwX,go=rX /opt/atcoder-ruby-ide
  printf "[user]\ndefault=atcoder\n\n[interop]\nappendWindowsPath=false\n" >/etc/wsl.conf
  echo "$VERSION" >/etc/atcoder-ruby-ide-version'
docker export "$container" | gzip -9n >"$image"
docker rm "$container" >/dev/null
# The image's bytes differ from build to build, so the release names it by its SHA-256
# (scripts/publish-wsl-image.cjs); the app downloads it from there.
sha256=$(sha256sum "$image" | cut -c1-64)
url="https://github.com/${GITHUB_REPOSITORY:-yu-suke0919/atcoder-ruby-ide}/releases/download/wsl-images/atcoder-linux-$sha256.tar.gz"
printf '{\n  "rubyVersion": "%s",\n  "version": "%s",\n  "sha256": "%s",\n  "bytes": %s,\n  "url": "%s"\n}\n' \
  "$version" "$version_id" "$sha256" "$(stat -c %s "$image")" "$url" >"$out/runtime.json"
du -sh "$payload" "$image"
cat "$out/runtime.json"
