# AtCoderとのRuby実行環境の整合

Phase C（Rubyの実行とLSPをWSL内のエージェントへ）を終えた後の仕様を書く。C3aで、RubyはWSL内の3.4.5で実行するようになった。C3bで、C拡張のある公式追加gemを加えた。残りの項目には実装する[ロードマップ](roadmap.md)の項目を付ける。使われなくなったWindows版Ruby（RubyInstaller 3.4.12）の準備・測定スクリプト・テストはC4で削除する。以前の測定結果は[検証記録](verification.md)とgitの履歴にある。

## 参照元と対象

2026年10月28日に次の公式資料を確認した。

- [AtCoderの使用できる言語とライブラリの一覧](https://img.atcoder.jp/file/language-update/2025-10/language-list.html)（資料に記載された情報時点は2026年6月16日）
- [Rubyのインストール・実行設定](https://img.atcoder.jp/file/language-update/2025-10/087-3-3_ruby-3-3-6.toml)
- [新ジャッジシステムの運用開始告知](https://atcoder.jp/posts/1594)

AtCoderの公開環境はLinux上のCRubyの `Ruby 3.4 (ruby 3.4.5)` で、`ruby --jit Main.rb`で実行する。本アプリはWSL2（Linux）の中で同じ3.4.5を動かし、パッチを合わせる。ビルドの設定・ディストリビューション・制限の測り方は異なるため、AtCoderと完全一致する実行環境とは扱わない。TruffleRubyは対象外。
公式情報の取得は開発時に行い、参照元・確認日・採用バージョンを設定とこの資料へ残す。アプリの利用時は通信せず、配布物だけでRubyと採用gemを実行する。

## Rubyのビルド（C3a）

- Ruby 3.4.5の公式ソース（`cache.ruby-lang.org`）のSHA-256を`config/ruby-wsl.json`に固定し、`scripts/build-wsl-runtime.sh`がCIのUbuntu 22.04で`--enable-yjit --enable-load-relative --disable-install-doc`を付けてビルドする。配置場所に依存しない形で、アプリ専用のディストリビューションの`/opt/atcoder-ruby-ide/ruby`に置く。
- 静的ライブラリ（`libruby-static.a`）を除き、実行ファイルと拡張ライブラリのデバッグ情報を`strip`で除く。Rubyの`COPYING`・`LEGAL`はライセンスとして残す。採用gemとLSP用gemもCIで同じRubyへ入れる。
- Ubuntu 22.04でビルドし、同じUbuntu 22.04（Dockerの`ubuntu:22.04`）の最小構成に、使う共有ライブラリ（`libssl3`・`libyaml-0-2`・`libffi8`・`libgmp10`・`zlib1g`）を加えたアプリ専用のディストリビューションに入れる（[WSLのエージェント](architecture.md#wslのエージェント)）。
- 開発・LinuxのCIのテストも同じ3.4.5を使う。AtCoderの言語アップデートでバージョンが変わったときは、設定の版とハッシュを変えてビルドし直す（Phase Dで手順をまとめる）。最新パッチを自動で探す更新コマンドは持たない。

## 実行の打ち切り時間

通常ファイルと問題の時間制限が不明な実行は5秒で打ち切る。制限が分かる問題は、ミリ秒で `min(30000, max(5000, 問題の制限 + 1000))` を使う。例えば[AGC038 F](https://atcoder.jp/contests/agc038/tasks/agc038_f)は8秒制限で、ローカルの打ち切りは9秒になる。1秒の余裕はRuby起動・入出力などの時間を含めるためのもので、AtCoderでの実行時間や判定は保証しない。問題の制限が29秒を超えていても、端末保護の上限は30秒とする。

Rustは実行予約時に問題の制限値から打ち切りを確定し、その実行中には変更しない。問題の制限は省略・nullを不明、設定時は1〜4,294,967,295ミリ秒の整数として受け付ける。加算は範囲を広げてから行い、30秒を超えない。0や不正な型・範囲は実行予約前に拒否する。Rubyの起動確認は問題に関係なく5秒とする。

開始通知と完了結果のexecutionLimitMsに確定した打ち切り時間を載せ、画面で再計算しない。画面下部は選択ケースの「実行時上限」を表示し、時間制限による停止理由にもその値を使う。未実行では、通常ファイル・制限不明は「既定上限5秒」、制限既知は「実行上限5〜30秒」と規則を表示する。正確な値は開始時に表示する。

全件実行は開始時の問題の制限値を固定し、各ケースへ同じ値を渡す。制限値の読み取り直しは次の実行から反映し、過去の結果の実行時上限は保持する。編集による比較・注意表示の無効化と、出力・実行時上限の保持は分ける。実行時上限は結果のクリア・再実行でリセットし、`samples.json`には保存しない。

LinuxのUIテストホストだけは、既定上限を従来のATCODER_IDE_UI_TIMEOUT_MSで短縮できる。制限既知の実行は本番と同じ5〜30秒の式を使う。テスト用の短縮を本番へ追加しない。

受入条件は境界値・最大値・不正値と予約解放、8秒の問題で6秒のコードが完了すること、不明時の既定上限、開始・結果の値の一致、手動停止・子孫の終了・次の実行・全件実行の継続とする。両OSの画面で9秒・30秒の表示、過去の結果と読み取り直し後の区別、1280×720の操作を確認する。
## 再帰スタック

C5で、AtCoderと同じく`RUBY_THREAD_VM_STACK_SIZE`を問題のメモリ制限の値（不明なら既定の値）にし、Rubyの起動前に`RLIMIT_STACK`（ネイティブスタック）を上げる。C0では、`RLIMIT_STACK`とVMスタックを1 GBにすると100万段の再帰ができた。WSL2では通常のユーザーでもハードリミットが無制限で、同じ設定で100万段の再帰ができた。次の32 MiBの固定と測定は、C5までの現在の仕様。Windowsの測定（PEヘッダーの予約量など）はC4で削除する。


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

## メモリ上限

- C5で、Rubyと子孫の合計のメモリ上限をLinuxの仕組みで設定する。`setrlimit`の`RLIMIT_AS`は使わない。Rubyは何もしていない状態でも仮想メモリを約450 MB（YJIT有効時は約590 MB）確保するため、1024 MBの`RLIMIT_AS`では512 MBの文字列も確保できなかった（[調査](architecture.md#rubyの実行環境の調査c0)）。
- 手段はcgroup v2の`memory.max`か、エージェントによる使用中のメモリ（RSS）の監視のどちらかにする。WSL2ではcgroup v2の`memory`コントローラーがあるが、通常のユーザーは`/sys/fs/cgroup`へ書けなかった（[WSL2での確認](architecture.md#wsl2での確認)）。上限の値（端末保護の固定1 GiBか、問題のメモリ制限か）もC5で決める。
- 上限で止めた実行は`memory-limit`を停止理由にし、出力比較とエラー行ジャンプを付けず、全件実行は次のケースへ進む。最初に確定した手動停止・時間制限・出力上限は上書きしない。
- WSL1はメモリ上限の仕組み（`RLIMIT_AS`・`RLIMIT_DATA`・cgroup）がなく、上限は効かない。そのことを画面に表示する。
- C3aでWSLへ移ってからC5までは、メモリ上限がない。C3aまでは、WindowsのRunnerがRubyと子孫のJob全体に1 GiBのコミット上限を設けていた。

## JIT（C5）

AtCoderと同じく`--jit`で実行する。同梱のRubyはYJIT付きでビルドするため、`--jit`でYJITが有効になる（C0で`RubyVM::YJIT.enabled?`がtrueになることを確かめた）。Runnerで有効になったことをテストで確かめる。LSPはJITを指定しない。時間超過の注意表示の説明をJITありの前提に更新する。C5までは、JITを指定せずに実行する。

## 追加するgem

AtCoderの公式追加gem 20個のうち、競技で使う見込みがあり、追加の共有ライブラリなしにCIで短時間にビルドできる次の12個を、公式と同じバージョンで同梱する（C3b）。C拡張のあるgemは、CIで同梱のRubyに向けてビルドする。gem内のライセンス資料も保持する。

| gem | バージョン | C拡張 | 用途 |
| --- | --- | --- | --- |
| ac-library-rb | 1.2.0 | なし | Union-Find、Fenwick tree、segment treeなど |
| bit_utils | 0.1.2 | あり | popcountなどのビット演算 |
| bitarray | 1.3.1 | なし | ビット配列 |
| fast_trie | 0.5.1 | あり | トライ木 |
| faster_prime | 1.0.2 | なし | 素数判定・素因数分解 |
| immutable-ruby | 0.2.0 | なし | 永続データ構造（依存先のrbtreeにC拡張） |
| numo-narray | 0.9.2.1 | あり | 多次元配列 |
| rbtree | 0.4.6 | あり | 赤黒木による順序付き連想配列 |
| rgl | 0.6.6 | なし | グラフ |
| rumale | 1.0.0 | なし | 機械学習（依存先のlbfgsbとrumale-treeにC拡張） |
| sorted_containers | 1.1.0 | なし | ソート済み集合・配列など |
| sorted_set | 1.0.3 | なし | ソート済み集合（依存先のrbtreeにC拡張） |

必要な依存gemも固定する。依存gemの具体的なバージョンはAtCoder資料で保証されていないため、要求を満たす版のうち、AtCoderの言語アップデートの時期（2025年10月）までに公開された最新版を選び、このプロジェクトで動作確認した組合せとして扱う。

- prime 0.1.3、rexml 3.4.4、pairing_heap 3.1.3、stream 0.5.6
- backports 3.25.2、function_module 0.1.1（bit_utils）
- concurrent-ruby 1.3.5（immutable-ruby）
- lbfgsb 0.6.0、mmh3 1.2.0、rumaleの部品のgem 18個（rumale-core・rumale-linear_modelなど、すべて1.0.0）

primeが依存するforwardableとsingleton、sorted_setが依存するset、rumale-coreが依存するcsvは、採用Rubyに含まれる版を使う。

`config/atcoder-runtime.json`を取得元・バージョン・SHA-256の固定情報とする。RubyGemsから取得した `.gem` はすべてハッシュ検証してから、ネットワークで依存解決せずに指定先へインストールする。C拡張は依存先の後にビルドする（lbfgsbはnumo-narrayのヘッダーを使う）。別プラットフォーム向けにビルド済みのgemは拒否する。
同梱するRubyにはCIのビルドで追加し、Linuxの開発・CIは `npm run prepare:gems` で実行用Rubyへ同じgemを追加する（C拡張のビルドにCコンパイラーを使う）。標準ライブラリの利用方法は変えない。
アプリはRuby起動前に、子プロセスの環境変数からRUBYOPT・RUBYLIB・BUNDLE_GEMFILE・GEM_HOME・GEM_PATHを除外する。端末のRubyオプション、外部ライブラリ探索先、BundlerのGemfileを引き継がない。起動後もGem.use_paths(Gem.default_dir)により、そのRubyの標準gemディレクトリだけを探索し、ユーザー用gemディレクトリから別バージョンを読み込まない。Rubyの確認とコード実行は同じRunnerを使う。prepare:gemsも選択したRubyの標準gemディレクトリへ追加するため、Linuxでは書き込み可能なRuby環境を用意する。
Rubyのソースまたは採用gemの固定情報が変わったら、同梱するディストリビューションをCIで作り直す。

## 残る差

次の8つの公式追加gemは同梱しない。未同梱のgemを必要とするコードはLoadError等になる。

| gem | 公式バージョン | 同梱しない理由 |
| --- | --- | --- |
| ffi-geos | 2.5.0 | 計算幾何のGEOSの共有ライブラリとffiのC拡張が要る。競技で使う見込みが小さい |
| lightgbm | 0.4.3 | 機械学習（勾配ブースティング）のLightGBMの共有ライブラリを使う。競技で使う見込みが小さい |
| numo-linalg | 0.1.7 | numo-openblasを使う |
| numo-openblas | 0.5.1 | インストール時にOpenBLASを取得してビルドし、時間と容量がかかる |
| or-tools | 0.16.0 | インストール時に大きなOR-Toolsのライブラリを取得する |
| polars-df | 0.21.1 | Rustで書かれた大きなC拡張で、ビルドに時間がかかる |
| torch-rb | 0.21.0 | 1 GBを超えるLibTorchを使う |
| z3 | 0.0.20230311 | Z3の共有ライブラリ（数十MB）を使う |

| 項目 | AtCoderの公式設定 | このアプリ（Phase Cの後） |
| --- | --- | --- |
| Rubyのパッチ | 3.4.5 | 3.4.5 |
| OS・ビルド | Linux上のCRuby | WSL2（Linux）上のCRuby。CIでYJIT付きでビルドしたもの |
| JIT | `ruby --jit Main.rb` | `--jit`（YJIT）。[JIT](#jitc5)を参照 |
| スタック | `RUBY_THREAD_VM_STACK_SIZE`を問題のメモリ上限に設定 | 同じ値にし、ネイティブスタックの上限も上げる（C5）。[再帰スタック](#再帰スタック)を参照 |
| 入出力 | ジャッジの標準入出力 | UTF-8・バイナリ改行・逐次出力をアプリ側で設定 |
| 上限 | 問題ごとの時間・メモリ制限 | 問題の制限値を表示し、時間超過の可能性を注意表示する。実際の打ち切りは[問題に応じて5〜30秒](#実行の打ち切り時間)、合計出力1MiB。メモリは[メモリ上限](#メモリ上限)のとおり |
| 作業ディレクトリ | ジャッジの提出領域 | WSL内の実行ごとの一時ディレクトリ |

したがって提出先での実行時間や判定の再現は保証しない。ローカルでの構文・標準入力・アルゴリズムの確認に使う。

## 検証

- 実Runnerから固定したRubyのパッチと採用gemのバージョン、代表的な処理、標準ライブラリ、日本語を含む入出力を確認する。LinuxのCIでは本物のエージェントを通して確かめる。
- 共通GUIで未保存・日本語パスのソースから追加gemを使い、期待出力との比較まで確認する。
- Windowsのポータブル版とNSIS版で、WindowsにRubyがなく、WSLのPATHにもRubyがない状態で、同梱のRubyで追加gemを実行できることを確認する（CIはWSL1）。
- RUBYOPTによる追加require・RubyGems無効化、RUBYLIBによる標準ライブラリの置換、Bundlerの外部Gemfile、GEM_HOME・GEM_PATHが別環境を指す場合も、実Runnerが採用gemを同じバージョンで使えることを確認する。
