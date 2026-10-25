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

## 検証結果（2026-10-25）

| 対象 | コマンド・方法 | 結果 |
| --- | --- | --- |
| 共通テスト 21 件 | `npm test` | 21 件成功、失敗・スキップなし |
| 画面テスト 11 件 | `npm run test:e2e` | 11 件成功、失敗・スキップなし |
| 依存関係の再現 | `npm ci` → `npm run setup:electron` | 成功。再インストール後も上記テストを実施 |
| Ruby 配布物の検証と再利用 | `npm run prepare:ruby` を再実行 | SHA-256 一致、展開済みの Ruby を再利用 |
| Windows exe | `npm run build:win` | レビュー修正を含むポータブル exe 生成成功、125,149,516 bytes |
| 同梱物 | app.asar、Ruby 実行ファイル、Ruby ライセンス | 全 src ファイルが現在のソースと一致し、同梱物の存在を確認 |

生成物は `dist/AtCoder-Ruby-IDE-0.1.0-x64.exe`。
この生成物の SHA-256 は `d989ab1bc95ccb43fdae43d7ea1884881088099cee8f4cd6b8729734183ccca4`。
再ビルド時には生成物とチェックサムの記録を合わせて更新する。

## Windows の確認範囲

この Cloud は Linux のため、実際の Windows での起動・動作確認は未実施。
Windows CI に共通・画面テストと配布用ディレクトリからの画面テストを定義している。
GitHub へ main と PR 用ブランチを push 済み。Windows CI の実行結果は未確認。
レビューで修正した内容と再現条件は [コードレビュー](review.md) に記録している。
権限変更による削除失敗の再現テスト 1 件は POSIX 専用で、Windows ではスキップする。
