# MVP 検証記録

## 実行環境

- Linux Cloud、Node.js 24.19.0、Ruby 3.4.12
- Electron 45.0.0、Playwright 1.64.1、electron-builder 26.18.0
- Windows 用 RubyInstaller 3.4.12-1 x64 は公式 SHA-256 と照合して取得済み

## TDD

1. 仕様と構成を先に作成した。
2. 実装のない状態で Ruby 実行・ファイル操作のテストが失敗することを確認した。
3. 実装してテストを通した。
4. アーカイブ検証のテストも実装前に失敗を確認した。
5. 画面で見つけた最小サイズの重なり、通常の `puts` がバッファリングされる問題も、再現テストを先に追加して修正した。
6. 追加レビューでは手動停止・タイムアウト後に出力上限へ到達する 2 件を先に失敗させ、UTF-8 の不完全な末尾をフラッシュしない最小修正で成功させた。

## 検証結果（2026-10-25）

| 対象 | コマンド・方法 | 結果 |
| --- | --- | --- |
| 共通テスト 23 件 | `npm test` | 23 件成功、失敗・スキップなし。停止要求後の出力上限の再現 2 件を含む |
| 画面テスト 12 件 | `npm run test:e2e` | 12 件成功、失敗・スキップなし。通常サイズと行高が大きい条件を含む |
| 依存関係の再現 | `npm ci` → `npm run setup:electron` | 成功。再インストール後も上記テストを実施 |
| Ruby 配布物の検証と再利用 | `npm run prepare:ruby` を再実行 | SHA-256 一致、展開済みの Ruby を再利用 |
| Windows exe | `npm run build:win` | Linux で生成を確認済み。最新の Windows ビルド結果は PR の CI チェックで確認 |
| 同梱物 | app.asar、Ruby 実行ファイル、Ruby ライセンス | Windows CI が配布用ディレクトリから同梱 Ruby で画面テストを実行 |

生成物は `dist/AtCoder-Ruby-IDE-0.1.0-x64.exe`。
最新の配布物は、成功した Windows ジョブの `AtCoder-Ruby-IDE-Windows-x64` Artifact から取得する。
実行ごとに変わるバイナリのサイズ・ハッシュは、この資料に固定しない。

## Windows の確認範囲

この Cloud 自身は Linux であり、Windows での起動・動作確認は GitHub Actions の Windows ジョブで行う。
Windows CI に共通・画面テストと配布用ディレクトリからの画面テストを定義している。
GitHub Actions run `40174188284`（コミット `f3e8b77`）では Linux ジョブが成功した。
Windows は共通テストまで成功し、`npm run test:e2e` が失敗したため、exe 生成・配布用ディレクトリからの確認・成果物保存はスキップされている。
run `40175154987` の詳細ログを取得し、Windows は画面テスト 11 件中 M01（最小ウィンドウのパネルの重なり）の 1 件が失敗し、他の 10 件が成功したことを確認した。
入力・出力の固定最小高さにより、周囲の文字の行高が大きい環境で結果欄が実行ボタンに重なる問題を修正した。
最新の確認結果は [PR #1 のチェック](https://github.com/yu-suke0919/atcoder-ruby-ide/pull/1/checks) を参照する。Cloud の成功を Windows の成功として扱わない。
レビューで修正した内容と再現条件は [コードレビュー](review.md) に記録している。
権限変更による削除失敗の再現テスト 1 件は POSIX 専用で、Windows ではスキップする。
