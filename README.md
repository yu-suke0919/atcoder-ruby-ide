# AtCoder Ruby IDE

Windows 向けの個人用 Ruby IDE です。Tauri v2 と OS の WebView2 を使います。Rubyの実行とRuby LSPはWSL2の中で動きます。AtCoderと同じRuby 3.4.5（YJIT付き）は、初回起動時にダウンロードするアプリ専用のLinuxに入っています。
WSL2の準備は必要ですが、Ruby のインストールや PATH 設定は（WindowsにもWSLにも）不要です。

- [MVP の仕様と受入条件](docs/mvp.md)
- [画面の仕様](docs/ui.md)
- [ロードマップ](docs/roadmap.md)
- [クラウドセッションでの開発](docs/cloud-development.md)
- [構成と検証方針](docs/architecture.md)
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

画面と実行環境は作り直しの途中です。この節は[ロードマップ](docs/roadmap.md)のPhase U（U5a〜U6c）を終えた後の機能で、[画面の仕様](docs/ui.md)を正とします。

- 左からコンテスト・問題集のアイコン、問題一覧、エディタとサンプル、AtCoderのページを表示するブラウザの4列で、開催中のコンテストの問題を読む・解く・確かめる・提出するまでを1つの画面で行う
- 左端の一番上のホームでは、問題に関係なくRubyを書いて実行（起動時に開く）
- 右端のブラウザでログイン・参加登録・提出。アプリはパスワードを扱わず、ブラウザのページからアプリの機能を呼べない
- ブラウザの戻る・進む・更新とURL欄。開けるのはAtCoderのページだけ
- 「るりま」ボタンで、AtCoderのページの上からRubyリファレンスマニュアル（3.4）の窓をスライドして表示。URL欄・F1・選択した文字列の右クリックから、Googleでるりまを全文検索
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
- WSL2の本体。管理者のPowerShellで `wsl --install --no-distribution` を実行して再起動してください（Ubuntuなどのディストリビューションは要りません。入っていても使いません）。BIOS/UEFIでCPUの仮想化機能を有効にする必要があります。
- アプリは初回起動時に、アプリ専用のLinux（Ubuntu 22.04の最小構成に Ruby・gem・エージェントを入れたもの、約45 MB）をGitHubのリリースからダウンロードし、SHA-256を確かめてから、ディストリビューション `AtCoderRubyIDE` として登録します。初回とアプリの更新でLinuxの版が変わったときだけ、ネットワークが要ります。利用者のディストリビューション・PATH・シェルの設定は変えません。WSL1でも動き、メモリ上限も効きますが、Rubyの起動が遅くなるため`--jit`（YJIT）を使いません（画面のRubyのバージョンの横に「WSL1のためJITなし」と出ます）。
- インストール版はアンインストールのときに登録を解除します。ポータブル版をやめるときは `wsl --unregister AtCoderRubyIDE` を実行してください。

## Windows 配布版

配布物は次の 2 種類です。

- `AtCoder-Ruby-IDE-<version>-x64-portable.zip`：展開して `atcoder-ruby-ide.exe` を起動
- `AtCoder-Ruby-IDE-<version>-x64-setup.exe`：ユーザー単位の NSIS インストーラー

どちらもアプリ本体だけで、アプリ専用のLinux（Ubuntu 22.04の最小構成に、CIでビルドしたRuby 3.4.5（YJIT付き）・採用gem・Ruby LSP・エージェントを入れたもの）は初回起動時にダウンロードします。WindowsにはRubyを同梱しません。
ac-library-rb・rbtree・sorted_set・numo-narrayなど、AtCoderの公式追加gemのうち12個を公式と同じバージョンで、必要な依存gemとともに同梱します。補完では、これらのgemのAPIも候補に出ます。対応範囲・未同梱gem・制限の差は[実行環境の資料](docs/atcoder-runtime.md)を参照してください。
ZIP はフォルダー全体を保持してください。単体のアプリ exe だけを取り出すと、ダウンロードするLinuxの情報（`wsl/runtime.json`）がなく Ruby を実行できません。

