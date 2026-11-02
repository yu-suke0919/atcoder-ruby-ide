# AtCoder Ruby IDE

Windows 向けの個人用 Ruby IDE です。Tauri v2 と OS の WebView2 を使います。Rubyの実行とRuby LSPはWSL2の中で動き、AtCoderと同じRuby 3.4.5（YJIT付き）を配布物に同梱します。
WSL2の準備は必要ですが、Ruby のインストールや PATH 設定は（WindowsにもWSLにも）不要です。

- [MVP の仕様と受入条件](docs/mvp.md)
- [画面の仕様](docs/ui.md)
- [ロードマップ](docs/roadmap.md)
- [クラウドセッションでの開発](docs/cloud-development.md)
- [構成と検証方針](docs/architecture.md)
- [移行と配布容量](docs/tauri-migration.md)
- [検証記録](docs/verification.md)
- [レビューで維持する修正](docs/review.md)
- [複数サンプル](docs/multi-sample.md)
- [AtCoder 問題の取得と作業領域](docs/problem-library.md)
- [Rubyエディタの編集支援](docs/code-editor.md)
- [Ruby LSPによる補完](docs/ruby-lsp.md)
- [AtCoderとのRuby実行環境の整合と残る差](docs/atcoder-runtime.md)
- [実行エラーからコードへ移動](docs/run-errors.md)
- [比較の詳細仕様](docs/comparison-details.md)

## 機能

画面と実行環境は作り直しの途中です。この節は[ロードマップ](docs/roadmap.md)のPhase U（U5〜U6）とPhase C（C2〜C5）を終えた後の機能で、[画面の仕様](docs/ui.md)を正とします。

