# Ruby LSPによる補完

Shopify Ruby LSPをローカルの別プロセスとして利用し、CodeMirrorの手動補完へ接続する。未保存文書の同期・補完取得・停止とWindowsへの同梱はRustで管理する。

- Rubyは競技実行と同じ固定済み3.4.xを使う。LSP用の追加gemは`vendor/ruby-lsp/gems`へ分離し、競技用の標準gemディレクトリには追加しない。
- `config/ruby-lsp.json`へRuby LSPと依存gemのバージョンを固定する。Rubyに含まれるPrism・RBS・logger・Bundlerも指定バージョンを確認する。追加するpure Ruby gemはRubyGemsのSHA-256を検証し、ライセンスごと準備する。C拡張のビルドは行わない。Ruby更新で同梱依存が変われば、固定情報とテストも見直す。
- `npm run prepare:lsp`で固定gemとGemfile・lock・起動スクリプトを用意する。移動後に無効になるRubyGemsのCLI用リンクは除去し、固定Gemfileで`Bundler.setup`した後、gem内の公式ruby-lsp実行ファイルをRubyから直接読み込む。起動時のcomposed bundle生成・bundle install・自動更新を使わず、ネットワーク不要とする。
- 起動時は外部のRUBYOPT・RUBYLIB・GEM_HOME・GEM_PATH・BUNDLE_*を除去し、専用のGemfileとgem探索先を設定する。Bundlerのユーザー設定を無視する。競技実行の環境隔離は維持する。
- Rustの`RubyLsp`が1つのセッションを管理する。Tauriコマンドは`lsp_start`・`lsp_complete`・`lsp_stop`。初回起動は明示的に行い、アプリ起動だけではLSPを起動しない。二重起動は同じセッションを返す。
- 作業場所はセッション専用の一時ディレクトリとし、利用者のGemfileや拡張機能を読み込まない。解答コードはファイルへ保存せず、補完要求ごとに全文を`didOpen`で送る。2回目以降は先に`didClose`を送る。全文置換の`didChange`ではRuby LSPの変更箇所の最適化により途中の宣言が再索引されないため、全文スナップショットを開き直して文書全体を解析する。文書URIはセッション内の`solution.rb`に固定し、位置は0始まりのUTF-16単位とする。初期インデックス完了後に起動成功を返す。`documentSymbol`で未保存の宣言をインデックスへ反映してから補完を取得する。
- stdioのContent-Length付きJSON-RPCで通信する。起動30秒・要求10秒・正常終了2秒を上限とし、異常終了・不正な応答・タイムアウトはエラーにする。応答は8 MiB、ヘッダーは8 KiB、文書はUTF-8で1 MiBまで。エラー後はセッションを破棄して再起動できる。要求は直列化し、停止も進行中の起動・要求が完了してから処理する。
- 終了時はshutdown／exitを送り、応答しなければプロセス群を終了する。アプリ終了・セッション破棄でもWindows Job Object／POSIXプロセスグループを終了し、標準エラーを排出してパイプ詰まりを防ぐ。
- Windowsでは配布物の`ruby/bin/ruby.exe`と`ruby-lsp/`を使い、システムRubyやPATHに依存しない。ポータブル版・NSIS版で、通信を遮断して未保存コードから補完応答を取得する。競技用gemの実行とLSP gemが競技側に見えないことも検証する。

## エディタへの接続

- Ctrl+Space／「補完」で初めて起動する。準備中・準備完了・失敗をコード欄に表示し、失敗時は「再試行」または次の手動補完で再接続できる。待機中も編集・保存・実行を使える。
- LSPへの要求はフロントエンドでも直列化する。待ち行列で無効になった要求は送らない。編集・カーソル移動・文書や問題の切替・読取専用への移行・IME・Escによる取消後の応答を表示・挿入しない。
- LSPが返すメソッド候補を優先し、同じ表示名の候補を重複させない。キーワード・文書内単語・3種類の定型コードは既存の候補生成を共有する。LSP 0.26.11は直接代入したローカル変数の型で候補を返せない場合があるため、候補がない場合と接続失敗時には既存の限定的な型推定・標準メソッド候補を使う。
- 候補の挿入範囲・挿入文字列はLSPのTextEditを使い、Undo／Redoできる通常の編集として適用する。編集範囲はカーソルのある行内に限定し、前後の行にまたがる範囲を拒否する。対応しないコマンド・追加編集・LSPスニペットは適用しない。候補の説明はプレーンテキストで表示し、既存カタログに同じ標準メソッドがあれば日本語の概要も使う。Enumerable由来の候補にはArray／Hashとして収録した説明も使い、自作クラスの同名メソッドには付けない。
- LSPと基本補完のどちらを表示している場合も、文書またはカーソル位置が変われば候補を再評価する。候補なし・応答不正・接続失敗から基本補完へ戻った場合も同じキャッシュ判定を使い、その後の入力でLSPへ再照会できるようにする。
- 公開APIとCodeMirrorの位置はUTF-16。Prism由来の補完範囲に合わせ、Ruby LSPとの通信ではUTF-8位置を選択し、Rustで入出力の位置を変換する。日本語・絵文字の前後で異なる文字を置換しない。
- Enter・Esc・Tab、IME、未保存保護、保存・実行、最小画面を既存と同じ操作で検証する。LSPの実応答に加え、遅延・失敗を制御した画面テストで古い応答の破棄と復旧を確認する。

参照：[Shopify Ruby LSPのエディタ接続](https://shopify.github.io/ruby-lsp/editors.html)、[composed bundle](https://shopify.github.io/ruby-lsp/composed-bundle.html)、[固定版の起動処理](https://github.com/Shopify/ruby-lsp/blob/v0.26.11/exe/ruby-lsp)。
