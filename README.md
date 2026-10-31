# AtCoder Ruby IDE

Windows 向けの個人用 Ruby IDE です。Tauri v2 と OS の WebView2 を使い、Ruby は配布物に同梱します。
利用者による Ruby のインストールや PATH 設定は不要です。

- [MVP の仕様と受入条件](docs/mvp.md)
- [構成と検証方針](docs/architecture.md)
- [移行と配布容量](docs/tauri-migration.md)
- [検証記録](docs/verification.md)
- [レビューで維持する修正](docs/review.md)
- [複数サンプルと JSON の仕様](docs/multi-sample.md)
- [AtCoder 問題の取り込みと保存](docs/problem-library.md)
- [問題文の数式と画像](docs/problem-presentation.md)
- [Rubyエディタの編集支援](docs/code-editor.md)
- [Ruby LSPによる補完](docs/ruby-lsp.md)
- [AtCoderとのRuby実行環境の整合と残る差](docs/atcoder-runtime.md)
- [実行エラーからコードへ移動](docs/run-errors.md)
- [比較の詳細仕様](docs/comparison-details.md)

## 機能

- Rubyの色分け、行番号、自動インデントと選択行の字下げ・解除、括弧補完、Ruby LSPと標準型のメソッド補完・引数ヒント・定型コード、検索・置換、Undo／Redo
- UTF-8 ファイルの読み込み、上書き保存、名前を付けて保存
- 標準入力付き実行、stdout / stderr の逐次表示、実行時間の表示
- 構文・実行時エラーの行番号表示と、コードの該当行へのジャンプ・強調
- 停止、5 秒の実行制限、合計 1 MiB の出力制限、子プロセスの終了
- 複数サンプルの追加・切替・逐次一括実行と、ケース別の期待出力比較
- ケースごとの数値の誤差許容（初期値1e-6）と設定の保存・読込
- 「不一致」をクリックして、最初に異なる行・列と期待値・実際値を確認
- 未保存の変更を破棄する前の確認
- AtCoder の問題URLから問題文・サンプルを取り込み、保存済みの問題と解答をオフラインで再表示
- 問題集URLから名前と収録問題を自動取得し、本文・サンプルを固定保存。中断・未取得分の再開と一覧からの問題切替
- 問題文を表示したままコードを編集・実行。問題文の表示切替と、画面幅に合わせた3列／上下配置
- 問題の時間・メモリ制限を表示し、実行時間が問題の制限を超えたら「制限超過の可能性」を表示（[詳細](docs/problem-library.md#問題の制限値)）

初期サンプルをそのまま実行すると `6 test` を出力します。
既定の比較は改行コードと最後の改行1つの違いを無視し、その他の空白や数値表記は区別します。誤差許容を選ぶと数値トークンだけを絶対誤差または相対誤差で比較します。
空出力の比較も可能です。エラーや停止時は「判定なし」、入力・コードを変更すると「未比較」になります。
上書き保存は判定を保持し、初回保存や保存先の変更は判定を解除します。
「ケース保存」「ケース読込」で入力・期待出力・比較設定をソースと別の JSON に保存できます。通常は保存時に保存先を選び、問題選択中はその問題の作業領域へ保存します。ケースは最大 100 件、JSON は最大 16 MiB です。全件実行は各ケースに 5 秒の上限を適用し、手動停止で残りも中止します。

「AtCoder の問題」で公開問題のURLを入力して「開く」と、問題文とサンプルを取得します。保存済みなら通信せずに開きます。初回の解答は空で、通常の「保存」で解答を保存できます。「再取得」は入力URLの問題文・サンプル原本だけを更新し、自分の解答やケースを上書きしません。
問題を開くと選択ダイアログが閉じ、問題文を読みながら編集・実行できます。「問題文を隠す／表示する」でコード欄を広く使えます。幅1,200px以上は問題文・コード・入出力の3列、狭い画面は左に問題文とコードを上下配置し、右に入出力を表示します。
「問題集」で `https://atcoder.jp/contests/tessoku-book` のようなURLを1つ入力して「登録して取得」を押すと、名前と公式順の問題一覧を取得し、各問題の本文・サンプルを順番に保存します。「中断」後やアプリを再起動した後は「未取得分を取得」で続きから取得できます。取得失敗の理由も一覧に表示します。保存済みの問題集を選び、各行の「開く」で解答・ケースを復元できます。
問題集は初回取得の内容を固定保存し、自動・一括で更新しません。同じURLの再登録や未取得分の再試行でも、取得済みの内容を保持します。単問向けの再取得からも問題集の原本を保護します。
取得済みの問題に欠落・破損があった場合は、その行の「取り直す」を使えます。対象名・URLと上書き内容を確認し、「この問題を取り直す」で現在のAtCoderから1問だけ取り直します。保存時と内容が変わっている可能性があります。キャンセル・Escでは通信しません。失敗時は以前の原本を残し、成功しても解答・編集済みケース・他の問題は変更しません。
サンプルは問題本文から取り込みます。A50「山型足し算」のようなZIP配布のサンプルは自動取得せず、比較無効の空ケースを用意します。
データは Windows の `%LOCALAPPDATA%\io.github.yu-suke0919.atcoder-ruby-ide` に置き、配布フォルダーと分離します。数式は整形して表示し、問題内の画像も保存します。画像はクリックで拡大でき、保存後は数式・画像をオフラインで表示できます。

## Windows 配布版

配布物は次の 2 種類です。

- `AtCoder-Ruby-IDE-<version>-x64-portable.zip`：展開して `atcoder-ruby-ide.exe` を起動
- `AtCoder-Ruby-IDE-<version>-x64-setup.exe`：ユーザー単位の NSIS インストーラー

どちらも検証済みのRuby 3.4系のパッチに対応するRubyInstaller x64を含み、同梱の `ruby/bin/ruby.exe` を直接起動します。採用パッチは `config/ruby-windows.json` へ固定し、AtCoderの公開環境（3.4.5）とのパッチ差を許容します。
ac-library-rb 1.2.0、bitarray 1.3.1、faster_prime 1.0.2、rgl 0.6.6、sorted_containers 1.1.0と必要な依存gemも同梱します。対応範囲・未同梱gem・JITやOSの差は[実行環境の資料](docs/atcoder-runtime.md)を参照してください。

Ruby本体を更新するときは `npm run update:ruby` を実行します。公式一覧から最新の安定版3.4.xと対応するWindows版を選び、SHA-256検証・gemの準備後に `config/ruby-windows.json` を更新します。その差分と両OSのテストを確認して採用してください。通常のビルド・CI・アプリ起動時には自動更新しません。
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
npm run prepare:lsp
npm start
```

`npm ci` は数式用資産とCodeMirrorのバンドル・ライセンスを `src/vendor/` に生成します。エディタの依存や `scripts/codemirror.mjs` を変更した場合は `npm run prepare:editor` で再生成します。表示時にCDNや外部サービスへ接続しません。

Windows のデスクトップアプリは `npm start` による開発時も同梱 Ruby を使います。`RUBY_PATH` や PATH の別の Ruby には切り替わりません。
共通テスト（`npm test`）とブラウザー用テストホストは、OS にかかわらず `RUBY_PATH`、未指定なら PATH の `ruby` を使います。Linuxでは `config/ruby-windows.json` の `rubyVersion` と同じ、書き込み可能なRubyを用意して `npm run prepare:gems` で標準gemディレクトリへ固定gemを追加します。実行時も同じディレクトリだけを探索し、GEM_HOME・GEM_PATHやユーザー用gemの影響を受けません。Windows の共通テストでは、CI と同じく準備済みの同梱 Ruby を指定します。

```powershell
npm run prepare:ruby
$env:RUBY_PATH = (Resolve-Path vendor/ruby/bin/ruby.exe).Path
npm run prepare:lsp
npm test
cargo fmt --all --check
```

Windows のネイティブ GUI テストは、後述の「ビルドと検証」の手順で実行します。
Linux の画面テストは headless Chromium と既存の Rust コアを使い、GTK / WebKitGTK は不要です。通常の Tauri デスクトップアプリ自体を Linux で起動する場合は、GTK / WebKitGTK 開発依存が別途必要です。
Linux の共通・画面テストは次のコマンドで実行します。

```bash
npm run prepare:gems
npm run prepare:lsp
npm test
cargo fmt --all --check
npm run test:e2e
```

共通テストは Rust による実際の Ruby プロセス・ファイル操作と、Node によるケース状態・アーカイブ検証です。
ケース状態だけなら `node --test --test-isolation=none tests/unit/sample-cases.test.cjs` で Ruby・ブラウザーなしで確認できます。
AtCoder の実サイトとの連携は、通信できる開発環境で `npm run test:atcoder-live` を明示実行します。公開3問の取得・再取得と実Rubyでの全サンプル比較に加え、tessoku-bookの151問の一覧と先頭2問の固定保存・復元・破損原本の個別取り直しを確認します。画像付きのABC243 Cでは実画像の取得・保存・再取得、900×650と1,440×900での表示・拡大を確認します。再起動したRustホストとブラウザーの通信を遮断し、保存済み本文・画像・解答・ケースの復元と、再取得失敗時の原本保持も確認します。全151問の取得は `ATCODER_COLLECTION_LIVE_ALL=1 cargo test --locked --test library live_atcoder_collection -- --ignored --nocapture` で明示実行できます。CIを含む通常の自動テストではAtCoderへ接続しません。依存パッケージ・Ruby・ブラウザーなどの初回取得には通信が必要です。画像を含む実サイトテストには `atcoder.jp` と `img.atcoder.jp` の通信許可が必要です。画面の実サイトテストは開発用RubyとChromiumを使います。
Linux では `npm run test:e2e` がテスト専用 Rust ホストをビルドし、HTTP 配信した本番画面を headless Chromium で操作します。
実 Ruby・ソースとケースのファイル I/O・実行制御・比較は本番の Rust ライブラリを共有し、Tauri 通信・ウィンドウ操作・ダイアログ応答をテスト用に差し替えます。
通常の GUI テストでは、問題・問題集の登録・取得・再取得・個別取り直しの成功／失敗も、必要に応じてブリッジの応答と保存データをテスト側で用意します。HTTP・HTML解析・原本保存の処理は Rust テストで検証します。
Windows は同じ受入ケースを実際の WebView2 / ネイティブダイアログで確認します。テスト専用ホストは配布しません。
`E2E_RUNNER=browser` または `native` で明示選択でき、その他の値はエラーになります（native は Windows 専用）。
Windows でも browser を選べますが、その場合は開発用の Ruby と Chromium を別途用意し、必要なら `RUBY_PATH` を指定してください。

Linux の初回セットアップでは、Node.js 24・Rust・Ruby に加えて Chromium を用意してください。
`CHROMIUM_PATH` で実行ファイルを指定でき、未指定なら導入済みの Playwright 版、次に `/usr/bin/chromium` を使います。
システム版がなければ `npx playwright install --with-deps chromium` で Playwright 版を導入します。
1 ケースだけ確認する場合は `node --test --test-isolation=none --test-name-pattern='M04: the initial' tests/e2e/app.test.cjs` を使えます。
ブラウザー起動や localhost の接続をサンドボックスが制限する環境では、環境の通常の実行承認を使います。
初回導入・コンパイルと、準備後の画面テスト時間は分けて測定します。

Windows ではアプリから Ruby の PATH を除去し、不正な `RUBY_PATH` でも同梱 Ruby を使うことを確認します。
通常起動ではテスト用デバッグポートを開きません。機能追加ごとの検証結果は [検証記録](docs/verification.md)、Ruby 削減時の速度・容量の測定は [テスト速度の改善](docs/test-feedback.md) を参照してください。

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
配布物は `artifacts/`、容量とRuby・LSPの全ファイルのハッシュは `artifacts/reports/` に生成します。`ruby-lsp/`の固定bundleも両配布物へ同梱し、画面とバックエンドの両方で未保存コードからの補完取得を検証します。
[GitHub Actions](.github/workflows/ci.yml) は Linux の共通・画面テストと、Windows の共通テスト・ビルド・ZIP 展開相当のアプリ・NSIS インストール後のアプリ起動スモークテストを実行します。
成功した Windows ジョブの Artifacts から ZIP またはインストーラーを取得できます。

## ショートカット

| 操作 | キー |
| --- | --- |
| 開く | Ctrl+O |
| 保存 | Ctrl+S |
| 名前を付けて保存 | Ctrl+Shift+S |
| 実行 | Ctrl+Enter |
| 検索・置換 | Ctrl+F / Ctrl+H |
| 入力補完・定型コード | Ctrl+Space（または「補完」ボタン） |
| 元に戻す／やり直す | Ctrl+Z / Ctrl+Y（Ctrl+Shift+Z） |

コードは UTF-8 で保存します。標準入力はソースと別に、その実行時だけ渡します。
補完候補は手動で開き、上下キーで選択、Enterで挿入、Escで閉じます。初回に同梱Ruby LSPを起動し、自作クラスの未保存の定義も補完に使います。候補がない場合や接続失敗時は基本候補を使い、「再試行」から復旧できます。Tabは字下げに使います。キーワード・標準メソッド・文書内の単語と、if／each／整数列入力の定型コードをオフラインで提供します。文字列・配列・ハッシュのリテラルと、単純な直接代入に続くローカル変数には型別のメソッド候補・引数説明を表示します。詳細は[エディタ仕様](docs/code-editor.md)を参照してください。
EOF を含む標準入力や日本語出力も Ruby の事前インストールなしで利用できます。
