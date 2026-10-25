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
- 結果 JSON / Markdown と実際の Windows 配布物を CI Artifact として保存する。

## 受入条件と検証順序

1. この資料を先に作り、Ruby 実行・停止と容量集計のテストを実装前に追加する。
2. Rust の実プロセステストでサンプル、標準入力の EOF、日本語出力、エラー、停止、時間制限、出力上限を確認する。
3. 最小実装し、Windows の Tauri 実アプリで初期サンプルの `6 test`、日本語の stdout / stderr、停止後の再実行を確認する。
4. Playwright は WebView2 のテスト用 CDP 接続を利用する。テスト時だけデバッグ用引数を環境変数で渡す。
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

## 結果

未測定。Windows ビルドと動作確認の完了後に実測値を記録する。
