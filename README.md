# AtCoder Ruby IDE

Windows 向けの個人用 Ruby IDE です。Tauri v2 と OS の WebView2 を使い、Ruby は配布物に同梱します。
利用者による Ruby のインストールや PATH 設定は不要です。

- [MVP の仕様と受入条件](docs/mvp.md)
- [構成と検証方針](docs/architecture.md)
- [移行と配布容量](docs/tauri-migration.md)
- [検証記録](docs/verification.md)
- [レビューで維持する修正](docs/review.md)

## 機能

- Ruby コード編集、行番号、Tab による 2 スペースのインデント
- UTF-8 ファイルの読み込み、上書き保存、名前を付けて保存
- 標準入力付き実行、stdout / stderr の逐次表示、実行時間の表示
- 停止、5 秒の実行制限、合計 1 MiB の出力制限、子プロセスの終了
- 1 ケースの期待出力との比較（一致・不一致）
- 未保存の変更を破棄する前の確認

初期サンプルをそのまま実行すると `6 test` を出力します。
比較は改行コードと最後の改行 1 つの違いを無視し、その他の空白や数値表記は区別します。
空出力の比較も可能です。エラーや停止時は「判定なし」、入力・コードを変更すると「未比較」になります。
上書き保存は判定を保持し、初回保存や保存先の変更は判定を解除します。
標準入力・期待出力の保存、複数ケースの一括実行は未実装です。

## Windows 配布版

配布物は次の 2 種類です。

- `AtCoder-Ruby-IDE-0.2.0-x64-portable.zip`：展開して `atcoder-ruby-ide.exe` を起動
- `AtCoder-Ruby-IDE-0.2.0-x64-setup.exe`：ユーザー単位の NSIS インストーラー

どちらも RubyInstaller 3.4.12-1 x64 全体を含み、同梱の `ruby/bin/ruby.exe` を直接起動します。
Ruby の標準ライブラリ・ネイティブライブラリ・ライセンスも同梱しています。ZIP はフォルダー全体を保持してください。
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
Linux で画面も起動する場合は Tauri の GTK / WebKitGTK 開発依存が別途必要です。Windows 配布物の検証は Windows で行います。

```bash
npm test
cargo fmt --all --check
```

共通テストは Rust による実際の Ruby プロセス・ファイル操作と、Node によるアーカイブ検証です。
画面テストは配布アプリを WebView2 CDP に接続して操作し、Windows の実ダイアログは UI Automation で操作します。
テスト対象のアプリから Ruby の PATH を除去し、不正な `RUBY_PATH` を設定して、同梱 Ruby の利用を確認します。
通常起動ではテスト用デバッグポートを開きません。

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
[GitHub Actions](.github/workflows/ci.yml) は Linux の共通テストと、Windows の共通テスト・ビルド・ZIP 展開相当のアプリ・NSIS インストール後の全画面テストを実行します。
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
