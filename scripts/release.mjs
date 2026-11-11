import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const targets = {
  "linux-x86_64": ["linux", "x64"],
  "windows-x86_64": ["win32", "x64"],
  "macos-arm64": ["darwin", "arm64"],
  "macos-x86_64": ["darwin", "x64"],
};

export function releaseLabel(versions, env = process.env) {
  const version = versions[0]?.[1];
  if (
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(
      version ?? "",
    )
  )
    throw new Error("The application version must be a semantic version");
  for (const [name, value] of versions)
    if (value !== version)
      throw new Error(`${name}: ${value} differs from ${version}`);
  if (env.GITHUB_REF_TYPE === "tag") {
    if (env.GITHUB_REF_NAME !== `v${version}`)
      throw new Error(
        `Release tag must be v${version}; got ${env.GITHUB_REF_NAME}`,
      );
    return `v${version}`;
  }
  const sha = env.GITHUB_SHA;
  if (sha && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sha))
    throw new Error("Invalid GITHUB_SHA");
  // Branch names never become paths or shell code, including manual runs.
  return `v${version}-dev-${sha ? sha.slice(0, 8) : "local"}`;
}

export function productVersions(cargo) {
  return ["jr-receiver-desktop", "jr-receiver"].map((name) => {
    const product = cargo.packages.find(
      (p) => p.name === name && cargo.workspace_members.includes(p.id),
    );
    if (!product) throw new Error(`Missing product package: ${name}`);
    return [name, product.version];
  });
}

function metadata() {
  const json = (path) => JSON.parse(readFileSync(join(root, path), "utf8"));
  const frontend = json("package.json");
  const desktop = json("src-tauri/tauri.conf.json");
  const cargo = JSON.parse(
    execFileSync(
      "cargo",
      ["metadata", "--locked", "--no-deps", "--format-version", "1"],
      { cwd: root, encoding: "utf8" },
    ),
  );
  const label = releaseLabel([
    ["package.json", frontend.version],
    ["tauri.conf.json", desktop.version],
    ...productVersions(cargo),
  ]);
  return { label, version: frontend.version, product: desktop.productName };
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: root,
    stdio: "inherit",
    ...options,
  });
}

