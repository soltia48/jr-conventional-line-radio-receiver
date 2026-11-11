# バイナリの利用とリリース

[English](RELEASE.md) | 日本語

JR Conventional-line Radio Receiver (JR 在来線デジタル列車無線受信アプリ)

## 配布物

GitHub Actions の **Release** ワークフローで、GUI と CLI を含むアーカイブを生成します。

| 対象 | ビルド環境 | アーカイブ |
| --- | --- | --- |
| Linux x86_64 | Ubuntu 24.04 | `*-linux-x86_64.tar.gz` |
| Windows x64 | Windows Server 2022 / MSVC | `*-windows-x86_64.zip` |
| macOS Apple Silicon | macOS 15 | `*-macos-arm64.tar.gz` |
| macOS Intel | macOS 15 | `*-macos-x86_64.tar.gz` |

アーカイブを展開し、GUI は `jr-receiver-desktop`（Windows は `.exe`）、CLI は `jr-receiver` を起動します。
`radio-presets.json` とその JSON Schema、実行環境の説明、音声係数の由来メタデータ、ビルド情報を同梱します。
配布物の `README.md` は英語版、`README.ja.md` は日本語版のリリースガイドです。冒頭のリンクで切り替えられます。
同梱 JSON は外部プリセットを編集する際のひな形です。起動時に自動適用されるファイルではありません。
アプリの設定パネル →「プリセットファイル」で明示的に選択できます。

インストーラー・AppImage・DMG・`.app` は生成しません。Windows の署名と Apple の Developer ID 署名・公証は行いません。
macOS の実行ファイルには、ライブラリ参照先の調整後にアドホック署名を付けます。配布者の本人性を示す署名ではありません。
アプリのアイコンは実行ファイルに内蔵します。macOS の単体実行ファイルも起動時に Dock のアイコンを設定します。
Finder で実行ファイル自体に表示されるアイコンは、`.app` バンドルのアイコンとは異なります。

## 実行時の依存関係

### Linux

Ubuntu 24.04 x86_64 を基準にビルドします。WebKitGTK 4.1 と SoapySDR ABI 0.8 が必要です。

```sh
sudo apt install libwebkit2gtk-4.1-0 libsoapysdr0.8
./jr-receiver-desktop
./jr-receiver presets --list
```

他のディストリビューションでは同等のライブラリが必要です。古い glibc の環境での動作は保証しません。

### macOS

CPU に合ったアーカイブを使い、[Homebrew の SoapySDR](https://formulae.brew.sh/formula/soapysdr) をインストールしてください。
Apple Silicon は `/opt/homebrew`、Intel は `/usr/local` の標準 Homebrew を使用する構成です。

```sh
brew install soapysdr
./jr-receiver-desktop
./jr-receiver presets --list
```

SoapySDR は同梱せず、Homebrew の `opt/soapysdr/lib/libSoapySDR.<ABI>.dylib`（Homebrew の SoapySDR 0.9.0 では 0.9）を参照します。ABI は `build-info.json` に記録されます。
Cellar 内の特定リビジョンへの参照は配布時に置換します。SoapySDR の機器モジュールも Homebrew 側で管理できます。

### Windows

Windows x64 と [Microsoft Edge WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/) が必要です。
SoapySDR 0.8.1 を MSVC でビルドした `SoapySDR.dll` を同梱します。2つの `.exe` と同じフォルダーに置いてください。
MSVC ランタイムがない環境では [Visual C++ 再頒布可能パッケージ x64](https://aka.ms/vs/17/release/vc_redist.x64.exe) をインストールします。

RTL-TCP / IQ WAV は、機器モジュールを追加せずに利用できます。
ローカル SDR には、別途機器ドライバーと **SoapySDR ABI 0.8 に対応した Windows x64 モジュール**が必要です。
モジュールのあるフォルダーを `SOAPY_SDR_PLUGIN_PATH` で指定し、モジュールが依存する DLL も Windows が読み込める場所に配置してください。
利用する機器モジュールは Linux / macOS でも別途必要です。検証用サーバーや個人の接続設定は配布物に含めません。

## CI

`CI`（`.github/workflows/check.yml`）はブランチへの push、pull request、手動実行で動きます。
`Cargo.lock` / `package-lock.json` を使い、次を検証します。

- Rust のフォーマット、全ターゲットの Clippy（警告をエラー扱い）、ワークスペース全体のテスト。
- UI の構文・DOM・設定テスト、宣言色のコントラスト、リリースのバージョン検証テスト。
- Cargo の GUI / CLI パッケージ、`package.json`、`src-tauri/tauri.conf.json` の製品バージョン一致。
  参照 DSP / 音声ライブラリは独立したバージョンを維持します。

実データのテスト素材と、それに依存する比較・復号テストは廃止しています。
通常の自動テストは、コード内で生成する入力や設定値を使い、収録済みの実データを必要としません。

ローカルでも、ビルド依存関係と Node.js 24.15 以降を準備して実行できます。

```sh
npm ci
bash scripts/check.sh
```

フロントエンドはそのまま Tauri に埋め込むため、Node.js は検証・配布処理に使います。フロントエンドのビルド工程はありません。
SoapySDR の Linux / macOS インストールと Windows SDK ビルドは `.github/actions/setup-native/action.yml` にまとめています。
Windows の通常ビルドでは `SOAPY_SDR_ROOT` に、`include/SoapySDR/Version.h`、`lib/SoapySDR.lib`、`bin/SoapySDR.dll` のある MSVC SDK を指定します。
実行時は DLL のフォルダーを `PATH` に追加するか、実行ファイルの隣に DLL を配置します。

## バイナリ生成と公開

**試行:** Actions → Release → Run workflow。4環境のアーカイブを Actions artifacts として14日間保存します。
手動実行はタグを選んだ場合も GitHub Release を公開しません。ブランチからの試行には `v1.8.0-dev-<短いコミットID>` のような名前を付けます。

**公開:** 上記3種類のマニフェストを同じバージョンにし、`v1.8.0` のような一致するタグを push します。
タグ名とマニフェストのバージョンが異なる場合は失敗します。
Release は共通 CI に合格してから4環境をビルドし、macOS / Windows でも Rust の全テストを実行します。
各アーカイブの CLI で組み込みプリセットの読み込みを確認し、4環境すべて成功した場合だけ GitHub Release を作成します。
アーカイブと `SHA256SUMS.txt` を添付し、リリースノートを自動生成します。再実行時は同名のアセットを更新します。

通常の CI とビルドのトークンは読み取り専用で、公開ジョブだけに `contents: write` を付与します。
特別なシークレットは不要です。タグの push / 公開は、このワークフローを追加するだけでは実行されません。

バージョン更新や試行時は以下も利用できます。

```sh
node scripts/release.mjs check-version
cargo build --release --locked -p jr-receiver-desktop -p jr-receiver
RELEASE_TARGET=linux-x86_64 node scripts/release.mjs package
```

同じ名前の配布物が `dist` に残っている場合は上書きせず失敗します。別の場所へ移してから再実行してください。

## 実装時の確認範囲

GitHub Actions の構文検証、Linux での CI 相当の検証とアーカイブ生成をローカルで行います。
macOS / Windows のビルドと実機 GUI・SDR 動作は、それぞれの runner / 実機での確認が必要です。
対象 runner は [GitHub 公式の一覧](https://docs.github.com/en/actions/reference/runners/github-hosted-runners) に基づいて指定しています。
