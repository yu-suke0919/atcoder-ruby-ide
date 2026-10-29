# Ruby LSP起動基盤

Shopify Ruby LSPをローカルの別プロセスとして利用する。最初の段階ではRustからの起動・未保存文書の同期・補完取得・停止とWindowsへの同梱を実装する。CodeMirrorへの接続と既存の補完の置き換えは次の段階とし、画面の編集支援は現状を保つ。

- Rubyは競技実行と同じ固定済み3.4.xを使う。LSP用の追加gemは`vendor/ruby-lsp/gems`へ分離し、競技用の標準gemディレクトリには追加しない。
- `config/ruby-lsp.json`へRuby LSPと依存gemのバージョンを固定する。Rubyに含まれるPrism・RBS・logger・Bundlerも指定バージョンを確認する。追加するpure Ruby gemはRubyGemsのSHA-256を検証し、ライセンスごと準備する。C拡張のビルドは行わない。Ruby更新で同梱依存が変われば、固定情報とテストも見直す。
- `npm run prepare:lsp`で固定gemとGemfile・lock・起動スクリプトを用意する。移動後に無効になるRubyGemsのCLI用リンクは除去し、固定Gemfileで`Bundler.setup`した後、gem内の公式ruby-lsp実行ファイルをRubyから直接読み込む。起動時のcomposed bundle生成・bundle install・自動更新を使わず、ネットワーク不要とする。
- 起動時は外部のRUBYOPT・RUBYLIB・GEM_HOME・GEM_PATH・BUNDLE_*を除去し、専用のGemfileとgem探索先を設定する。Bundlerのユーザー設定を無視する。競技実行の環境隔離は維持する。
- Rustの`RubyLsp`が1つのセッションを管理する。Tauriコマンドは`lsp_start`・`lsp_complete`・`lsp_stop`。初回起動は明示的に行い、アプリ起動だけではLSPを起動しない。二重起動は同じセッションを返す。
- 作業場所はセッション専用の一時ディレクトリとし、利用者のGemfileや拡張機能を読み込まない。解答コードはファイルへ保存せず、`didOpen`／全文を置換する範囲付き`didChange`で送る。文書URIはセッション内の`solution.rb`に固定し、位置は0始まりのUTF-16単位とする。初期インデックス完了後に起動成功を返す。変更通知の処理を文書URIを持たない`workspace/symbol`要求で待ち、`documentSymbol`で未保存の宣言をインデックスへ反映してから補完を取得する。
- stdioのContent-Length付きJSON-RPCで通信する。起動30秒・要求10秒・正常終了2秒を上限とし、異常終了・不正な応答・タイムアウトはエラーにする。応答は8 MiB、ヘッダーは8 KiB、文書はUTF-8で1 MiBまで。エラー後はセッションを破棄して再起動できる。要求は直列化し、停止も進行中の起動・要求が完了してから処理する。
- 終了時はshutdown／exitを送り、応答しなければプロセス群を終了する。アプリ終了・セッション破棄でもWindows Job Object／POSIXプロセスグループを終了し、標準エラーを排出してパイプ詰まりを防ぐ。
- Windowsでは配布物の`ruby/bin/ruby.exe`と`ruby-lsp/`を使い、システムRubyやPATHに依存しない。ポータブル版・NSIS版で、通信を遮断して未保存コードから補完応答を取得する。競技用gemの実行とLSP gemが競技側に見えないことも検証する。

参照：[Shopify Ruby LSPのエディタ接続](https://shopify.github.io/ruby-lsp/editors.html)、[composed bundle](https://shopify.github.io/ruby-lsp/composed-bundle.html)、[固定版の起動処理](https://github.com/Shopify/ruby-lsp/blob/v0.26.11/exe/ruby-lsp)。
