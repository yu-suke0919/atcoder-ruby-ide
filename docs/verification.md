# 検証記録

現在のテスト構成・削減後の Ruby・測定値は [テスト速度の改善](test-feedback.md) を参照する。「環境と方法」から「Windows の受入検証」までは移行完了時点の履歴である。PR #10 以降の記録は末尾にまとめる。

## 環境と方法

Node.js 24、Rust 1.99.1、Tauri v2、RubyInstaller 3.4.12-1 x64 を使用する。
Cargo.lock と package-lock.json で依存を固定する。Windows 用 Ruby アーカイブの SHA-256 は取得時に照合する。

資料を先に更新し、Rust の実装前に共通テストの失敗を確認してから最小実装した。
Electron 専用の実装・依存・テストは置き換え、既存の受入条件 M01〜M11 とレビュー修正 R01〜R06 を維持する。

## 検証結果（2026-10-25）

測定・受入検証の対象は `679e03a063e5cbe37a1ec55d4d2ee935b2130f14`。
[GitHub Actions run 40206570408](https://github.com/yu-suke0919/atcoder-ruby-ide/actions/runs/40206570408) は Linux・Windows ともに成功した。

| 対象 | 結果 |
| --- | --- |
| Linux 共通テスト | Rust 17 件、Node のアーカイブ検証 2 件が成功 |
| Windows 共通テスト | 同梱 Ruby で Rust 16 件、Node 2 件が成功。POSIX の権限変更テストは Windows のコンパイル対象外 |
| Windows リリースビルド | Tauri の exe と NSIS を生成 |
| ポータブル配布用フォルダー | GUI 23 件すべて成功 |
| NSIS インストール後 | GUI 23 件すべて成功 |
| Ruby 未導入を想定した条件 | アプリの PATH から Ruby を除去、`where ruby` の失敗、不正な RUBY_PATH、実際の同梱 Ruby のパスと JSON 読み込みを両配布形態で確認 |
| 同梱ファイル | 19,696 ファイル、107,695,373 bytes。ポータブル・インストール先の両方で Ruby 全ファイルの SHA-256 を照合 |

Ruby を完全にアンインストールした新規 OS イメージでの検証ではなく、アプリの環境から外部 Ruby の検索経路を除いた検証である。
同梱 Ruby の起動パス・標準ライブラリ・全ファイルの一致を併せて確認した。
WebView2 は Windows ランナーに導入済みのものを使用した。未導入端末でのブートストラッパー取得は実機検証の対象外。

| 配布物 | bytes | MiB |
| --- | ---: | ---: |
| Ruby 一式 | 107,695,373 | 102.71 |
| Tauri exe | 6,562,304 | 6.26 |
| 展開後のフォルダー | 114,257,677 | 108.96 |
| ポータブル ZIP | 36,169,607 | 34.49 |
| NSIS インストーラー | 18,500,663 | 17.64 |

MiB は bytes / 1,048,576。ZIP の圧縮条件は `7zip -tzip -mx9 -mmt2`。
GUI スクリーンショット、容量 JSON、Ruby のファイルハッシュは
[Windows-verification Artifact](https://github.com/yu-suke0919/atcoder-ruby-ide/actions/runs/40206570408/artifacts/12604790471) に保存した。
配布物は同じ run の portable / setup Artifacts から取得できる。
GitHub Artifact 自体の ZIP サイズと、中に含まれる配布 ZIP・exe のサイズは区別する。

## Windows の受入検証

共通テストの後、リリースビルドから ZIP 配布用フォルダーと NSIS を作成する。
ZIP 配布用フォルダーから起動し、続いて NSIS を実際にインストールして同じ GUI テストを繰り返す。
実ダイアログを Windows UI Automation で操作し、画面は実際の WebView2 に Playwright から接続して操作する。
アプリ専用の環境で PATH を Windows 標準フォルダーだけにし、`where.exe ruby` が失敗することを確認する。
不正な `RUBY_PATH` も設定し、ネイティブ側の Ruby パスが配布フォルダー内のものと一致することを検証する。

検証範囲はサンプル実行、日本語・EOF・stderr、JSON 標準ライブラリ、保存先相対の読み込み、
構文エラー、停止・再実行、時間・出力制限、子プロセス終了、期待出力比較、UTF-8/BOM/CRLF、
実ファイルの読み書き、保存キャンセル・失敗、終了確認、最小画面の表示を含む。
NSIS インストール後も Ruby 全ファイルを取得元のハッシュと照合し、標準ライブラリやライセンスが欠けないことを確認する。

成功した CI の `Windows-verification` Artifact に容量 JSON、Ruby ファイルのハッシュ、GUI スクリーンショットを保存する。
Electron 版での過去の検証は各 PR とコミット履歴を参照する。現在のコマンド・配布形態は README と test-feedback.md を正とする。

## PR #10 全体レビュー対応

2026-10-26、Linux Cloud（Node.js 24、Rust 1.99.1、Ruby 3.4.12、Chromium 154）で確認した。

- `cargo fmt --all --check`、Rust 31 件、Node 24 件（サブテスト含む）が成功。
- 共通 GUI 40 件が約 32.2 秒で成功。各テストの状態リセットと Ruby 再確認・ソースサイズ超過の回帰を含む。ブラウザー用ホストの上限は 4 秒、本番の上限は 5 秒。
- 初期画面のスクリーンショットを確認した。

Windows は [run 40315438846 の Windows ジョブ](https://github.com/yu-suke0919/atcoder-ruby-ide/actions/runs/40315438846/job/121546745132) で Rust 30 件・Node 24 件・GUI 40 件が成功した。devtools feature なしの CDP 接続、実時間 5 秒の停止、OS の終了要求、NSIS スモーク、配布前照合を含む。最終コミットの両 OS の結果は [PR #10 の Checks](https://github.com/yu-suke0919/atcoder-ruby-ide/pull/10/checks) を参照する。


## 再読み込み・ケース改行の保護

2026-10-26 の Linux Cloud で `cargo fmt --all --check`、Rust 31 件、Node 24 件（サブテスト含む）、GUI 45 件が成功した。GUI 全件は準備後約 35.6 秒。
追加した回帰テストで再読み込み後の新しい保存先選択、ソース／ケースの離脱確認、実行中の再読み込みと再実行、CRLF / CR の実行バイト列と JSON 保存を確認した。逐次出力が続く最中の再読み込みも個別に確認した。
Windows の離脱確認・実ダイアログ・NSIS・配布前照合は PR の CI/Checks を参照する。

## AtCoder の1問取り込みと作業領域

2026-10-26 の Linux Cloud で `cargo fmt --all --check`、Rust 38 件、Node 24 件（サブテスト含む）、GUI 51 件が成功した。GUI 全件は準備後約 46.2 秒。
外部通信はローカルHTTPで状態コード・リダイレクト拒否・4 MiB上限・不正UTF-8を確認し、日本語／英語のHTML抽出と番号によるサンプル対応を固定データで検証した。
問題キャッシュの再利用、再取得のアトミック保存、既存解答・ケースの保持、破損したキャッシュや作業領域の拒否、未保存変更の確認、問題選択前の再取得、900×650の表示を確認した。GUIの通信成功／失敗はブリッジで差し替え、保存と実行は本番Rustライブラリを使う。
初回のCloud環境では `atcoder.jp` が通信許可先に含まれず、当時は実サイトへの取得が未確認だった。実サイトの確認結果は次節に記録する。Windows の実アプリ・NSIS・配布物は PR の CI/Checks を参照する。
Windows CI の初回では、HTML固定データがCRLFでチェックアウトされ、LFを含むテストの置換が実行されずサイズ超過ケースが成立しなかった。置換は改行に依存しない文字列を使い、再取得テストでも原本サンプルが実際に変わったことを検証する。

## AtCoder 実サイトとの連携

2026-10-27（日本時間）、AtCoderへの通信を許可したLinux Cloud（Rust 1.99.1、Node.js 24.19.0、Ruby 3.4.12、Chromium 154）で確認した。

- 実サイトのHTMLで、タイトルに「解説」リンクが混ざる不具合と、サンプル見出しが `section` の外にある旧形式（ABC001 A）を取り込めない不具合を再現した。資料更新後、実ページ抜粋の回帰テストが失敗することを確認して修正した。
- `practice_1`・`abc086_a`・`abc001_1` を本番の `ProblemLibrary::problem` で取得・再取得し、全7サンプルが実Rubyで一致した。解答と編集済みケースを保存し、再取得後の保持とキャッシュからの復元も成功した。
- 明示実行する `npm run test:atcoder-live` を追加した。Rustの実サイトテストは通常はignoreし、画面の実サイトテストも通常のE2E対象から分けている。通常のテスト・CIは外部サービスへ接続しない。
- 画面からABC001 Aを実際に取り込み、全3サンプル実行、解答・ケースの編集保存、再取得後の保持、再読み込み後の復元と再実行が成功した。Rust約4秒、画面約9秒（準備込み）。画面のスクリーンショットは `test-results/atcoder-live.png` に出力する。
- `npm test` はRust 41件・Node 24件が成功し、`cargo fmt --all --check` も成功した。