WebView2 Runtime が必要です。Windows で未導入の場合、NSIS インストーラーが取得します（初回はネット接続が必要）。
オフライン利用する ZIP 版では、あらかじめ WebView2 を用意し、一度ネットワークにつないで起動してLinuxを登録しておいてください。現時点ではコード署名を設定していません。
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

アプリ専用の Linux（イメージは `vendor/wsl-image/`、アプリに入れる情報は `vendor/wsl/runtime.json`）は、Docker が使える Ubuntu 22.04 などの Linux で、Ruby のビルドに必要なパッケージ（`build-essential libssl-dev libyaml-dev libffi-dev zlib1g-dev libgmp-dev`）を入れてから `npm run prepare:wsl` で作り、`npm run check:wsl` で確かめます。Ruby・gem・Ruby LSPは`.cache/wsl/`に残し、それを決めるファイルが変わるまで作り直しません。アプリは `runtime.json` のURL（GitHubのリリース `wsl-images` の `atcoder-linux-<版>.tar.gz`）からイメージを取得して WSL に登録します。このファイルはCI（mainへのプッシュとPR）が `scripts/publish-wsl-image.cjs` でリリースへ置いたものだけがあります。手元の `npm run prepare:wsl` で作ったイメージはリリースにないため、その `runtime.json` のままではWindowsのアプリが取得できません。Windows で `npm start` するときは、CI の `wsl-runtime` Artifact の `runtime.json` を `vendor/wsl/` に置いてください。

初回導入・コンパイルと、準備後の画面テスト時間は分けて測定します。

Windows では、アプリから Ruby の PATH を除去しても、WSL に置いた同梱の Ruby で実行することを確認します。
通常起動ではテスト用デバッグポートを開きません。機能追加ごとの検証結果は [検証記録](docs/verification.md) を参照してください。

## ビルドと検証

Windows で、`vendor/wsl/runtime.json` を用意し、WSL を入れてから実行します。

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
[GitHub Actions](.github/workflows/ci.yml) は、WSL へ置くイメージの作成と確認とリリース `wsl-images` への配置（Ubuntu 22.04）、Linux の共通・画面テストと、Windows のビルド・ZIP 展開相当のアプリ・NSIS インストール後のアプリ起動スモークテスト（WSL1）を実行します。
資料だけの変更（`docs/**` とルートの `*.md`）では実行せず、同じブランチ・PR に新しい push があると古い実行を止めます。
成功した Windows ジョブの Artifacts から ZIP またはインストーラーを取得できます。

## ショートカット

| 操作 | キー |
| --- | --- |
| すぐ保存 | Ctrl+S |
| 実行 | Ctrl+Enter |
| 検索・置換 | Ctrl+F / Ctrl+H |
| 入力補完・定型コード | 入力中に自動で表示。Ctrl+Space（または「補完」ボタン）でも開く |
| 元に戻す／やり直す | Ctrl+Z / Ctrl+Y（Ctrl+Shift+Z） |

コードは UTF-8 で作業領域へ自動保存します。標準入力はコードと別に、その実行時だけ渡します。
補完候補は入力中に自動で開きます。自動で開いた候補は上下キーで選んでからEnterで挿入し、選ぶ前のEnterは改行です。Ctrl+Spaceで開いた候補は先頭が選ばれた状態で、Enterで挿入します。候補が開いている間のTabは、選んでいる候補（選んでいなければ先頭の候補）を挿入します。Escで閉じます。最初の補完で同梱Ruby LSPを起動し、自作クラスの未保存の定義も補完に使います。候補がない場合や接続失敗時は基本候補を使い、「再試行」から復旧できます。候補が開いていないときのTabは字下げに使います。キーワード・標準メソッド・文書内の単語と、if／each／整数列入力の定型コードをオフラインで提供します。文字列・配列・ハッシュのリテラルと、単純な直接代入に続くローカル変数には型別のメソッド候補・引数説明を表示します。詳細は[エディタ仕様](docs/code-editor.md)を参照してください。
EOF を含む標準入力や日本語出力も Ruby の事前インストールなしで利用できます。
