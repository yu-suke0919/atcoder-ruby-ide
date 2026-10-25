# 構成と検証方針

## 最小構成

- Electron の main プロセスがファイルダイアログと Ruby プロセスを管理する。
- preload は用途を限定した API のみを画面に公開する。
- renderer は HTML / CSS / JavaScript で編集・入力・結果表示を担当する。
- Ruby 実行処理は Electron に依存しない Node.js モジュールとして分ける。
- ファイルの読み書きも画面から分離し、日本語パス・キャンセル・失敗を直接テストする。

renderer では Node.js を無効にし、context isolation と sandbox を有効にする。
画面からの値を検証し、出力は HTML として解釈せずテキストとして表示する。

## Ruby プロセス

実行時のコードを一時 UTF-8 ファイルに保存し、shell を介さず Ruby を起動する。
stdout / stderr をストリームで受け取り、標準入力を渡した後に EOF を送る。
起動時に小さな bootstrap を読み込み、標準入出力を UTF-8 の binary mode に設定する。
stdout / stderr の同期出力を有効にし、Windows でも改行を変換せず、実行中の出力をすぐ表示する。
利用者のソースはそのまま別の `.rb` ファイルとして実行し、行番号や `__FILE__` を維持する。
停止・タイムアウト・出力上限ではプロセス群を終了し、終了後に一時ファイルを削除する。
POSIX はプロセスグループ、Windows は `taskkill /T /F` を用いる。

開発時は `RUBY_PATH` または PATH 上の Ruby を使う。
配布時は `resources/ruby/bin/ruby.exe` を使い、外部の Ruby インストールに依存しない。
Ruby の公式 Windows アーカイブ・バージョン・ハッシュはリポジトリ内の manifest に固定する。
取得スクリプトは検証後に展開し、同梱物には Ruby のライセンスファイルも含める。

## テストの順序

1. Node.js の標準テストランナーで Ruby の実プロセスとファイル I/O を確認する。
2. Playwright の Electron API で実際の画面を起動し、編集・実行・停止・ファイル操作を確認する。
3. Linux では表示サーバーがない場合に Electron の headless Ozone を使う。Windows CI では Windows 用 Ruby を用いて同じ確認を行う。
4. electron-builder で Windows のポータブル exe を生成する。
5. Windows の配布用ディレクトリからも画面を起動して、同梱 Ruby での実行を確認する。

ポータブル exe は起動時に Electron と Ruby を一時ディレクトリへ展開して実行する。
初版の配布物は署名なし、Electron の既定アイコンで生成する。
ポータブル形式は Linux / Windows の両方で生成できる。
exe を生成できたことと、実際の Windows で動作確認できたことは区別する。

GitHub Actions の定義を置いたことと、その Windows ジョブを実際に実行して成功したことは区別する。
Linux 上で確認できた範囲と Windows 上で未確認の範囲を README に記録する。
