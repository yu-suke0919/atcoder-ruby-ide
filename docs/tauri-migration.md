# Tauri v2 への移行（完了時点の記録）

現在の Ruby 配布範囲とテスト構成は [テスト速度の改善](test-feedback.md) を参照。以下の容量・全ファイル保持・GUI 2 周は移行時点の検証履歴である。

## 方針

`feat/tauri-migration` で既存の M01〜M11、追加レビュー R01〜R06 を移行する。
期待出力比較と上書き保存時の比較保持を含む状態を移行元とする。
容量検証の [PR #3](https://github.com/yu-suke0919/atcoder-ruby-ide/pull/3) の成果を使い、Rust のファイル操作・ネイティブダイアログ・未保存確認を加える。
Electron と新旧バックエンドの並行保守は行わず、全機能と Windows 配布を検証してから main を Tauri に一本化する。

## Ruby 同梱

Windows 用 RubyInstaller 3.4.12-1 一式を同梱する。配布先で Ruby を別途インストールする必要はない。
CI は PATH から Ruby 実行ファイルのあるディレクトリを外し、`where ruby` が失敗することを確認して実アプリを起動する。
存在しない `RUBY_PATH` を設定しても、同梱の実行ファイルでサンプルと標準ライブラリが動くことを確認する。
WebView2 は端末のものを使う。未導入時は NSIS インストーラーが取得し、ZIP 版は導入済みの WebView2 を使う。

## 資料・テスト・実装

先に仕様を更新し、Rust の文書操作・比較・実行制御と画面の受入テストを追加する。
実装前に失敗を確認し、容量検証版の実行処理を基に最小実装する。
画面テストではファイルを開く・保存・キャンセル・失敗・未保存確認を実際の Windows ダイアログで確認する。
Windows の実機結果・配布物の容量・既存レビューの再現結果は、[検証記録](verification.md) に記録した。

## 検証結果

[run 40206570408](https://github.com/yu-suke0919/atcoder-ruby-ide/actions/runs/40206570408) の Linux・Windows が成功。
Rust 共通テストは Linux 17 件・Windows 16 件、Node は各 2 件、Windows GUI はポータブルと NSIS インストール後で各 23 件が成功した。
Ruby の PATH を除去した状態で、同梱 Ruby による実行・JSON 標準ライブラリ・保存・停止・比較を確認した。
Ruby は 19,696 ファイルを保持し、ポータブル・インストール先とも全ファイルのハッシュが一致した。

| 対象 | Electron 版 | Tauri 移行版 | 削減率 |
| --- | ---: | ---: | ---: |
| 展開後 | 459.50 MiB | 108.96 MiB | 76.3% |
| 同じ条件の ZIP | 178.81 MiB | 34.49 MiB | 80.7% |

Electron の比較値は [容量検証 PR #3](https://github.com/yu-suke0919/atcoder-ruby-ide/pull/3) の
[run 40193201513](https://github.com/yu-suke0919/atcoder-ruby-ide/actions/runs/40193201513) で測定した。
両方に同じ RubyInstaller 一式を含み、ZIP は `-tzip -mx9 -mmt2`。
Tauri の NSIS は 17.64 MiB。Electron の自己展開ポータブル exe は 119.77 MiB だが、形式が異なるので上の同条件比較と分けて扱う。

新しい実行基盤では旧 Electron バックエンドを残していない。大量出力時に表示が遅れる再現を Windows の受入テストで確認し、
スクロールをフレームごとにまとめる最小修正後に両配布形態の全テストが成功した。
実際のファイル選択・上書き確認は Windows のキーボード入力と UI Automation を使い、本番側にテスト専用の偽ダイアログ API は追加していない。
配布スクリプトは現在のバージョンの NSIS を明示して選び、古いビルドのインストーラーを混ぜない。