- 左からコンテスト・問題集のアイコン、問題一覧、エディタとサンプル、AtCoderのページを表示するブラウザの4列で、開催中のコンテストの問題を読む・解く・確かめる・提出するまでを1つの画面で行う
- 左端の一番上のホームでは、問題に関係なくRubyを書いて実行（起動時に開く）
- 右端のブラウザでログイン・参加登録・提出。アプリはパスワードを扱わず、ブラウザのページからアプリの機能を呼べない
- ブラウザの戻る・進む・更新とURL欄。開けるのはAtCoderのページだけ
- 左端のアイコンを含む列と、エディタ・サンプル・結果の枠の境目をドラッグして大きさを変更（次の起動でも保つ）
- 参加登録したコンテストを自動で追加し、開始1分前に通知、開始時に問題一覧を取得してA問題を開く。問題は選んだときに取得。過去のコンテストや問題集は「＋」でURLを登録
- 問題ページからサンプル・時間とメモリの制限・入力形式を読み取り、空のファイルに読み込みのコードを入れる
- 1問に複数の解答ファイル。解答とサンプルは問題ごとの作業領域へ自動保存
- Rubyの色分け、行番号、自動インデントと選択行の字下げ・解除、括弧補完、Ruby LSPと標準型のメソッド補完・引数ヒント・定型コード、検索・置換、Undo／Redo
- 標準入力付き実行、stdout / stderr の逐次表示、実行時間の表示
- 構文・実行時エラーの行番号表示と、コードの該当行へのジャンプ・強調
- 停止、問題に応じた5〜30秒の実行制限、合計 1 MiB の出力制限、メモリ上限、子プロセスの終了
- AtCoderと同じRuby 3.4.5を`--jit`（YJIT）で実行
- 問題ごとの複数サンプルの追加・切替・逐次一括実行と、サンプル別の期待出力比較。判定はタブの色で表示
- 問題ごとの数値の誤差許容（初期値1e-6）
- 「不一致」をクリックして、最初に異なる行・列と期待値・実際値を確認
- 実行時間が問題の制限を超えたら「制限超過の可能性」を表示（[詳細](docs/problem-library.md#問題の制限値)）
- 提出結果（AC・AC以外・ジャッジ中）を問題一覧の色で表示。別の問題を解いている間も更新
- 全サンプルが一致したらコードをクリップボードへコピー（設定でオン・オフ）

既定の比較は改行コードと最後の改行1つの違いを無視し、その他の空白や数値表記は区別します。誤差許容を選ぶと数値トークンだけを絶対誤差または相対誤差で比較します。
空出力の比較も可能です。エラーや停止時は「判定なし」、入力・コードを変更すると「未比較」になります。保存では判定は変わりません。
サンプルは問題ごとに最大 100 件です。全件実行は開始時の問題の制限値を各サンプルへ適用し、手動停止で残りも中止します。実行の打ち切りは既定5秒、制限既知なら「問題の制限＋1秒」（最低5秒・最大30秒）です。
データは Windows の `%LOCALAPPDATA%\io.github.yu-suke0919.atcoder-ruby-ide` に置き、配布フォルダーと分離します。ログイン状態はブラウザ（WebView2）のプロファイルにだけ置きます。ウィンドウの大きさと位置は `%APPDATA%\io.github.yu-suke0919.atcoder-ruby-ide\.window-state.json` に記憶します。

## 必要なもの

- Windows 10（x64は1903・ビルド18362.1049以降）または11。Homeでも使えます。
- WSL2と、既定のディストリビューションのUbuntu（22.04以降）。管理者のPowerShellで `wsl --install` を実行して再起動し、Ubuntuの初回設定（ユーザー名とパスワード）を済ませてください。BIOS/UEFIでCPUの仮想化機能を有効にする必要があります。
- アプリは初回起動時に、同梱のRubyとエージェントをWSL内の `~/.atcoder-ruby-ide/` に置きます。PATHやシェルの設定は変えず、sudoも使いません。WSL1でも動きますが、メモリ上限は効きません。

## Windows 配布版

配布物は次の 2 種類です。

- `AtCoder-Ruby-IDE-<version>-x64-portable.zip`：展開して `atcoder-ruby-ide.exe` を起動
- `AtCoder-Ruby-IDE-<version>-x64-setup.exe`：ユーザー単位の NSIS インストーラー

どちらも、WSL内で動かすエージェントと、CIでビルドしたLinux版Ruby 3.4.5（YJIT付き）・採用gem・Ruby LSPを1つのアーカイブにまとめて含みます（SHA-256を固定）。WindowsにはRubyを同梱しません。
ac-library-rb 1.2.0、bitarray 1.3.1、faster_prime 1.0.2、rgl 0.6.6、sorted_containers 1.1.0と必要な依存gemを同梱し、C拡張のあるgemもC3bで加えます。対応範囲・未同梱gem・制限の差は[実行環境の資料](docs/atcoder-runtime.md)を参照してください。
ZIP はフォルダー全体を保持してください。単体のアプリ exe だけを取り出すと Ruby を実行できません。

WebView2 Runtime が必要です。Windows で未導入の場合、NSIS インストーラーが取得します（初回はネット接続が必要）。
オフライン利用する ZIP 版では、あらかじめ WebView2 を用意してください。現時点ではコード署名を設定していません。
AtCoder 本番の追加 gem や実行環境との完全一致は対象外です。

## 開発

Node.js 24、Rust 1.99.1、Ruby 3.4.5（`config/ruby-wsl.json`）を使います。Windows のアプリのビルドには Visual Studio C++ Build Tools と WebView2 も使います。
Rust は `rust-toolchain.toml`、npm と Cargo の依存は各ロックファイルで固定しています。

```bash
npm ci
npm run prepare:gems
npm run prepare:lsp
npm test
cargo fmt --all --check
```

`npm ci` はCodeMirrorのバンドル・ライセンスを `src/vendor/` に生成します。エディタの依存や `scripts/codemirror.mjs` を変更した場合は `npm run prepare:editor` で再生成します。表示時にCDNや外部サービスへ接続しません。

共通テスト（`npm test`）とブラウザー用テストホストは `RUBY_PATH`、未指定なら PATH の `ruby` を使い、テストホストは自分自身をエージェントとして起動して Ruby を実行します。`npm run prepare:gems` で、その Ruby の標準gemディレクトリへ固定gemを追加します。実行時も同じディレクトリだけを探索し、GEM_HOME・GEM_PATHやユーザー用gemの影響を受けません。

WSL へ置く同梱物（`vendor/wsl/`）は、Ubuntu 22.04 などの Linux（WSL の中でもよい）で、Ruby のビルドに必要なパッケージ（`build-essential libssl-dev libyaml-dev libffi-dev zlib1g-dev libgmp-dev`）を入れてから `npm run prepare:wsl` で作り、`npm run check:wsl` で確かめます。CI の `wsl-runtime` Artifact を `vendor/wsl/` に置いても使えます。Windows で `npm start` するときも、この同梱物を WSL へ置いて Ruby を実行します。

初回導入・コンパイルと、準備後の画面テスト時間は分けて測定します。

Windows では、アプリから Ruby の PATH を除去しても、WSL に置いた同梱の Ruby で実行することを確認します。
通常起動ではテスト用デバッグポートを開きません。機能追加ごとの検証結果は [検証記録](docs/verification.md)、Ruby 削減時の速度・容量の測定は [テスト速度の改善](docs/test-feedback.md) を参照してください。

## ビルドと検証

Windows で、`vendor/wsl/` を用意し、WSL を入れてから実行します。

```powershell
npm run build:win
node scripts/package-windows.cjs --stage
$env:APP_EXE = (Resolve-Path artifacts/portable/atcoder-ruby-ide.exe).Path
npm run test:e2e
node scripts/test-installed-windows.cjs
npm run package:win
```

Ruby のソースは公式配布元から取得し、[固定した SHA-256](config/ruby-wsl.json) を検証します。
配布物は `artifacts/`、容量と同梱物のハッシュは `artifacts/reports/` に生成します。両配布物で、未保存コードからの補完取得を WSL の Ruby LSP で検証します。
[GitHub Actions](.github/workflows/ci.yml) は、WSL へ置く同梱物の作成と確認（Ubuntu 22.04）、Linux の共通・画面テストと、Windows のビルド・ZIP 展開相当のアプリ・NSIS インストール後のアプリ起動スモークテスト（WSL1）を実行します。
資料だけの変更（`docs/**` とルートの `*.md`）では実行せず、同じブランチ・PR に新しい push があると古い実行を止めます。
成功した Windows ジョブの Artifacts から ZIP またはインストーラーを取得できます。

## ショートカット

| 操作 | キー |
| --- | --- |
| すぐ保存 | Ctrl+S |
| 実行 | Ctrl+Enter |
| 検索・置換 | Ctrl+F / Ctrl+H |
| 入力補完・定型コード | Ctrl+Space（または「補完」ボタン） |
| 元に戻す／やり直す | Ctrl+Z / Ctrl+Y（Ctrl+Shift+Z） |

コードは UTF-8 で作業領域へ自動保存します。標準入力はコードと別に、その実行時だけ渡します。
補完候補は手動で開き、上下キーで選択、Enterで挿入、Escで閉じます。初回に同梱Ruby LSPを起動し、自作クラスの未保存の定義も補完に使います。候補がない場合や接続失敗時は基本候補を使い、「再試行」から復旧できます。Tabは字下げに使います。キーワード・標準メソッド・文書内の単語と、if／each／整数列入力の定型コードをオフラインで提供します。文字列・配列・ハッシュのリテラルと、単純な直接代入に続くローカル変数には型別のメソッド候補・引数説明を表示します。詳細は[エディタ仕様](docs/code-editor.md)を参照してください。
EOF を含む標準入力や日本語出力も Ruby の事前インストールなしで利用できます。
