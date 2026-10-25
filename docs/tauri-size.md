# Tauri v2 の配布容量検証

## 目的

Windows x64 向けの配布容量が問題であるため、Tauri v2 で削減できる容量を実測する。
main の MVP をベースに、既存の HTML / CSS と同じ RubyInstaller 3.4.12-1 一式を使う最小の検証アプリを作る。
今回の対象はサンプルの編集・標準入力付き実行・stdout / stderr の表示・停止。ファイル操作と期待出力比較は全移行時の対象とする。

## 比較条件

- 同じ GitHub Actions Windows runner で Electron と Tauri をビルドする。
- Ruby は同じ SHA-256 検証済みの `vendor/ruby` を丸ごと使用する。Ruby の削減は今回の差に含めない。
- Tauri は既存の WebView2 を利用し、未導入時に取得する bootstrapper 方式の NSIS インストーラーを作る。固定版 WebView2 は同梱しない。
- 既存 Electron ポータブル exe と Tauri NSIS setup.exe の実サイズを記録する。
- パッケージ形式の差を区別するため、実行可能な各配布用ディレクトリも同じ圧縮設定で ZIP 化して比較する。
- 圧縮前の容量、Ruby の容量、実行ファイル単体の容量、圧縮後の容量を区別する。単位は bytes と MiB (1024² bytes)。
- 圧縮前はファイルの論理サイズ合計とし、`du` のディスク占有量やファイルシステムのブロック余白は含めない。同じ Ruby は論理サイズ 102.71 MiB、19,696 ファイルである。
- 結果 JSON / Markdown と実際の Windows 配布物を CI Artifact として保存する。

## 受入条件と検証順序

1. この資料を先に作り、Ruby 実行・停止と容量集計のテストを実装前に追加する。
2. Rust の実プロセステストでサンプル、標準入力の EOF、日本語出力、エラー、停止、時間制限、出力上限を確認する。
3. 最小実装し、Windows の Tauri 実アプリで初期サンプルの `6 test`、日本語の stdout / stderr、停止後の再実行を確認する。
4. Playwright は WebView2 のテスト用 CDP 接続を利用する。リリースビルドでも検証できるよう `devtools` feature を有効にする。テスト時だけ `TAURI_SIZE_TEST_PORT` を渡し、Tauri の `additionalBrowserArgs` に明示的に反映する。通常起動ではポートを開かない。
5. 配布物に含まれる Ruby を使うことを確認し、同じ Ruby 一式を含むことをハッシュでも確認する。
6. 配布容量を集計し、比較条件と制約を添えてこの資料と PR に結果を記録する。

## 判断の範囲

最小アプリの結果であり、全機能の移植後と同じ容量とは限らない。
WebView2 が未導入の端末では別途ダウンロードが必要で、その容量はアプリの配布ファイルと別に示す。
起動時間・常駐メモリは今回の判断基準に含めず、容量だけで評価する。
実験用ソースは `experiments/tauri-size` に置く。

## 再実行

Rust は 1.99.1、Tauri crate は Cargo.lock で 2.12.5、CLI は package-lock.json で 2.12.4 に固定する。
Linux では GUI の依存ライブラリなしで実プロセステストを行える。

```bash
source /workspace/.cloud-setup/activate.sh
cargo test --locked --manifest-path experiments/tauri-size/src-tauri/Cargo.toml --test runner
npm test --prefix experiments/tauri-size
```

Windows のビルド・画面確認・圧縮・計測は `.github/workflows/tauri-size.yml` で再現する。
Tauri のビルド時だけ `desktop` feature を有効にし、実プロセステストで GUI 全体の二重ビルドを避ける。
画面検証を ZIP 圧縮より先に行い、接続失敗時はプロセス情報とデスクトップ画像を診断用 Artifact に保存する。
同梱 Ruby のパス照合は Windows の拡張パス表記 (`\\?\`) を含め、Node.js 標準の `toNamespacedPath` で表記を揃えて比較する。

## 結果

2026-10-25、[Windows CI run 40193201513](https://github.com/yu-suke0919/atcoder-ruby-ide/actions/runs/40193201513) でビルド・動作・容量の検証がすべて成功した。
検証コードは `98cd01428b06357feb115559e1a84c72a1f6168f`、実際に checkout された PR のマージ参照は `35eb7699a7011a7f305da0926820419eb88eaa0e`。

| 比較 | Electron | Tauri | 削減率 |
| --- | ---: | ---: | ---: |
| 実行ファイル単体 | 238.23 MiB | 5.81 MiB | — |
| 配布用ディレクトリのファイルサイズ合計 | 459.50 MiB | 108.51 MiB | — |
| 同じ設定の ZIP (`7za -tzip -mx=9 -mmt=2`) | 178.81 MiB | 34.36 MiB | 80.8% |
| Electron portable exe / Tauri NSIS setup.exe | 119.77 MiB | 17.54 MiB | 85.4% |

Ruby は 107,695,373 bytes (102.71 MiB)、19,696 ファイルを両方に含む。全ファイルのパス・サイズ・SHA-256 が一致した。
ZIP は 187,495,627 → 36,026,189 bytes、パッケージは 125,591,636 → 18,395,198 bytes。
パッケージ形式が違う後者の削減率だけで判断せず、同じ ZIP 設定の 80.8% 削減を主な比較結果とする。

### 動作確認

- Linux / Windows の Rust 実プロセステスト 8 件と、容量集計の実ファイルテストが成功した。
- Windows の portable ディレクトリと NSIS インストール先の両方で、初期サンプルの `6 test`、日本語 stdout / stderr、停止、停止後の再実行、構文エラー表示を確認した。
- 外部の `RUBY_PATH` を存在しないパスにした状態でも起動し、実際に使用した Ruby が各配布物内の `ruby/bin/ruby.exe` であることを照合した。
- リリース版の WebView 検査設定と Windows 拡張パス表記への対応を含め、最終 CI はすべて成功した。通常起動ではテスト用ポートを開かない。

### 成果物と判断

- [JSON / Markdown / 実画面の画像](https://github.com/yu-suke0919/atcoder-ruby-ide/actions/runs/40193201513/artifacts/12598853530)
- [Windows 検証用配布物（ZIP と setup.exe の両方を含む）](https://github.com/yu-suke0919/atcoder-ruby-ide/actions/runs/40193201513/artifacts/12598718926)

同じ Ruby を残したまま配布容量が大幅に減ったため、容量対策として Tauri v2 への移行は有効と判断する。
ただし、これは編集・実行・停止に絞った検証版であり、ファイル操作・期待出力比較を含む全移行後の最終容量ではない。
CI の端末は WebView2 導入済みで、未導入端末の追加ダウンロード量はこの表に含めていない。
結果の追記コミットは資料のみであり、上記の検証コードに対する CI と区別する。
