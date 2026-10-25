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
| 共通テスト 20 件 | `npm test` | 20 件成功、失敗・スキップなし |
| 画面テスト 10 件 | `npm run test:e2e` | 10 件成功、失敗・スキップなし |
| 依存関係の再現 | `npm ci` → `npm run setup:electron` | 成功。再インストール後も上記テストを実施 |
| Ruby 配布物の検証と再利用 | `npm run prepare:ruby` を再実行 | SHA-256 一致、展開済みの Ruby を再利用 |
| Windows exe | `npm run build:win` | ポータブル exe 生成成功、125,148,959 bytes |
| 同梱物 | app.asar、Ruby 実行ファイル、Ruby ライセンス | 全 src ファイルが現在のソースと一致し、同梱物の存在を確認 |

生成物は `dist/AtCoder-Ruby-IDE-0.1.0-x64.exe`。
この生成物の SHA-256 は `f137788674719306fbf0df959a1afb9dc475b4b6fc6aca0a7896eaf9a0bf7581`。
再ビルド時には生成物とチェックサムの記録を合わせて更新する。

## Windows の確認範囲

この Cloud は Linux のため、実際の Windows での起動・動作確認は未実施。
Windows CI に共通・画面テストと配布用ディレクトリからの画面テストを定義している。
リポジトリへの push や CI の手動実行は、この作業では行っていない。