// The SoapySDR ABI the release links against: the distribution's on Linux,
// Homebrew's on macOS, the bundled SDK's on Windows.
function soapyAbiVersion() {
  if (process.platform === "win32") {
    if (!process.env.SOAPY_SDR_ROOT)
      throw new Error("SOAPY_SDR_ROOT is required");
    const header = readFileSync(
      join(process.env.SOAPY_SDR_ROOT, "include/SoapySDR/Version.h"),
      "utf8",
    );
    const match = header.match(/^#define\s+SOAPY_SDR_ABI_VERSION\s+"([^"]+)"/m);
    if (!match) throw new Error("Cannot read SOAPY_SDR_ABI_VERSION");
    return match[1];
  }
  const version = execFileSync("pkg-config", ["--modversion", "SoapySDR"], {
    encoding: "utf8",
  }).trim();
  const match = version.match(/^(\d+\.\d+)\./);
  if (!match) throw new Error(`Unexpected SoapySDR version: ${version}`);
  return match[1];
}

function packageRelease(info) {
  const target = process.env.RELEASE_TARGET;
  const expected = targets[target];
  if (
    !expected ||
    expected[0] !== process.platform ||
    expected[1] !== process.arch
  )
    throw new Error(
      `RELEASE_TARGET ${target} does not match ${process.platform}/${process.arch}`,
    );
  const name = `jr-conventional-line-radio-receiver-${info.label}-${target}`;
  const dist = join(root, "dist");
  const stage = join(dist, name);
  const windows = process.platform === "win32";
  const extension = windows ? ".exe" : "";
  const archive = join(dist, `${name}${windows ? ".zip" : ".tar.gz"}`);
  if (existsSync(stage) || existsSync(archive))
    throw new Error(
      `Output already exists: ${stage}. Use a clean dist directory.`,
    );
  mkdirSync(stage, { recursive: true });
  const soapyAbi = soapyAbiVersion();
  for (const binary of ["jr-receiver-desktop", "jr-receiver"]) {
    const file = join(stage, binary + extension);
    copyFileSync(join(root, "target/release", binary + extension), file);
    if (!windows) chmodSync(file, 0o755);
    if (process.platform === "darwin") {
      // Avoid a Cellar version/revision path in downloadable executables.
      // Homebrew's opt symlink remains stable across patch updates.
      const listing = execFileSync("otool", ["-L", file], { encoding: "utf8" });
      const dependencies = [
        ...listing.matchAll(/^\s*(\S*libSoapySDR\.([\d.]+)\.dylib)\s+\(/gm),
      ];
      if (dependencies.length !== 1 || dependencies[0][2] !== soapyAbi)
        throw new Error(
          `Expected one SoapySDR ${soapyAbi} dependency in ${file}`,
        );
      const prefix = execFileSync("brew", ["--prefix", "soapysdr"], {
        encoding: "utf8",
      }).trim();
      const library = join(prefix, `lib/libSoapySDR.${soapyAbi}.dylib`);
      if (!existsSync(library))
        throw new Error(`Missing SoapySDR runtime: ${library}`);
      run("install_name_tool", ["-change", dependencies[0][1], library, file]);
      // Editing a Mach-O invalidates its linker-generated ad-hoc signature.
      run("codesign", ["--force", "--sign", "-", file]);
      run("codesign", ["--verify", "--strict", file]);
    }
  }
  for (const suffix of ["", ".ja"]) {
    const guide = readFileSync(join(root, `docs/RELEASE${suffix}.md`), "utf8");
    // The guides become top-level READMEs in the archive. Keep their language
    // links usable without the source repository or an internet connection.
    writeFileSync(
      join(stage, `README${suffix}.md`),
      guide
        .replaceAll("(RELEASE.md)", "(README.md)")
        .replaceAll("(RELEASE.ja.md)", "(README.ja.md)"),
    );
  }
  for (const [source, destination] of [
    ["ui/radio-presets.json", "radio-presets.json"],
    ["config/radio-presets.schema.json", "radio-presets.schema.json"],
  ]) {
    mkdirSync(dirname(join(stage, destination)), { recursive: true });
    copyFileSync(join(root, source), join(stage, destination));
  }
  if (windows) {
    if (!process.env.SOAPY_SDR_ROOT)
      throw new Error("SOAPY_SDR_ROOT is required");
    mkdirSync(join(stage, "licenses"), { recursive: true });
    copyFileSync(
      join(process.env.SOAPY_SDR_ROOT, "bin/SoapySDR.dll"),
      join(stage, "SoapySDR.dll"),
    );
    copyFileSync(
      join(root, ".ci-deps/SoapySDR/LICENSE_1_0.txt"),
      join(stage, "licenses/SoapySDR-LICENSE.txt"),
    );
  }
  writeFileSync(
    join(stage, "build-info.json"),
    JSON.stringify(
      {
        product: info.product,
        version: info.version,
        revision: process.env.GITHUB_SHA ?? null,
        target,
        soapysdr_abi: soapyAbi,
      },
      null,
      2,
    ) + "\n",
  );
  // No devices or network access: prove the staged CLI loads its native runtime
  // and reads the embedded presets before uploading an archive.
  run(join(stage, "jr-receiver" + extension), ["presets", "--list"], {
    stdio: "pipe",
  });
  if (windows) {
    run(
      "pwsh",
      [
        "-NoProfile",
        "-Command",
        "Compress-Archive -LiteralPath $env:JR_RELEASE_PACKAGE -DestinationPath $env:JR_RELEASE_ARCHIVE -CompressionLevel Optimal -ErrorAction Stop",
      ],
      {
        env: {
          ...process.env,
          JR_RELEASE_PACKAGE: stage,
          JR_RELEASE_ARCHIVE: archive,
        },
      },
    );
  } else {
    run("tar", ["-czf", archive, "-C", dist, name]);
  }
  console.log(`Created ${basename(archive)}`);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const command = process.argv[2];
    if (!["check-version", "package"].includes(command))
      throw new Error("Usage: node scripts/release.mjs check-version|package");
    const info = metadata();
    console.log(`Release version: ${info.label}`);
    if (command === "package") packageRelease(info);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
