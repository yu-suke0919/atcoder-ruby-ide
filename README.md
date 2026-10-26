# AtCoder Ruby IDE

Windows 向けの個人用 Ruby IDE です。Tauri v2 と OS の WebView2 を使い、Ruby は配布物に同梱します。
利用者による Ruby のインストールや PATH 設定は不要です。

- [MVP の仕様と受入条件](docs/mvp.md)
- [構成と検証方針](docs/architecture.md)
- [移行と配布容量](docs/tauri-migration.md)
- [検証記録](docs/verification.md)
- [レビューで維持する修正](docs/review.md)
- [複数サンプルと JSON の仕様](docs/multi-sample.md)

## 機能

- Ruby コード編集、行番号、Tab による 2 スペースのインデント
- UTF-8 ファイルの読み込み、上書き保存、名前を付けて保存
- 標準入力付き実行、stdout / stderr の逐次表示、実行時間の表示
- 停止、5 秒の実行制限、合計 1 MiB の出力制限、子プロセスの終了
- 複数サンプルの追加・切替・逐次一括実行と、ケース別の期待出力比較
- 「不一致」をクリックして、最初に異なる行・列と期待値・実際値を確認
- 未保存の変更を破棄する前の確認

初期サンプルをそのまま実行すると `6 test` を出力します。
比較は改行コードと最後の改行 1 つの違いを無視し、その他の空白や数値表記は区別します。
空出力の比較も可能です。エラーや停止時は「判定なし」、入力・コードを変更すると「未比較」になります。
上書き保存は判定を保持し、初回保存や保存先の変更は判定を解除します。
「ケース保存」「ケース読込」で入力・期待出力・比較設定をソースと別の JSON に保存できます。保存時は毎回保存先を選びます。ケースは最大 100 件、JSON は最大 16 MiB です。全件実行は各ケースに 5 秒の上限を適用し、手動停止で残りも中止します。

## Windows 配布版

配布物は次の 2 種類です。

- `AtCoder-Ruby-IDE-0.2.0-x64-portable.zip`：展開して `atcoder-ruby-ide.exe` を起動
- `AtCoder-Ruby-IDE-0.2.0-x64-setup.exe`：ユーザー単位の NSIS インストーラー

どちらも RubyInstaller 3.4.12-1 x64 の実行用ファイルを含み、同梱の `ruby/bin/ruby.exe` を直接起動します。
Ruby の標準ライブラリ・同梱ネイティブ拡張・ライセンスを保持し、オフライン文書と C ヘッダ（share/・include/）は除外します。Ruby の COPYING・LEGAL は ruby/licenses/ruby/ に保存します。ネイティブ gem のビルドは対象外です。ZIP はフォルダー全体を保持してください。
単体のアプリ exe だけを取り出すと Ruby を実行できません。

WebView2 Runtime が必要です。Windows で未導入の場合、NSIS インストーラーが取得します（初回はネット接続が必要）。
オフライン利用する ZIP 版では、あらかじめ WebView2 を用意してください。現時点ではコード署名を設定していません。
AtCoder 本番の追加 gem や実行環境との完全一致は対象外です。

## 開発

Node.js 24、Rust 1.99.1、Windows の Visual Studio C++ Build Tools と WebView2 を使います。
Rust は `rust-toolchain.toml`、npm と Cargo の依存は各ロックファイルで固定しています。

```powershell
npm ci
npm run prepare:ruby
npm start
```

Windows は開発時も常に同梱 Ruby を使います。`RUBY_PATH` や PATH の別の Ruby には切り替わりません。
Linux の共通テストでは `RUBY_PATH`、未指定なら PATH の `ruby` を使います。
Linux の画面テストは headless Chromium と既存の Rust コアを使い、GTK / WebKitGTK は不要です。通常の Tauri デスクトップアプリ自体を Linux で起動する場合は、GTK / WebKitGTK 開発依存が別途必要です。

```bash
npm test
cargo fmt --all --check
npm run test:e2e
```

共通テストは Rust による実際の Ruby プロセス・ファイル操作と、Node によるアーカイブ検証です。
Linux では `npm run test:e2e` がテスト専用 Rust ホストをビルドし、HTTP 配信した本番画面を headless Chromium で操作します。
実 Ruby・ファイル I/O・実行制御・比較は本番の Rust ライブラリを共有し、Tauri 通信・ウィンドウ操作・ダイアログ応答だけをテスト用に差し替えます。
Windows は同じ受入ケースを実際の WebView2 / ネイティブダイアログで確認します。テスト専用ホストは配布しません。
`E2E_RUNNER=browser` または `native` で明示選択でき、その他の値はエラーになります（native は Windows 専用）。
Windows でも browser を選べますが、その場合は開発用の Ruby と Chromium を別途用意し、必要なら `RUBY_PATH` を指定してください。

Linux の初回セットアップでは、Node.js 24・Rust・Ruby に加えて Chromium を用意してください。
`CHROMIUM_PATH` で実行ファイルを指定でき、未指定なら導入済みの Playwright 版、次に `/usr/bin/chromium` を使います。
システム版がなければ `npx playwright install --with-deps chromium` で Playwright 版を導入します。
この Cloud の既存ツールを使う場合は、最初に次を設定します。

```bash
source /workspace/.cloud-setup/activate.sh
export CARGO_HOME=/workspace/.tooling/tauri-size-rust/cargo
export RUSTUP_HOME=/workspace/.tooling/tauri-size-rust/rustup
export PATH="$CARGO_HOME/bin:$PATH"
npm run test:e2e
```

1 ケースだけ確認する場合は `node --test --test-isolation=none --test-name-pattern='M04: the initial' tests/e2e/app.test.cjs` を使えます。
ブラウザー起動や localhost の接続をサンドボックスが制限する環境では、環境の通常の実行承認を使います。
初回導入・コンパイルと、準備後の画面テスト時間は分けて測定します。

Windows ではアプリから Ruby の PATH を除去し、不正な `RUBY_PATH` でも同梱 Ruby を使うことを確認します。
通常起動ではテスト用デバッグポートを開きません。検証範囲・実測値は [テスト速度の改善](docs/test-feedback.md) に記録します。

## ビルドと検証

Windows で実行します。

```powershell
npm run build:win
node scripts/package-windows.cjs --stage
$env:APP_EXE = (Resolve-Path artifacts/portable/atcoder-ruby-ide.exe).Path
npm run test:e2e
node scripts/test-installed-windows.cjs
npm run package:win
```

Ruby は公式配布元から取得し、[固定した SHA-256](config/ruby-windows.json) を検証します。
配布物は `artifacts/`、容量と Ruby 全ファイルのハッシュは `artifacts/reports/` に生成します。
[GitHub Actions](.github/workflows/ci.yml) は Linux の共通・画面テストと、Windows の共通テスト・ビルド・ZIP 展開相当のアプリ・NSIS インストール後のアプリ起動スモークテストを実行します。
成功した Windows ジョブの Artifacts から ZIP またはインストーラーを取得できます。

## ショートカット

| 操作 | キー |
| --- | --- |
| 開く | Ctrl+O |
| 保存 | Ctrl+S |
| 名前を付けて保存 | Ctrl+Shift+S |
| 実行 | Ctrl+Enter |

コードは UTF-8 で保存します。標準入力はソースと別に、その実行時だけ渡します。
EOF を含む標準入力や日本語出力も Ruby の事前インストールなしで利用できます。
