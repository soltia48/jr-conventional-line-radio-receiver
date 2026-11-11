# Using binaries and publishing releases

English | [日本語](RELEASE.ja.md)

JR Conventional-line Radio Receiver

## Distribution archives

The GitHub Actions **Release** workflow generates archives containing the GUI and CLI.

| Target | Build environment | Archive |
| --- | --- | --- |
| Linux x86_64 | Ubuntu 24.04 | `*-linux-x86_64.tar.gz` |
| Windows x64 | Windows Server 2022 / MSVC | `*-windows-x86_64.zip` |
| macOS Apple Silicon | macOS 15 | `*-macos-arm64.tar.gz` |
| macOS Intel | macOS 15 | `*-macos-x86_64.tar.gz` |

Extract the archive and run `jr-receiver-desktop` for the GUI or `jr-receiver` for the CLI; Windows binaries have the `.exe` extension.
Each archive includes `radio-presets.json`, its JSON Schema, runtime instructions, voice-coefficient provenance metadata, and build information.
The archive's `README.md` is the English release guide and `README.ja.md` is its Japanese version. Links at the top switch between them.
The bundled preset JSON is a template for editing external presets; it is not loaded automatically at startup.
Select it explicitly through the settings panel → “プリセットファイル” (Preset file) in the app.

The workflow does not generate installers, AppImage, DMG, or `.app` bundles. It does not perform Windows signing, Apple Developer ID signing, or notarization.
macOS executables receive an ad-hoc signature after library paths are adjusted; this does not establish the publisher's identity.
Application icons are embedded in the executables. Standalone macOS executables also set the Dock icon at startup.
The icon Finder displays for an executable file is distinct from an `.app` bundle's icon.

## Runtime dependencies

### Linux

Builds target Ubuntu 24.04 x86_64 and require WebKitGTK 4.1 and SoapySDR ABI 0.8.

```sh
sudo apt install libwebkit2gtk-4.1-0 libsoapysdr0.8
./jr-receiver-desktop
./jr-receiver presets --list
```

Other distributions require equivalent libraries. Compatibility with older glibc versions is not guaranteed.

### macOS

Choose the archive for your CPU and install [SoapySDR through Homebrew](https://formulae.brew.sh/formula/soapysdr).
The build assumes a standard Homebrew installation: `/opt/homebrew` on Apple Silicon or `/usr/local` on Intel.

```sh
brew install soapysdr
./jr-receiver-desktop
./jr-receiver presets --list
```

SoapySDR is not bundled. The executables reference Homebrew's `opt/soapysdr/lib/libSoapySDR.<ABI>.dylib` (0.9 as of Homebrew's SoapySDR 0.9.0); `build-info.json` records the ABI.
References to specific Cellar revisions are replaced during packaging. Homebrew can also manage SoapySDR device modules.

### Windows

Windows x64 and the [Microsoft Edge WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/) are required.
Archives include `SoapySDR.dll`, built from SoapySDR 0.8.1 with MSVC. Keep it in the same folder as both `.exe` files.
Install the [Visual C++ Redistributable for x64](https://aka.ms/vs/17/release/vc_redist.x64.exe) if the MSVC runtime is not already installed.

RTL-TCP and IQ WAV input do not require device modules.
Local SDR hardware requires the appropriate device driver and a **Windows x64 module compatible with SoapySDR ABI 0.8**.
Set `SOAPY_SDR_PLUGIN_PATH` to the module directory and ensure its dependent DLLs are in locations Windows can load.
Local hardware also requires device modules on Linux and macOS. Archives do not include test-server addresses or personal connection settings.

## CI

`CI` (`.github/workflows/check.yml`) runs on branch pushes, pull requests, and manual dispatch.
It uses `Cargo.lock` and `package-lock.json` to check:

- Rust formatting, Clippy for all targets with warnings treated as errors, and tests across the workspace.
- UI syntax, DOM and configuration tests, declared color contrast, and release-version tests.
- Matching product versions in the Cargo GUI / CLI packages, `package.json`, and `src-tauri/tauri.conf.json`.
  The reference DSP and voice libraries retain independent versions.

Recorded test data and the comparison/decoding tests that depended on it have been removed.
Normal automated tests use generated inputs or configuration values and do not require recorded real-world data.

To run the checks locally, install the build dependencies and Node.js 24.15 or later, then run:

```sh
npm ci
bash scripts/check.sh
```

The frontend is embedded directly in Tauri. Node.js is used for validation and packaging; there is no frontend build step.
`.github/actions/setup-native/action.yml` handles Linux / macOS SoapySDR installation and the Windows SDK build.
For a local Windows build, set `SOAPY_SDR_ROOT` to the MSVC SDK directory containing `include/SoapySDR/Version.h`, `lib/SoapySDR.lib`, and `bin/SoapySDR.dll`.
At runtime, add its DLL directory to `PATH` or place the DLL beside the executable.

## Building and publishing binaries

**Trial build:** select Actions → Release → Run workflow. Artifacts for all four targets are retained for 14 days.
Manual runs never publish a GitHub Release, even when run on a tag. Branch builds use names such as `v1.8.0-dev-<short-commit-id>`.

**Publish:** set the three types of product manifest listed above to the same version, then push a matching tag such as `v1.8.0`.
A mismatch between the tag and manifest versions fails the workflow.
After the shared CI checks pass, Release builds all four targets and also runs the Rust test suite on macOS and Windows.
Each archive's CLI is checked for successful loading of the built-in presets. A GitHub Release is created only if all four targets succeed.
Archives and `SHA256SUMS.txt` are attached, with automatically generated release notes. Reruns replace assets with the same names.

CI and build jobs use read-only tokens. Only the publishing job receives `contents: write`.
No additional secrets are required. Adding the workflow does not itself push tags or publish a release.

The following commands are also useful when updating versions or testing packaging:

```sh
node scripts/release.mjs check-version
cargo build --release --locked -p jr-receiver-desktop -p jr-receiver
RELEASE_TARGET=linux-x86_64 node scripts/release.mjs package
```

Packaging fails rather than overwriting an existing archive or staging directory with the same name in `dist`.
Move the existing output elsewhere before running it again.

## Validation scope

Local validation covers GitHub Actions syntax, CI-equivalent checks on Linux, and archive generation.
macOS / Windows builds and GUI / SDR behavior on physical hardware require validation on the corresponding runners or devices.
The runner targets follow [GitHub's official runner list](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).
