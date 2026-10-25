# AtCoder Ruby IDE

個人が Windows で使う Ruby のデスクトップ IDE を開発しています。
コードの編集・UTF-8 ファイルの読み書き・標準入力付き実行・停止・出力表示を MVP とします。

- [MVP の仕様と受入条件](docs/mvp.md)
- [構成と検証方針](docs/architecture.md)
- [コードレビューと修正内容](docs/review.md)

開発は資料を先に更新し、テスト → 最小実装 → 不要コード・資料矛盾の確認の順で進めます。

## MVP の機能

- Ruby コードの編集、行番号、Tab による 2 スペースのインデント
- UTF-8 ファイルの読み込み・保存・名前を付けて保存
- 標準入力付き実行、stdout / stderr の逐次表示、実行時間の表示
- 停止、5 秒の実行制限、1 MiB の出力制限
- 1 ケースの期待出力との比較（一致・不一致の表示）
- 未保存の変更を破棄する前の確認
- Ruby を同梱した Windows x64 ポータブル exe

初期サンプルはそのまま実行でき、`6 test` を出力します。

## 期待出力との比較

「期待出力と比較」を有効にし、期待する標準出力を入力して実行します。
正常終了すると、実行結果に「一致」または「不一致」が表示されます。空出力を期待する場合は、有効にしたまま欄を空にします。
改行コードと最後の改行 1 つの違いは無視し、それ以外の空白や数値表記は区別します。
エラーや停止時は「判定なし」です。入力やコードを変更すると、比較表示は未比較に戻ります。
標準入力・期待出力は保存されません。複数ケースの保存・一括テストは次の段階で追加します。

## 開発環境

Node.js 24 と Ruby 3.4.12 を使います。パッケージはロックファイルで固定しています。

```bash
npm ci
npm run setup:electron
npm start
```

Electron 45 はバイナリの取得が別コマンドになっているため、`setup:electron` も実行してください。

Cloud では最初に次のコマンドで Ruby と書き込み可能なキャッシュを設定します。

```bash
source /workspace/.cloud-setup/activate.sh
cd /workspace/atcoder-ruby-ide
```

HTTPS プロキシを使う環境では、注入済みのプロキシ・CA を維持し、Electron の取得時に `ELECTRON_GET_USE_PROXY=1` を設定します。
画面のない Cloud では `npm run test:e2e` が headless Ozone で実際の Electron を起動します。
実行サンドボックスがローカルのデバッグ接続を制限する場合は、環境の実行権限の承認を利用してください。

Windows の開発でも、同梱用 Ruby をそのまま利用できます。

```powershell
npm ci
npm run setup:electron
npm run prepare:ruby
$env:RUBY_PATH = (Resolve-Path vendor/ruby/bin/ruby.exe).Path
npm start
```

開発時の Ruby は `RUBY_PATH`、未指定なら PATH 上の `ruby` です。
Windows 配布版は常に同梱の `resources/ruby/bin/ruby.exe` を使います。

## テスト

```bash
npm test
npm run test:e2e
```

共通テストは実際の Ruby プロセスとファイル I/O、アーカイブの整合性を確認します。
画面テストは Electron を起動し、編集・実行・停止・ファイル操作・未保存変更・最小画面サイズを確認します。
ケース数と実行結果は [検証記録](docs/verification.md) に記録しています。

## Windows exe の作成

```bash
npm run build:win
```

`dist/AtCoder-Ruby-IDE-0.1.0-x64.exe` が生成されます。
Windows 用 RubyInstaller 3.4.12-1 x64 を公式配布元から取得し、[固定した SHA-256](config/ruby-windows.json) を検証して同梱します。
Ruby のライセンスは配布物の `resources/ruby/LICENSE.txt` に含まれます。

exe は起動時に一時ディレクトリへアプリを展開するポータブル形式です。
利用者による Ruby のインストールは不要です。初版はコード署名を設定していません。

[GitHub Actions](.github/workflows/ci.yml) は Linux のテストと、Windows のテスト・exe 生成・配布用ディレクトリからの起動確認を行います。
リポジトリに push するか手動実行し、成功した Windows ジョブの Artifacts から exe を取得できます。
CI の定義追加と、実際の Windows ジョブの成功は区別して確認してください。

## ショートカット

| 操作 | キー |
| --- | --- |
| 開く | Ctrl+O |
| 保存 | Ctrl+S |
| 名前を付けて保存 | Ctrl+Shift+S |
| 実行 | Ctrl+Enter |

コードの保存形式は UTF-8 です。標準入力はソースファイルと別に、その実行時だけ渡します。
AtCoder 本番の追加 gem や実行環境との完全一致は、今後のイテレーションで確認します。
