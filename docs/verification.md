# Tauri 版の検証記録

## 環境と方法

Node.js 24、Rust 1.99.1、Tauri v2、RubyInstaller 3.4.12-1 x64 を使用する。
Cargo.lock と package-lock.json で依存を固定する。Windows 用 Ruby アーカイブの SHA-256 は取得時に照合する。

資料を先に更新し、Rust の実装前に共通テストの失敗を確認してから最小実装した。
Electron 専用の実装・依存・テストは置き換え、既存の受入条件 M01〜M11 とレビュー修正 R01〜R06 を維持する。

## 現在の結果

- Linux の Rust 共通テスト 17 件と Node のアーカイブテスト 2 件は成功済み。
- Windows の Rust 型検査では Job Object を使うプロセス管理のコンパイルを確認済み。
- Windows の最終配布物のビルド・全 GUI テスト・容量測定は移行ブランチの CI で実施中。

Windows 検証の完了後に、この節を実行コミット・CI 結果・実測値へ更新する。
Linux の共通テスト成功を Windows の起動成功として扱わない。

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
Electron 版での過去の検証は各 PR とコミット履歴を参照する。現在のコマンド・配布形態は README とこの記録を正とする。
