# AtCoderとのRuby実行環境の整合

## 参照元と対象

2026年10月28日に次の公式資料を確認した。

- [AtCoderの使用できる言語とライブラリの一覧](https://img.atcoder.jp/file/language-update/2025-10/language-list.html)（資料に記載された情報時点は2026年6月16日）
- [Rubyのインストール・実行設定](https://img.atcoder.jp/file/language-update/2025-10/087-3-3_ruby-3-3-6.toml)
- [新ジャッジシステムの運用開始告知](https://atcoder.jp/posts/1594)
- [RubyInstaller公式の配布情報とSHA-256](https://github.com/oneclick/rubyinstaller.org-website/blob/master/_data/downloads.yaml)

AtCoderの公開環境はCRubyの `Ruby 3.4 (ruby 3.4.5)`。本アプリは3.4系の最新安定パッチを検証して採用し、Windows同梱版とLinux CIを同じパッチへ揃える。パッチ差による修正・標準ライブラリ・性能の違いは許容し、AtCoderと完全一致する実行環境とは扱わない。TruffleRubyは対象外。
公式情報の取得は開発時に行い、参照元・確認日・採用バージョンを設定とこの資料へ残す。アプリの利用時は通信せず、配布物だけでRubyと採用gemを実行する。

## Rubyのパッチ更新

`npm run update:ruby` は[Ruby公式のリリース一覧](https://github.com/ruby/www.ruby-lang.org/blob/master/_data/releases.yml)から最新の安定版3.4.xを選び、RubyInstaller公式の配布一覧から同じパッチのWindows x64・Devkitなし7zを取得する。同じパッチのInstaller再リリースは数値で比較して最新を選ぶ。3.5・4.x・プレビュー版・別アーキテクチャへは更新しない。対応するWindows版や正しいSHA-256がない場合、既存バージョンへ戻る場合はエラーにする。

アーカイブのSHA-256を検証し、gemの準備まで成功してから `config/ruby-windows.json` の採用バージョン・取得元・ハッシュを更新する。取得や検証の失敗時は固定情報と既存ランタイムを維持する。更新後の差分と両OSのテストを確認して採用する。

通常の `prepare:ruby`・ビルド・CIは固定情報だけを使い、最新版の探索や自動更新を行わない。Linux CIも同じ設定からRubyのパッチを読み取る。開発用Rubyもそのパッチへ揃える。AtCoderの公開バージョンと追加gemの固定情報は `config/atcoder-runtime.json` に分けて残し、Ruby本体の更新で追加gemを自動更新しない。

## 再帰スタック

実行用RubyのRUBY_THREAD_VM_STACK_SIZEを32 MiB（33,554,432 bytes）に固定する。Runnerで子プロセスごとに設定し、端末の同変数より優先する。LSPが共有するruby_commandには追加せず、LSPの起動設定は維持する。保存形式は変更しない。

採用Ruby 3.4.12で、既定値1 MiBでは失敗する通常のRubyメソッド再帰10万段が16 MiB以上で完了し、100万段には128 MiB以上が必要だった。Windowsでは深さ0の測定プロセスのピークコミット量が、既定値約54 MiB、32 MiB設定で約85 MiB、128 MiB設定で約181 MiBになった。100万段のために常に128 MiBを確保する設定は採らず、32 MiBを常用値とし、実Runnerの受入条件を通常再帰20万段の完了にする。メソッドの引数・ローカル変数などによって到達深さは変わる。

配列のeach・mapでブロックを挟む再帰は、Windows・LinuxともにVMスタックを256 MiBまで増やしても10万段でSystemStackErrorになった。Windows同梱ruby.exeのPEヘッダーのスタック予約量は2 MiBで、VMスタックとは別の制約として残る。Windows実行ファイルやOSのネイティブスタック設定は変更せず、AtCoderと同じ再帰深さは保証しない。深いDFSでは明示的な配列スタックによる反復処理も使う。

32 MiB設定でのeach・map型の最大成功深さは次のとおり（Ruby 3.4.12、2026年10月31日）。各探索は新しいRubyのメインスレッドでtests/fixtures/deep-recursion.rbを実行し、同一プロセス内で深さ0から100,000の間を二分探索した。各試行で最大成功深さの次の深さがSystemStackErrorになることも確認した。

| 測定環境 | ネイティブスタックの設定 | each型の最大成功深さ（3回の範囲） | map型の最大成功深さ（3回の範囲） |
| --- | --- | --- | --- |
| Windows x64 CI・同梱Ruby | PEヘッダーの予約量2 MiB | 1,102〜1,103 | 1,080 |
| Linux x64 CI・setup-ruby | RLIMIT_STACKのsoft limit 16 MiB | 16,611〜16,613 | 16,354〜16,358 |
| Linux x64開発環境 | RLIMIT_STACKのsoft limit 8 MiB | 8,293〜8,294 | 8,164〜8,169 |

値はこの固定コードと測定環境での結果であり、DFS全般の保証値ではない。プロセスごとに数段の差があり、OS・ビルド・ネイティブスタック上限・コードによって変わる。測定でOSのスタック設定は変更していない。AtCoderの公開tomlにはネイティブスタック・ulimitの設定がなく、AtCoderでeach型がどこまで通るかは不明。

測定は通常再帰・each・mapを深さ0・100,000・1,000,000、既定値と4・16・32・64・128・256 MiBで比較した。Windowsの再現はPowerShell 7で `pwsh -NoProfile -File scripts/measure-ruby-stack.ps1` を使い、`artifacts/reports/ruby-stack.json` に成否・実効VM設定・処理時間・ピークワーキングセット・ピークコミット量を保存する。時間は再帰処理部分、メモリは測定用Rubyプロセスの値でありIDE全体の値ではない。メモリ取得用の100 ms待機は再帰処理時間に含めない。

境目の再測定は `RUBY_PATH` に採用Rubyを指定して `node scripts/measure-ruby-recursion.cjs` を実行する。GitHub ActionsのTest and buildを手動実行し、measure_ruby_stackを有効にすると、通常のテスト・配布ビルドの代わりに両OSの測定を実行して結果をartifactへ保存する。Windowsでは従来のVMサイズ・メモリ測定も行う。

受入条件は通常再帰20万段が実Runnerで完了すること、実際のスタック上限到達後も次の実行ができること、通常コード・手動停止・5秒の時間制限・LSPが正常に動くこと。テストを先に追加し、Linux・Windowsの全テストとWindows配布検証をPRのCIで確認する。

## 追加するgem

WindowsでC拡張のビルドや外部DLLの追加が不要な次の5つを、公式と同じバージョンで同梱する。gem内のライセンス資料も保持する。

| gem | バージョン | 用途 |
| --- | --- | --- |
| ac-library-rb | 1.2.0 | Union-Find、Fenwick tree、segment treeなど |
| bitarray | 1.3.1 | ビット配列 |
| faster_prime | 1.0.2 | 素数判定・素因数分解 |
| rgl | 0.6.6 | グラフ |
| sorted_containers | 1.1.0 | ソート済み集合・配列など |

必要な依存gemも固定する。prime 0.1.3、rexml 3.4.4、pairing_heap 3.1.3、stream 0.5.6を採用する。依存gemの具体的なバージョンはAtCoder資料で保証されていないため、このプロジェクトで動作確認した組合せとして扱う。primeが依存するforwardableとsingletonは採用Rubyの標準同梱版を使う。

`config/atcoder-runtime.json`を取得元・バージョン・SHA-256の固定情報とする。RubyGemsから取得した `.gem` はすべてハッシュ検証してから、ネットワークで依存解決せずに指定先へインストールする。別プラットフォームのgemやC拡張は拒否する。
WindowsはRubyの展開先へ追加してから配布し、Linuxの開発・CIは `npm run prepare:gems` で実行用Rubyへ同じgemを追加する。標準ライブラリの利用方法は変えない。
アプリはRuby起動前に、子プロセスの環境変数からRUBYOPT・RUBYLIB・BUNDLE_GEMFILE・GEM_HOME・GEM_PATHを除外する。端末のRubyオプション、外部ライブラリ探索先、BundlerのGemfileを引き継がない。起動後もGem.use_paths(Gem.default_dir)により、そのRubyの標準gemディレクトリだけを探索し、ユーザー用gemディレクトリから別バージョンを読み込まない。Rubyの確認とコード実行は同じRunnerを使う。prepare:gemsも選択したRubyの標準gemディレクトリへ追加するため、Linuxでは書き込み可能なRuby環境を用意する。
Rubyアーカイブまたは採用gemの固定情報が変わったら、管理対象のWindowsランタイムを元アーカイブから作り直す。取得・検証・gem追加の失敗では既存のランタイムを維持する。

## 残る差

次の15の公式追加gemは、C拡張または外部ネイティブ依存があるため今回の同梱対象に含めない。未同梱のgemを必要とするコードはLoadError等になる。

| gem | 公式バージョン |
| --- | --- |
| bit_utils | 0.1.2 |
| fast_trie | 0.5.1 |
| ffi-geos | 2.5.0 |
| immutable-ruby | 0.2.0 |
| lightgbm | 0.4.3 |
| numo-linalg | 0.1.7 |
| numo-narray | 0.9.2.1 |
| numo-openblas | 0.5.1 |
| or-tools | 0.16.0 |
| polars-df | 0.21.1 |
| rbtree | 0.4.6 |
| rumale | 1.0.0 |
| sorted_set | 1.0.3 |
| torch-rb | 0.21.0 |
| z3 | 0.0.20230311 |

immutable-rubyとsorted_setはgem本体がRubyでも、依存先にrbtreeのC拡張を含む。Linuxの開発・テストでも追加するのは採用した5つとその依存だけとする。

| 項目 | AtCoderの公式設定 | このアプリ |
| --- | --- | --- |
| Rubyのパッチ | 公開情報は3.4.5 | 検証して固定した3.4系の最新パッチ |
| OS・ビルド | Linux上のCRuby | WindowsはRubyInstaller、Linux CIはsetup-rubyのCRuby |
| JIT | `ruby --jit Main.rb` | JITを指定しない。速度・メモリ使用量は同一にならない |
| スタック | `RUBY_THREAD_VM_STACK_SIZE`を問題のメモリ上限に設定 | 実行用VMスタック32 MiB、ネイティブスタックはOS・ビルドの制限が残る |
| 入出力 | ジャッジの標準入出力 | UTF-8・バイナリ改行・逐次出力をアプリ側で設定 |
| 上限 | 問題ごとの時間・メモリ制限 | 問題の制限値を表示し、時間超過の可能性を注意表示する。実際の打ち切りは5秒、合計出力1MiB。問題ごとのメモリ制限は再現しない |
| 作業ディレクトリ | ジャッジの提出領域 | 保存したソースのディレクトリ、未保存なら一時ディレクトリ |

したがって提出先での実行時間や判定の再現は保証しない。ローカルでの構文・標準入力・アルゴリズムの確認に使う。

## 検証

- 不正なgemアーカイブ・別プラットフォーム・C拡張を拒否し、既存のWindowsランタイムを壊さないことを確認する。
- 実Runnerから固定したRubyのパッチと採用gemのバージョン、代表的な処理、標準ライブラリ、日本語を含む入出力を確認する。
- 共通GUIで未保存・日本語パスのソースから追加gemを使い、期待出力との比較まで確認する。
- Windowsのポータブル版とNSIS版で、システムRubyに依存せず追加gemを実行できることを確認する。
- RUBYOPTによる追加require・RubyGems無効化、RUBYLIBによる標準ライブラリの置換、Bundlerの外部Gemfile、GEM_HOME・GEM_PATHが別環境を指す場合も、実RunnerとWindows配布版が採用gemを同じバージョンで使えることを確認する。
