// DOM behavior tests only. jsdom does not render layout, focus rings or audio.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import {
  makeInput,
  requiredRate,
  RATE_CANDIDATES,
  rtlTcpRateSupported,
} from "../../ui/config.mjs";
import { buildCatalog } from "../../ui/presets.mjs";
import { AudioPlayer } from "../../ui/audio.mjs";
import { OperationMonitorView } from "../../ui/operation-monitor.mjs";
import { RoutePicker } from "../../ui/route-picker.mjs";
const html = await readFile(
  new URL("../../ui/index.html", import.meta.url),
  "utf8",
);
const source = (
  await readFile(new URL("../../ui/app.js", import.meta.url), "utf8")
).replace(/^import .*;\n/gm, "");
const catalog = buildCatalog(
  JSON.parse(
    await readFile(new URL("../../ui/radio-presets.json", import.meta.url)),
  ),
);
const presets = catalog.find((p) => p.id === "east").channels;
const defaultRecordingDirectory =
  "/home/listener/Music/JR Conventional-line Radio Receiver/Recordings";
const tick = () => new Promise((resolve) => setImmediate(resolve));
function status(messages = []) {
  return {
    running: true,
    state: "receiving",
    error: null,
    center_hz: 352603125,
    sample_rate: 240000,
    source_overflows: 0,
    progress: 0,
    channels: presets.map((config, i) => ({
      config,
      error: null,
      dropped_blocks: 0,
      audio_drops: 0,
      status: {
        frame_locked: i < 3,
        iq_samples: 240000,
        frames: 20,
        voice_frames: 0,
        discontinuities: 0,
        input_dbfs: -10,
        evm_percent: 12,
        frequency_error_hz: 2,
        constellation: [],
        messages: i === 0 ? messages : [],
        data: { valid_frames: 19, corrected_frames: 0, rejected_messages: 0 },
      },
    })),
  };
}
function message(value) {
  return {
    receptions: 1,
    message: {
      kind: "Notice",
      identity: value,
      raw_hex: "0102",
      last_bit: 9600,
      fields: [{ field: "NoticeText", value }],
    },
  };
}
async function setup(
  t,
  {
    native = true,
    configureConnection = true,
    catalogError = null,
    recordingError = null,
    defaultDirectoryError = null,
    folder = "/tmp/recordings",
    preferences = { value: null },
    devices = [],
    presetFiles = { path: null, catalogs: {} },
  } = {},
) {
  const dom = new JSDOM(html, {
    url: "http://localhost",
    runScripts: "outside-only",
  });
  t.after(() => dom.window.close());
  const w = dom.window,
    calls = [],
    timers = [],
    modalCalls = [];
  const playback = [];
  const audioSources = [];
  const pollDelays = [];
  let audioContext;
  w.AudioContext = class {
    constructor() {
      audioContext = this;
    }
    state = "running";
    sampleRate = 48000;
    currentTime = 0;
    destination = {};
    async resume() {}
    createGain() {
      return { gain: { value: 1 }, connect() {} };
    }
    createBuffer(_channels, length, sampleRate) {
      const samples = new Float32Array(length);
      return { duration: length / sampleRate, getChannelData: () => samples };
    }
    createBufferSource() {
      const source = {
        playbackRate: { value: 1 },
        connect() {},
        disconnect() {},
        stop() {
          this.stopped = true;
        },
        start(at) {
          this.at = at;
          playback.push(this.buffer.getChannelData(0)[0]);
        },
      };
      audioSources.push(source);
      return source;
    }
  };
  let snapshot = { status: status(), audio: [] };
  let recording = { state: "idle", files: 0, pcm_samples: 0, error: null };
  let closeHandler;
  w.testDependencies = { makeInput, requiredRate, RATE_CANDIDATES, rtlTcpRateSupported, buildCatalog, AudioPlayer, OperationMonitorView, RoutePicker };
  w.structuredClone = structuredClone;
  // jsdom has no native modal behavior. Exercise our handlers, not a focus trap
  // or Escape key implementation; those belong to the browser's dialog element.
  w.HTMLDialogElement.prototype.showModal = function () {
    modalCalls.push("showModal");
    this.open = true;
    this.querySelector("[autofocus]")?.focus();
  };
  w.HTMLDialogElement.prototype.close = function () {
    modalCalls.push("close");
    this.open = false;
    this.dispatchEvent(new w.Event("close"));
  };
  w.HTMLCanvasElement.prototype.getContext = () =>
    new Proxy(
      {},
      {
        get: (_, key) => (typeof key === "string" ? () => {} : undefined),
        set: () => true,
      },
    );
  w.setTimeout = (callback, delay) => {
    timers.push(callback);
    pollDelays.push(delay);
    return timers.length;
  };
  w.__TAURI__ = native
    ? {
        core: {
          invoke: async (command, args) => {
            calls.push({ command, args });
            if (command === "load_preferences") {
              if (preferences.loadError) throw new Error(preferences.loadError);
              return structuredClone(preferences.value);
            }
            if (command === "save_preferences") {
              if (preferences.beforeSave)
                await preferences.beforeSave(args.settings);
              if (preferences.saveError) throw new Error(preferences.saveError);
              preferences.value = structuredClone(args.settings);
              return null;
            }
            if (command === "default_recording_directory") {
              if (defaultDirectoryError) throw new Error(defaultDirectoryError);
              return defaultRecordingDirectory;
            }
            if (command === "preset_catalog") {
              if (args?.path) {
                const external = presetFiles.catalogs[args.path];
                if (!external || external instanceof Error)
                  throw (
                    external ?? new Error(`ファイルがありません：${args.path}`)
                  );
                return structuredClone(
                  typeof external === "function" ? await external() : external,
                );
              }
              if (catalogError) throw new Error(catalogError);
              return structuredClone(catalog);
            }
            if (command === "snapshot") {
              const result =
                typeof snapshot === "function" ? await snapshot() : snapshot;
              return {
                ...result,
                status: {
                  ...result.status,
                  recording: result.status.recording ?? recording,
                },
              };
            }
            if (command === "plugin:dialog|open")
              return args.options.filters?.[0]?.extensions.includes("json")
                ? presetFiles.path
                : folder;
            if (command === "start") {
              recording = { state: "idle", files: 0, pcm_samples: 0, error: null };
              return null;
            }
            if (command === "start_recording") {
              if (recordingError) throw new Error(recordingError);
              recording = {
                state: "recording",
                options: args.options,
                raw_frames: 0,
                data_messages: 0,
                files: 0,
                pcm_samples: 0,
                error: null,
                directory: `${args.directory}/recording-test`,
              };
              return structuredClone(recording);
            }
            if (command === "stop_recording" || command === "stop") {
              if (recording.state === "recording")
                recording = { ...recording, state: "completed" };
              return structuredClone(recording);
            }
            if (command === "devices") return structuredClone(devices);
            return null;
          },
        },
        window: {
          getCurrentWindow: () => ({
            onCloseRequested: async (handler) => {
              closeHandler = handler;
            },
          }),
        },
      }
    : undefined;
  w.fetch = async (url) => {
    assert.equal(url, "radio-presets.json");
    return {
      ok: true,
      json: async () =>
        JSON.parse(
          await readFile(
            new URL("../../ui/radio-presets.json", import.meta.url),
          ),
        ),
    };
  };
  await w.eval(
    `(async () => {const { makeInput, requiredRate, RATE_CANDIDATES, rtlTcpRateSupported, buildCatalog, AudioPlayer, OperationMonitorView, RoutePicker } = window.testDependencies;\n${source}\n})()`,
  );
  const $ = (id) => w.document.getElementById(id);
  if (!catalogError)
    assert.equal($("error").hidden, true, $("error").textContent);
  $("listen").checked = false;
  // Reception tests provide their own loopback endpoint; the app starts blank.
  if (configureConnection) {
    for (const [id, value] of [
      ["host", "127.0.0.1"],
      ["port", "1234"],
    ]) {
      $(id).value = value;
      $(id).dispatchEvent(new w.Event("input", { bubbles: true }));
    }
  }
  await tick(); // finish preference writes caused by this test's initial input
  return {
    w,
    $,
    calls,
    modalCalls,
    playback,
    audioSources,
    pollDelays,
    setAudioTime: (time) => (audioContext.currentTime = time),
    preferences,
    closeWindow: async () => {
      assert.ok(closeHandler);
      let prevented = false;
      await closeHandler({
        preventDefault() {
          prevented = true;
        },
      });
      return { prevented };
    },
    setSnapshot: (value) => (snapshot = value),
    setRecording: (value) => (recording = value),
    click: async (id) => {
      $(id).click();
      await tick();
    },
    input: (id, value) => {
      $(id).value = value;
      $(id).dispatchEvent(new w.Event("input", { bubbles: true }));
    },
    change: async (id, value) => {
      $(id).value = value;
      $(id).dispatchEvent(new w.Event("change", { bubbles: true }));
      await tick();
    },
    poll: async () => {
      const timer = timers.shift();
      assert.ok(timer);
      await timer();
      await tick();
    },
  };
}
test("route draft is searchable, cancelable, and only applies explicit receive targets", async (t) => {
  const ui = await setup(t);
  ui.$("channels-simple").children[0].querySelector(".channel-select").click();
  const frequency = ui.$("selected-frequency").textContent;
  ui.$("channels-panel").open = false;
  await ui.click("route-open");
  assert.equal(ui.$("channels-panel").open, false);
  assert.equal(ui.w.document.activeElement.id, "route-search");
  await ui.click("route-apply");
  assert.equal(ui.$("route-error").hidden, false);
  ui.input("route-search", "甲府 小淵沢");
  const visible = [...ui.$("route-results").children].filter((n) => !n.hidden);
  assert.equal(visible.length, 1);
  visible[0].querySelector("input").click();
  assert.equal(ui.$("route-selected-count").textContent, "1 区間 · 4 波");
  assert.match(ui.$("route-frequencies").textContent, /352\.61250 MHz/);
  assert.equal(ui.$("bar-enabled").textContent, "22");
  ui.input("route-search", "該当なし");
  assert.equal(ui.$("route-no-results").hidden, false);
  assert.equal(ui.$("route-chosen").children.length, 1);
  ui.$("route-search").dispatchEvent(new ui.w.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  assert.equal(ui.$("route-dialog").open, false);
  assert.equal(ui.$("bar-enabled").textContent, "22");
  assert.equal(ui.w.document.activeElement.id, "route-open");
  await ui.click("route-open");
  assert.equal(ui.$("route-chosen").children.length, 0);
  ui.input("route-search", "甲府 小淵沢");
  [...ui.$("route-results").children].find((n) => !n.hidden).querySelector("input").click();
  await ui.click("route-apply");
  assert.equal(ui.$("route-dialog").open, false);
  assert.equal(ui.$("bar-enabled").textContent, "4");
  assert.equal(ui.$("selected-frequency").textContent, frequency);
  assert.equal(ui.$("auto-select").checked, false);
  assert.equal(ui.calls.some((c) => c.command === "start"), false);
  await ui.click("route-open");
  assert.equal(ui.$("route-chosen").children.length, 1);
  await ui.click("route-cancel");
  await ui.click("start");
  const start = ui.calls.find((c) => c.command === "start");
  assert.deepEqual(Array.from(start.args.config.channels, (c) => c.frequency_hz), [352581250, 352612500, 352625000, 352662500]);
  await ui.poll();
  await ui.click("route-open");
  assert.equal(ui.$("route-apply").disabled, true);
  assert.equal(ui.$("route-locked").hidden, false);
  await ui.change("route-profile", "central");
  ui.$("route-results").querySelector("input").click();
  await ui.click("route-apply");
  assert.equal(ui.$("region").value, "east");
});

test("route selection switches company after confirmation and supports legacy external presets", async (t) => {
  const legacy = structuredClone(catalog[1]);
  legacy.id = "legacy";
  delete legacy.routes;
  const ui = await setup(t, { presetFiles: { path: "/tmp/legacy.json", catalogs: { "/tmp/legacy.json": [legacy] } } });
  await ui.click("route-open");
  await ui.change("route-profile", "central");
  assert.equal(ui.$("route-common").disabled, true);
  ui.$("route-results").querySelector("input").click();
  assert.equal(ui.$("region").value, "east");
  await ui.click("route-apply");
  assert.equal(ui.$("region").value, "central");
  assert.equal(ui.$("center").value, "352.625000");
  assert.equal(ui.$("bar-enabled").textContent, "3");
  assert.equal(ui.calls.some((c) => c.command === "start"), false);
  await ui.click("preset-browse");
  await ui.click("route-open");
  assert.equal(ui.$("route-no-data").hidden, false);
  assert.equal(ui.$("route-apply").disabled, true);
  await ui.click("route-close");
  assert.equal(ui.$("all").disabled, false);
});

test("connection and output preferences survive restart without connecting or recording", async (t) => {
  const preferences = { value: null };
  const first = await setup(t, { preferences, configureConnection: false });
  assert.equal(preferences.value, null);
  first.input("host", "::1");
  first.input("port", "1234");
  first.input("ppm", "-3");
  await first.change("input-kind", "sdr");
  await first.change("region", "central");
  first.input("args", "driver=rtlsdr,serial=fixture");
  first.input("center", "352.626");
  first.input("rate", "1024000");
  first.input("gain", "19.7");
  first.input("rx-channel", "1");
  first.input("antenna", "RX");
  first.input("path", "/tmp/受信.wav");
  first.input("record-directory", "/tmp/受信保存");
  await first.click("output-audio");
  await first.click("output-raw");
  await first.click("output-data");
  assert.equal((await first.closeWindow()).prevented, false);
  assert.equal(preferences.value.version, 1);
  const second = await setup(t, {
    preferences,
    configureConnection: false,
    defaultDirectoryError: "OS folder unavailable",
  });
  for (const [id, value] of Object.entries({
    "input-kind": "sdr",
    region: "central",
    host: "::1",
    port: "1234",
    ppm: "-3",
    args: "driver=rtlsdr,serial=fixture",
    center: "352.626",
    rate: "1024000",
    gain: "19.7",
    "rx-channel": "1",
    antenna: "RX",
    path: "/tmp/受信.wav",
    "record-directory": "/tmp/受信保存",
  }))
    assert.equal(second.$(id).value, value, id);
  assert.equal(second.$("device").value, "driver=rtlsdr,serial=fixture");
  assert.equal(second.$("channels-simple").children.length, 3);
  assert.equal(second.$("output-audio").checked, false);
  assert.equal(second.$("output-raw").checked, true);
  assert.equal(second.$("output-data").checked, true);
  assert.equal(second.$("recording-error").hidden, true);
  assert.equal(
    second.calls.some((c) =>
      [
        "start",
        "start_recording",
        "devices",
        "save_preferences",
        "default_recording_directory",
      ].includes(c.command),
    ),
    false,
  );
});
test("saving remains enabled across reception stops and restart, and an explicit saving stop persists", async (t) => {
  const preferences = { value: null };
  const first = await setup(t, { preferences });
  await first.click("start");
  await first.poll();
  await first.click("record-start");
  assert.equal(preferences.value.output.enabled, true);
  await first.click("stop");
  assert.equal(preferences.value.output.enabled, true);
  assert.equal(first.$("record-stop").textContent, "保存を無効にする");

  await first.click("start");
  await first.poll();
  assert.equal(first.$("recording-state").textContent, "保存中");
  assert.equal(
    first.calls.filter((c) => c.command === "start_recording").length,
    2,
  );
  await first.closeWindow();

  const second = await setup(t, { preferences, configureConnection: false });
  assert.equal(second.$("recording-state").textContent, "保存待機");
  assert.equal(
    second.calls.some((c) => ["start", "start_recording"].includes(c.command)),
    false,
  );
  await second.click("start");
  second.setSnapshot({ status: { ...status(), state: "starting" }, audio: [] });
  await second.poll();
  assert.equal(second.calls.some((c) => c.command === "start_recording"), false);
  second.setSnapshot({ status: status(), audio: [] });
  await second.poll();
  await second.poll();
  assert.equal(
    second.calls.filter((c) => c.command === "start_recording").length,
    1,
  );
  assert.equal(second.$("recording-state").textContent, "保存中");
  await second.click("record-stop");
  assert.equal(preferences.value.output.enabled, false);
  assert.equal(second.$("stop").disabled, false);
  const third = await setup(t, { preferences, configureConnection: false });
  await third.click("start");
  await third.poll();
  assert.equal(third.calls.some((c) => c.command === "start_recording"), false);
});

test("restored saving can be disabled before reception without touching the recorder", async (t) => {
  const first = await setup(t);
  await first.click("start");
  await first.poll();
  await first.click("record-start");
  const second = await setup(t, {
    preferences: first.preferences,
    configureConnection: false,
  });
  assert.equal(second.$("record-stop").disabled, false);
  await second.click("record-stop");
  assert.equal(first.preferences.value.output.enabled, false);
  assert.equal(second.$("recording-state").textContent, "未保存");
  assert.equal(
    second.calls.some((c) =>
      ["start_recording", "stop_recording"].includes(c.command),
    ),
    false,
  );
  await second.click("start");
  await second.poll();
  assert.equal(second.calls.some((c) => c.command === "start_recording"), false);
});

test("automatic saving errors do not loop or stop reception, and EOF retains the saved choice", async (t) => {
  const first = await setup(t);
  await first.click("start");
  await first.poll();
  await first.click("record-start");
  first.setSnapshot({
    status: {
      ...status(),
      running: false,
      state: "completed",
      recording: { state: "completed", files: 0, pcm_samples: 0, error: null },
    },
    audio: [],
  });
  await first.poll();
  assert.equal(first.preferences.value.output.enabled, true);
  const second = await setup(t, {
    preferences: first.preferences,
    recordingError: "書き込めません",
  });
  await second.click("start");
  await second.poll();
  await second.poll();
  assert.equal(
    second.calls.filter((c) => c.command === "start_recording").length,
    1,
  );
  assert.equal(second.$("recording-error").hidden, false);
  assert.equal(second.$("stop").disabled, false);
  assert.equal(first.preferences.value.output.enabled, true);
  await second.click("record-stop");
  assert.equal(first.preferences.value.output.enabled, false);
});

test("editing during an in-flight save and closing waits for the latest settings", async (t) => {
  const preferences = { value: null };
  const ui = await setup(t, { preferences, configureConnection: false });
  let release;
  preferences.beforeSave = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  ui.input("host", "127.0.0.1");
  await tick();
  ui.input("port", "1234");
  ui.input("record-directory", "/tmp/latest");
  let closed = false;
  const closing = ui.closeWindow().then(() => {
    closed = true;
  });
  await tick();
  assert.equal(closed, false);
  assert.equal(preferences.value, null);
  preferences.beforeSave = null;
  release();
  await closing;
  assert.equal(preferences.value.input.port, "1234");
  assert.equal(preferences.value.output.directory, "/tmp/latest");
  assert.equal(
    ui.calls.filter((c) => c.command === "save_preferences").length,
    2,
  );
});
test("preference errors stay visible and can be retried without overwriting unread settings", async (t) => {
  const preferences = {
    value: null,
    loadError: "設定ファイルを確認してください",
  };
  const ui = await setup(t, { preferences, configureConnection: false });
  assert.equal(ui.$("preferences-error").hidden, false);
  assert.equal(ui.$("preferences-retry").textContent, "設定を再読み込み");
  ui.input("host", "127.0.0.1");
  ui.input("port", "1234");
  await tick();
  assert.equal(
    ui.calls.some((c) => c.command === "save_preferences"),
    false,
  );
  preferences.loadError = null;
  await ui.click("preferences-retry");
  assert.equal(ui.$("preferences-error").hidden, true);
  preferences.saveError = "空き容量を確認してください";
  ui.input("port", "1235");
  await tick();
  assert.equal(ui.$("preferences-error").hidden, false);
  assert.equal(ui.$("preferences-retry").textContent, "保存を再試行");
  assert.equal(preferences.value, null);
  assert.equal(ui.$("recording-error").hidden, true);
  preferences.saveError = null;
  await ui.click("preferences-retry");
  assert.equal(preferences.value.input.port, "1235");
  assert.equal(ui.$("preferences-error").hidden, true);
});
test("folder picker choices and intentionally cleared fields persist, and device scans preserve saved arguments", async (t) => {
  const preferences = { value: null };
  const ui = await setup(t, {
    preferences,
    configureConnection: false,
    devices: [{ label: "Other device", args: "driver=other" }],
  });
  ui.input("args", "driver=rtlsdr,serial=saved");
  await ui.change("input-kind", "sdr");
  await ui.click("scan");
  assert.equal(ui.$("args").value, "driver=rtlsdr,serial=saved");
  assert.equal(ui.$("device").value, "driver=rtlsdr,serial=saved");
  await ui.click("record-browse");
  await tick();
  assert.equal(preferences.value.output.directory, "/tmp/recordings");
  ui.input("record-directory", "");
  ui.input("port", "");
  await ui.closeWindow();
  const next = await setup(t, { preferences, configureConnection: false });
  assert.equal(next.$("record-directory").value, "");
  assert.equal(next.$("port").value, "");
  assert.equal(
    next.calls.some((c) => c.command === "default_recording_directory"),
    false,
  );
});
function externalCatalog() {
  return ["central", "east"].map((id) => ({
    ...structuredClone(catalog.find((p) => p.id === id)),
    id: `custom-${id}`,
    label: `外部 ${id}`,
  }));
}
test("external JSON selection persists custom profiles and supplies the receiving channels after restart", async (t) => {
  const preferences = { value: null };
  const path = "/tmp/プリセット/路線.json";
  const presetFiles = { path, catalogs: { [path]: externalCatalog() } };
  const ui = await setup(t, {
    preferences,
    presetFiles,
    configureConnection: false,
  });
  assert.equal(ui.$("preset-settings").open, false);
  await ui.click("preset-browse");
  assert.equal(ui.$("preset-path").textContent, path);
  assert.equal(ui.$("preset-source").textContent, "外部 JSON");
  assert.equal(ui.$("region").value, "custom-central");
  assert.equal(ui.$("region").options.length, 2);
  assert.equal(ui.$("channels-simple").children.length, 3);
  assert.equal(ui.$("center").value, "352.625000");
  assert.equal(ui.$("preset-error").hidden, true);
  await ui.change("region", "custom-east");
  ui.input("center", "352.604");
  ui.input("rate", "1024000");
  await ui.closeWindow();
  assert.equal(preferences.value.preset_file, path);
  assert.equal(preferences.value.input.profile, "custom-east");
  const next = await setup(t, {
    preferences,
    presetFiles,
    configureConnection: false,
  });
  assert.equal(next.$("region").value, "custom-east");
  assert.equal(next.$("center").value, "352.604");
  assert.equal(next.$("rate").value, "1024000");
  assert.equal(next.$("channels-simple").children.length, 22);
  assert.equal(
    next.calls.some((c) =>
      ["start", "start_recording", "save_preferences"].includes(c.command),
    ),
    false,
  );
  next.input("host", "127.0.0.1");
  next.input("port", "1234");
  await next.click("start");
  const started = next.calls.find((c) => c.command === "start");
  assert.deepEqual(
    started.args.config.channels.map((c) => c.frequency_hz),
    presetFiles.catalogs[path][1].channels.map((c) => c.frequency_hz),
  );
  for (const id of ["preset-browse", "preset-reload", "preset-builtin"])
    assert.equal(next.$(id).disabled, true);
  await next.click("stop");
  await next.click("preset-builtin");
  assert.equal(preferences.value.preset_file, null);
  assert.equal(next.$("region").options.length, 3);
  assert.equal(next.$("region").value, "east");
  assert.equal(next.$("preset-path").hidden, true);
});
test("cancelled or invalid external files preserve the active catalog, while reload applies edited content", async (t) => {
  const path = "/tmp/custom.json";
  const presetFiles = { path: null, catalogs: { [path]: externalCatalog() } };
  const ui = await setup(t, { presetFiles });
  const before = structuredClone(ui.preferences.value);
  await ui.click("preset-browse");
  assert.deepEqual(ui.preferences.value, before);
  presetFiles.path = path;
  await ui.click("preset-browse");
  ui.input("center", "352.626");
  await ui.click("all");
  await tick();
  const saved = structuredClone(ui.preferences.value);
  presetFiles.catalogs[path] = new Error("帯域に収まりません");
  await ui.click("preset-reload");
  assert.match(ui.$("preset-error").textContent, /帯域に収まりません/);
  assert.equal(ui.$("preset-settings").open, true);
  assert.equal(ui.$("region").value, "custom-central");
  assert.equal(ui.$("center").value, "352.626");
  assert.equal(ui.$("bar-enabled").textContent, "0");
  assert.deepEqual(ui.preferences.value, saved);
  presetFiles.path = "/tmp/other-missing.json";
  await ui.click("preset-browse");
  assert.deepEqual(ui.preferences.value, saved);
  assert.equal(ui.$("preset-path").textContent, path);
  presetFiles.catalogs[path] = externalCatalog();
  presetFiles.catalogs[path][0].label = "更新済み <script>";
  await ui.click("preset-reload");
  assert.equal(
    ui.$("region").selectedOptions[0].textContent,
    "更新済み <script>",
  );
  assert.equal(ui.$("region").querySelector("script"), null);
  assert.equal(ui.$("bar-enabled").textContent, "3");
  assert.equal(ui.$("center").value, "352.625000");
  assert.equal(ui.$("preset-error").hidden, true);
});
test("missing saved catalogs block reception and can recover without losing saved tuning or connection settings", async (t) => {
  const path = "/tmp/saved.json";
  const presetFiles = { path, catalogs: { [path]: externalCatalog() } };
  const first = await setup(t, { presetFiles });
  await first.click("preset-browse");
  first.input("center", "352.626");
  await first.closeWindow();
  const preferences = first.preferences;
  delete presetFiles.catalogs[path];
  const ui = await setup(t, {
    presetFiles,
    preferences,
    configureConnection: false,
  });
  assert.equal(ui.$("start").disabled, true);
  assert.equal(ui.$("region").disabled, true);
  assert.equal(ui.$("channels-simple").children.length, 0);
  assert.equal(ui.$("preset-error").hidden, false);
  assert.equal(ui.$("source-panel").open, true);
  assert.equal(ui.$("preset-settings").open, true);
  assert.equal(ui.$("preset-path").textContent, path);
  await ui.click("start");
  assert.equal(
    ui.calls.some((c) => c.command === "start"),
    false,
  );
  ui.input("port", "1235");
  await tick();
  assert.equal(preferences.value.preset_file, path);
  assert.equal(preferences.value.input.profile, "custom-central");
  presetFiles.catalogs[path] = externalCatalog();
  await ui.click("preset-reload");
  assert.equal(ui.$("start").disabled, false);
  assert.equal(ui.$("center").value, "352.626");
  assert.equal(ui.$("port").value, "1235");
  assert.equal(ui.$("preset-error").hidden, true);
  delete presetFiles.catalogs[path];
  const missingAgain = await setup(t, {
    presetFiles,
    preferences,
    configureConnection: false,
  });
  await missingAgain.click("preset-builtin");
  assert.equal(missingAgain.$("start").disabled, false);
  assert.equal(missingAgain.$("region").value, "east");
  assert.equal(preferences.value.preset_file, null);
});
test("loading locks receiving controls and a removed saved profile selects and persists the first available profile", async (t) => {
  const path = "/tmp/edited.json";
  let release;
  const presetFiles = {
    path,
    catalogs: {
      [path]: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    },
  };
  const ui = await setup(t, { presetFiles });
  await ui.click("preset-browse");
  for (const id of ["preset-browse", "region", "start"])
    assert.equal(ui.$(id).disabled, true);
  assert.equal(ui.$("preset-settings").getAttribute("aria-busy"), "true");
  release(externalCatalog());
  await tick();
  await ui.closeWindow();
  presetFiles.catalogs[path] = externalCatalog().slice(1);
  const next = await setup(t, {
    presetFiles,
    preferences: ui.preferences,
    configureConnection: false,
  });
  assert.equal(next.$("region").value, "custom-east");
  assert.equal(next.$("center").value, "352.603125");
  assert.match(next.$("preset-status").textContent, /先頭/);
  await next.closeWindow();
  assert.equal(ui.preferences.value.input.profile, "custom-east");
});
test("automatic selection plays the returned channel while a manual choice pins both views", async (t) => {
  const ui = await setup(t);
  // Live panels start open; a listener who collapses them keeps that choice.
  assert.equal(ui.$("channels-panel").open, true);
  assert.equal(ui.$("monitor-panel").open, true);
  ui.$("channels-panel").open = ui.$("monitor-panel").open = false;
  assert.equal(ui.$("auto-select").checked, true);
  ui.$("listen").checked = true;
  await ui.click("start");
  const next = status();
  next.selected_channel = presets[1].id;
  next.active_calls = [presets[1].id, presets[0].id];
  ui.setSnapshot({
    status: next,
    audio: [
      {
        channel: presets[1].id,
        epoch: 0,
        index: 0,
        pcm: Array(320).fill(8000),
      },
    ],
  });
  await ui.poll();
  assert.equal(ui.$("selected-frequency").textContent, "352.54375");
  assert.match(ui.$("monitor-summary").textContent, /352\.54375 MHz/);
  assert.equal(ui.$("message-channel").textContent, ui.$("monitor-summary").textContent);
  assert.equal(ui.$("monitor-panel").open, false);
  assert.deepEqual(ui.playback, [8000 / 32768]);
  assert.equal(
    ui.$("channels-simple").children[1].querySelector(".compact-state")
      .textContent,
    "通話中",
  );
  assert.equal(
    ui.calls.filter((c) => c.command === "snapshot").at(-1).args.automatic,
    true,
  );
  ui.$("channels-simple").children[0].querySelector(".channel-select").click();
  assert.equal(ui.$("auto-select").checked, false);
  assert.match(ui.$("selection-hint").textContent, /手動選択で固定中/);
  await ui.poll(); // even an automatic recommendation cannot overwrite manual mode
  assert.equal(ui.$("selected-frequency").textContent, "352.53750");
  assert.equal(
    ui.calls.filter((c) => c.command === "snapshot").at(-1).args.automatic,
    false,
  );
  assert.deepEqual(ui.playback, [8000 / 32768]);
  await ui.click("auto-select");
  await ui.poll();
  assert.equal(ui.$("selected-frequency").textContent, "352.54375");
  assert.equal(
    ui
      .$("channels")
      .children[1].querySelector(".channel-select")
      .getAttribute("aria-pressed"),
    "true",
  );
});
test("a delayed audio snapshot does not stop the playing frame or insert a new startup delay", async (t) => {
  const ui = await setup(t);
  await ui.click("listen");
  await ui.click("start");
  const burst = (first) => ({
    status: status(),
    audio: Array.from({ length: 4 }, (_, i) => ({
      channel: presets[0].id,
      epoch: 0,
      index: first + i,
      pcm: Array(320).fill(8000),
    })),
  });
  ui.setSnapshot(burst(0));
  await ui.poll();
  const tail = ui.audioSources.at(-1);
  const end = tail.at + tail.buffer.duration / tail.playbackRate.value;
  // IPC/timer delay leaves 10 ms queued: this is not a buffer underrun.
  ui.setAudioTime(end - 0.01);
  ui.setSnapshot(burst(4));
  await ui.poll();
  assert.equal(ui.audioSources.length, 8);
  assert.ok(ui.audioSources.every((node) => !node.stopped));
  assert.ok(Math.abs(ui.audioSources[4].at - end) < 1e-9);
});

test("pinning the playing channel and a stale automatic reply preserve its audio", async (t) => {
  const ui = await setup(t);
  await ui.click("listen");
  await ui.click("start");
  ui.setSnapshot({
    status: status(),
    audio: [
      {
        channel: presets[0].id,
        epoch: 0,
        index: 0,
        pcm: Array(320).fill(8000),
      },
    ],
  });
  await ui.poll();
  let deliver;
  ui.setSnapshot(
    () =>
      new Promise((resolve) => {
        deliver = resolve;
      }),
  );
  const polling = ui.poll();
  await tick();
  ui.$("channels-simple").children[0].querySelector(".channel-select").click();
  assert.equal(ui.$("auto-select").checked, false);
  assert.ok(ui.audioSources.every((node) => !node.stopped));
  deliver({ status: { ...status(), selected_channel: presets[1].id }, audio: [] });
  await polling;
  assert.ok(ui.audioSources.every((node) => !node.stopped));
  await ui.click("listen");
  assert.ok(ui.audioSources.every((node) => node.stopped));
  assert.equal(ui.$("audio-state").textContent, "消音中");
});

test("snapshot work counts toward the polling period rather than extending it", async (t) => {
  const ui = await setup(t);
  await ui.click("start");
  let time = 0;
  ui.w.performance.now = () => time;
  ui.setSnapshot(() => {
    time += 75;
    return { status: status(), audio: [] };
  });
  await ui.poll();
  assert.equal(ui.pollDelays.at(-1), 105);
  ui.setSnapshot(() => {
    time += 250;
    return { status: status(), audio: [] };
  });
  await ui.poll();
  assert.equal(ui.pollDelays.at(-1), 20);
});

test("manual selection rejects an automatic snapshot already in flight", async (t) => {
  const ui = await setup(t);
  await ui.click("start");
  let deliver;
  ui.setSnapshot(
    () =>
      new Promise((resolve) => {
        deliver = resolve;
      }),
  );
  const polling = ui.poll();
  await tick();
  ui.$("channels").children[2].querySelector(".channel-select").click();
  deliver({
    status: {
      ...status([message("late")]),
      selected_channel: presets[1].id,
      active_calls: [presets[1].id],
    },
    audio: [],
  });
  await polling;
  assert.equal(ui.$("selected-frequency").textContent, "352.55000");
  assert.equal(ui.$("auto-select").checked, false);
  assert.equal(ui.$("messages").textContent.includes("late"), false);
  assert.equal(
    ui
      .$("channels-simple")
      .children[2].querySelector(".channel-select")
      .getAttribute("aria-pressed"),
    "true",
  );
});
test("JSONL outputs can be selected without audio and empty output choices are rejected", async (t) => {
  const ui = await setup(t);
  await ui.click("start");
  await ui.poll();
  ui.$("recording-settings").open = true;
  await ui.click("output-audio");
  await ui.click("record-start");
  assert.match(ui.$("recording-error").textContent, /1 つ以上/);
  assert.equal(
    ui.calls.some((c) => c.command === "start_recording"),
    false,
  );
  assert.equal(ui.w.document.activeElement.id, "output-audio");
  await ui.click("output-raw");
  await ui.click("output-data");
  await ui.click("record-start");
  const args = ui.calls.find((c) => c.command === "start_recording").args;
  assert.deepEqual(JSON.parse(JSON.stringify(args.options)), {
    audio: false,
    raw_frames: true,
    data_messages: true,
  });
  assert.equal(ui.$("output-data").matches(":disabled"), true);
  ui.$("recording-settings").open = false;
  assert.equal(ui.$("record-stop").disabled, false);
  ui.setRecording({
    state: "recording",
    files: 0,
    pcm_samples: 0,
    raw_frames: 17,
    data_messages: 6,
    error: null,
  });
  await ui.poll();
  assert.match(
    ui.$("recording-summary").textContent,
    /生フレーム 17 件.*データ電文 6 件/,
  );
  await ui.click("record-stop");
  assert.equal(ui.$("output-data").matches(":disabled"), false);
  assert.equal(ui.$("stop").disabled, false);
});
test("configuration load failure shows an error and blocks starting", async (t) => {
  const ui = await setup(t, { catalogError: "設定の検証に失敗しました" });
  assert.match(ui.$("error").textContent, /設定の検証に失敗しました/);
  assert.equal(ui.$("error").hidden, false);
  assert.equal(ui.$("start").disabled, true);
  assert.equal(ui.$("region").disabled, true);
  await ui.click("start");
  assert.equal(
    ui.calls.some((c) => c.command === "start"),
    false,
  );
});
test("about dialog shows product and author, restores focus, and leaves reception and recording running", async (t) => {
  const ui = await setup(t);
  const dialog = ui.$("about-dialog");
  assert.equal(dialog.tagName, "DIALOG");
  assert.equal(dialog.getAttribute("aria-labelledby"), "about-title");
  assert.equal(dialog.open, false);
  assert.doesNotMatch(
    ui.w.document.querySelector("footer").textContent,
    /Author|KIRISHIKI|protonmail/,
  );
  assert.match(dialog.textContent, /JR Conventional-line Radio Receiver/);
  assert.match(dialog.textContent, /JR 在来線デジタル列車無線受信アプリ/);
  assert.match(dialog.textContent, /v1\.7\.0/);
  assert.match(dialog.textContent, /KIRISHIKI Yudai/);
  assert.equal(
    dialog.querySelector("a").getAttribute("href"),
    "mailto:yudai.kirishiki@protonmail.com",
  );
  await ui.click("start");
  await ui.poll();
  await ui.click("record-start");
  const commands = ui.calls.length;
  await ui.click("about-open");
  assert.equal(dialog.open, true);
  assert.deepEqual(ui.modalCalls, ["showModal"]);
  assert.equal(ui.w.document.activeElement.id, "about-close");
  assert.equal(ui.calls.length, commands);
  await ui.poll();
  assert.equal(ui.$("state").textContent, "受信中");
  assert.equal(ui.$("recording-state").textContent, "保存中");
  await ui.click("about-close");
  assert.equal(dialog.open, false);
  assert.equal(ui.w.document.activeElement.id, "about-open");
  assert.equal(ui.$("stop").disabled, false);
  assert.equal(ui.$("record-stop").disabled, false);
  assert.equal(
    ui.calls.some(
      (c) => c.command === "stop" || c.command === "stop_recording",
    ),
    false,
  );
  await ui.click("about-open");
  dialog.close(); // The browser also closes this way after native Escape handling.
  assert.equal(ui.w.document.activeElement.id, "about-open");
});
test("browser preview loads the same structured configuration and can switch profiles", async (t) => {
  const ui = await setup(t, { native: false });
  assert.equal(ui.$("channels").children.length, 22);
  await ui.change("region", "west");
  assert.equal(ui.$("channels").children.length, 19);
  assert.equal(ui.$("center").value, "352.603125");
  assert.equal(ui.$("start").disabled, true);
  assert.equal(ui.$("record-start").disabled, true);
  assert.equal(ui.$("record-browse").disabled, true);
  assert.equal(ui.calls.length, 0);
  await ui.click("about-open");
  assert.equal(ui.$("about-dialog").open, true);
  assert.equal(ui.calls.length, 0);
});

test("simple and detailed views share selection, receive targets, filtering and live state", async (t) => {
  const ui = await setup(t);
  const tiles = ui.$("channels-simple").children;
  const detailed = ui.$("channels").children;
  assert.equal(tiles.length, 22);
  assert.equal(ui.$("channels-simple").hidden, false);
  assert.equal(ui.$("channels-table").hidden, true);
  assert.equal(ui.$("view-simple").getAttribute("aria-pressed"), "true");
  assert.equal(ui.$("view-detailed").getAttribute("aria-pressed"), "false");
  assert.match(tiles[1].querySelector("button").textContent, /352\.54375 MHz/);
  tiles[0].querySelector("input").click();
  tiles[1].querySelector("button").click();
  assert.equal(tiles[0].querySelector(".compact-state").textContent, "対象外");
  assert.equal(detailed[0].querySelector("input").checked, false);
  assert.equal(ui.$("selected-frequency").textContent, "352.54375");

  const calls = ui.calls.length;
  await ui.click("view-detailed");
  assert.equal(ui.calls.length, calls);
  assert.equal(ui.$("channels-simple").hidden, true);
  assert.equal(ui.$("channels-table").hidden, false);
  assert.equal(
    detailed[1].querySelector("button").getAttribute("aria-pressed"),
    "true",
  );
  assert.equal(ui.$("selected-frequency").textContent, "352.54375");
  ui.input("channel-search", "D1");
  assert.ok(Array.from(tiles).some((r) => r.hidden));
  assert.deepEqual(
    Array.from(tiles, (r) => r.hidden),
    Array.from(detailed, (r) => r.hidden),
  );
  await ui.click("view-simple");
  assert.equal(ui.$("view-simple").getAttribute("aria-pressed"), "true");
  assert.equal(ui.$("view-detailed").getAttribute("aria-pressed"), "false");
  await ui.click("start");
  assert.equal(
    ui.calls.find((c) => c.command === "start").args.config.channels.length,
    21,
  );

  const live = status([message("表示を切り替えても残る電文")]);
  live.channels[1].status.messages = live.channels[0].status.messages;
  live.channels[1].status.voice_frames = 7;
  live.channels[2].error = "この波で受信エラー";
  ui.setSnapshot({ status: live, audio: [] });
  await ui.poll();
  assert.equal(tiles[0].querySelector(".compact-state").textContent, "対象外");
  assert.equal(tiles[1].querySelector(".compact-state").textContent, "同期");
  assert.equal(tiles[2].querySelector(".compact-state").textContent, "エラー");
  assert.equal(tiles[3].querySelector(".compact-state").textContent, "探索");
  for (const input of ui.$("channels-simple").querySelectorAll("input"))
    assert.equal(input.disabled, true);
  await ui.click("record-start");
  await ui.click("pause-messages");
  const beforeSwitch = ui.calls.length;
  await ui.click("view-detailed");
  assert.equal(ui.calls.length, beforeSwitch);
  assert.equal(ui.$("recording-state").textContent, "保存中");
  assert.equal(ui.$("record-stop").disabled, false);
  assert.match(ui.$("messages").textContent, /表示を切り替えても残る電文/);
  assert.equal(ui.$("pause-messages").getAttribute("aria-pressed"), "true");
  assert.equal(detailed[1].querySelectorAll(".numeric")[0].textContent, "7");
  assert.equal(detailed[1].querySelector("input").disabled, true);
  await ui.click("stop");
  assert.equal(tiles[1].querySelector(".compact-state").textContent, "停止");
  await ui.change("region", "central");
  assert.equal(ui.$("channels-simple").children.length, 3);
  assert.equal(ui.$("channels").children.length, 3);
  assert.equal(ui.$("channels-table").hidden, false);
});
test("recording settings collapse without hiding start, stop or errors", async (t) => {
  const ui = await setup(t);
  const settings = ui.$("recording-settings");
  assert.equal(settings.open, false);
  assert.equal(settings.contains(ui.$("record-start")), false);
  assert.equal(settings.contains(ui.$("record-stop")), false);
  assert.equal(settings.contains(ui.$("recording-error")), false);
  settings.querySelector("summary").click();
  assert.equal(settings.open, true);
  settings.querySelector("summary").click();
  assert.equal(settings.open, false);
  await ui.click("start");
  await ui.poll();
  await ui.click("record-start");
  await ui.poll();
  assert.equal(settings.open, false);
  assert.equal(ui.$("recording-state").textContent, "保存中");
  assert.equal(ui.$("record-stop").disabled, false);
  await ui.click("record-stop");
  assert.equal(settings.open, false);
  assert.equal(ui.$("recording-state").textContent, "保存完了");
  settings.open = true;
  ui.input("record-directory", "");
  settings.open = false;
  await ui.click("record-start");
  assert.equal(settings.open, true);
  assert.equal(ui.w.document.activeElement.id, "record-directory");
  assert.equal(ui.$("recording-error").hidden, false);
});
test("recording starts with the OS default folder without a picker and preserves a custom choice", async (t) => {
  const ui = await setup(t);
  assert.equal(ui.$("record-directory").value, defaultRecordingDirectory);
  await ui.click("start");
  await ui.poll();
  await ui.click("record-start");
  assert.deepEqual(
    JSON.parse(
      JSON.stringify(
        ui.calls.find((c) => c.command === "start_recording").args,
      ),
    ),
    {
      directory: defaultRecordingDirectory,
      options: { audio: true, raw_frames: false, data_messages: false },
    },
  );
  assert.equal(ui.$("recording-state").textContent, "保存中");
  assert.equal(
    ui.calls.some((c) => c.command === "plugin:dialog|open"),
    false,
  );
  await ui.click("record-stop");
  await ui.click("stop");
  ui.input("record-directory", "/tmp/受信録音");
  await ui.change("region", "central");
  await ui.click("start");
  await ui.poll();
  assert.equal(ui.$("record-directory").value, "/tmp/受信録音");
  await ui.click("record-start");
  assert.equal(
    ui.calls.filter((c) => c.command === "start_recording").at(-1).args
      .directory,
    "/tmp/受信録音",
  );
});
test("failure to resolve the default folder allows reception and a manual recording destination", async (t) => {
  const ui = await setup(t, {
    defaultDirectoryError:
      "初期保存先を取得できません。保存先フォルダーを選択してください。",
  });
  assert.equal(ui.$("record-directory").value, "");
  assert.equal(ui.$("recording-error").hidden, false);
  assert.match(ui.$("recording-error").textContent, /保存先フォルダーを選択/);
  assert.equal(ui.$("start").disabled, false);
  assert.equal(ui.$("record-browse").disabled, false);
  await ui.click("record-browse");
  assert.equal(ui.$("recording-error").hidden, true);
  await ui.click("start");
  await ui.poll();
  await ui.click("record-start");
  assert.equal(ui.$("recording-state").textContent, "保存中");
  assert.equal(
    ui.calls.find((c) => c.command === "start_recording").args.directory,
    "/tmp/recordings",
  );
});
test("recording validates its folder, is independent of monitoring, and stops without stopping reception", async (t) => {
  const ui = await setup(t);
  assert.equal(ui.$("record-start").disabled, true);
  await ui.click("start");
  assert.equal(ui.$("record-start").disabled, true);
  await ui.poll();
  ui.input("record-directory", "");
  await ui.click("record-start");
  assert.equal(ui.$("record-directory").getAttribute("aria-invalid"), "true");
  assert.equal(ui.w.document.activeElement.id, "record-directory");
  assert.equal(
    ui.calls.some((c) => c.command === "start_recording"),
    false,
  );
  await ui.click("record-browse");
  assert.equal(
    ui.calls.find((c) => c.command === "plugin:dialog|open").args.options
      .directory,
    true,
  );
  await ui.click("record-start");
  assert.deepEqual(
    JSON.parse(
      JSON.stringify(
        ui.calls.find((c) => c.command === "start_recording").args,
      ),
    ),
    {
      directory: "/tmp/recordings",
      options: { audio: true, raw_frames: false, data_messages: false },
    },
  );
  assert.equal(ui.$("recording-state").textContent, "保存中");
  assert.equal(ui.$("record-directory").disabled, true);
  assert.equal(ui.$("record-browse").disabled, true);
  assert.equal(ui.w.document.activeElement.id, "record-stop");
  ui.$("channels-simple").querySelectorAll("button")[1].click();
  ui.$("listen").dispatchEvent(new ui.w.Event("change")); // remains muted
  ui.input("channel-search", "D1");
  assert.equal(
    ui.calls.some((c) => c.command === "stop_recording"),
    false,
  );
  ui.setRecording({
    state: "recording",
    files: 2,
    pcm_samples: 8000,
    error: null,
    directory: "/tmp/recordings/recording-test",
  });
  await ui.poll();
  assert.match(ui.$("recording-summary").textContent, /2 ファイル.*1.0 秒/);
  await ui.click("record-stop");
  assert.equal(ui.$("recording-state").textContent, "保存完了");
  assert.equal(ui.$("record-directory").disabled, false);
  assert.equal(ui.$("stop").disabled, false);
  assert.equal(ui.w.document.activeElement.id, "record-start");
  assert.equal(
    ui.calls.some((c) => c.command === "stop"),
    false,
  );
});
test("receiving stop finalizes recording and leaves the saved folder visible", async (t) => {
  const ui = await setup(t);
  await ui.click("start");
  await ui.poll();
  await ui.click("record-browse");
  await ui.click("record-start");
  ui.setRecording({
    state: "recording",
    files: 1,
    pcm_samples: 320,
    error: null,
    directory: "/tmp/recordings/recording-test",
  });
  ui.setSnapshot({
    status: { ...status(), running: false, state: "stopped" },
    audio: [],
  });
  await ui.click("stop");
  assert.equal(ui.$("recording-state").textContent, "保存完了");
  // Switching profiles cancels polling the old session. Final recording state
  // must come from the stop response, not depend on a subsequent poll.
  await ui.change("region", "central");
  await ui.poll();
  assert.equal(ui.$("recording-state").textContent, "保存完了");
  assert.equal(ui.$("record-start").disabled, true);
  assert.equal(ui.$("record-stop").disabled, false);
  assert.equal(ui.$("record-stop").textContent, "保存を無効にする");
  assert.match(ui.$("recording-output").textContent, /recording-test/);
  assert.equal(ui.$("recording-output").hidden, false);
});
test("writer failure is shown separately and does not interrupt reception", async (t) => {
  const ui = await setup(t);
  await ui.click("start");
  await ui.poll();
  await ui.click("record-browse");
  await ui.click("record-start");
  ui.setRecording({
    state: "failed",
    files: 1,
    pcm_samples: 320,
    error: "保存処理が追いつきません",
    directory: "/tmp/recordings/recording-test",
  });
  await ui.poll();
  assert.equal(ui.$("recording-state").textContent, "保存エラー");
  assert.match(ui.$("recording-error").textContent, /保存処理が追いつきません/);
  assert.equal(ui.$("recording-error").hidden, false);
  assert.equal(ui.$("record-start").disabled, false);
  assert.equal(ui.$("state").textContent, "受信中");
  assert.equal(ui.$("total-data").textContent, "418");
  assert.equal(ui.$("error").hidden, true);
  assert.equal(ui.$("recording-settings").open, true);
  ui.$("recording-settings").open = false;
  await ui.poll();
  assert.equal(ui.$("recording-settings").open, false);
  assert.equal(ui.$("recording-error").hidden, false);
});
test("cancelled directory picker and rejected recording start never report recording", async (t) => {
  const ui = await setup(t, {
    folder: null,
    recordingError: "フォルダーへ書き込めません",
  });
  await ui.click("record-browse");
  assert.equal(ui.$("record-directory").value, defaultRecordingDirectory);
  await ui.click("start");
  await ui.poll();
  ui.input("record-directory", "/tmp/read-only");
  await ui.click("record-start");
  assert.equal(ui.$("recording-state").textContent, "未保存");
  assert.equal(ui.$("recording-error").hidden, false);
  assert.match(ui.$("recording-error").textContent, /書き込めません/);
  assert.equal(ui.$("record-directory").disabled, false);
  assert.equal(ui.$("stop").disabled, false);
});
test("default source requires a user endpoint; filtering never removes active channels", async (t) => {
  const ui = await setup(t, { configureConnection: false });
  assert.equal(ui.$("host").value, "");
  assert.equal(ui.$("port").value, "");
  assert.equal(
    ui.$("source-summary").textContent,
    "JR 東日本（22波） · RTL-TCP · 接続先未設定",
  );
  await ui.click("start");
  assert.equal(ui.w.document.activeElement.id, "host");
  assert.equal(
    ui.calls.some((c) => c.command === "start"),
    false,
  );
  ui.input("host", "127.0.0.1");
  await ui.click("start");
  assert.equal(ui.w.document.activeElement.id, "port");
  assert.equal(
    ui.calls.some((c) => c.command === "start"),
    false,
  );
  ui.input("port", "1234");
  assert.equal(
    ui.$("source-summary").textContent,
    "JR 東日本（22波） · RTL-TCP · 127.0.0.1:1234",
  );
  assert.equal(
    ui.calls.some((c) => c.command === "start"),
    false,
  );
  assert.equal(ui.$("channels").children.length, 22);
  ui.input("channel-search", "D1");
  assert.ok(ui.$("channels").querySelectorAll("tr:not([hidden])").length < 22);
  await ui.click("start");
  const config = ui.calls.find((c) => c.command === "start").args.config;
  assert.equal(config.channels.length, 22);
  assert.equal(config.input.kind, "rtl_tcp");
  assert.equal(config.input.radio.host, "127.0.0.1");
  assert.equal(config.input.radio.port, 1234);
  assert.equal(ui.$("settings").disabled, true);
  assert.equal(ui.w.document.activeElement.id, "stop");
  await ui.poll();
  assert.equal(ui.$("bar-locked").textContent, "3");
  assert.equal(ui.$("total-data").textContent, "418");
  ui.setSnapshot({
    status: { ...status(), running: false, state: "stopped" },
    audio: [],
  });
  await ui.click("stop");
  await ui.poll();
  assert.equal(ui.$("settings").disabled, false);
  assert.equal(ui.$("state").textContent, "停止中");
  assert.equal(ui.$("channels").querySelectorAll("td.locked").length, 0);
});

test("each company selection starts exactly its assigned channels and updates the band", async (t) => {
  for (const [id, count, center, low, high] of [
    ["central", 3, "352.625000", "352.60000", "352.65000"],
    ["west", 19, "352.603125", "352.53750", "352.66875"],
  ]) {
    const ui = await setup(t);
    await ui.change("region", id);
    assert.equal(ui.$("channels").children.length, count);
    assert.equal(ui.$("all-label").textContent, `全 ${count} 波を受信`);
    assert.equal(ui.$("all").checked, true);
    assert.equal(ui.$("center").value, center);
    assert.equal(ui.$("rate").value, "240000");
    assert.equal(ui.$("band-low").textContent, low);
    assert.equal(ui.$("band-high").textContent, high);
    await ui.click("start");
    const config = ui.calls.find((c) => c.command === "start").args.config;
    assert.equal(config.channels.length, count);
    assert.equal(
      config.input.radio.center_hz,
      Math.round(Number(center) * 1e6),
    );
    assert.equal(config.input.radio.sample_rate, 240000);
    if (id === "west") {
      assert.equal(config.channels[1].id, "352543750");
      assert.equal(config.channels[1].format, "common");
    } else {
      assert.deepEqual(
        Array.from(config.channels, (c) => c.frequency_hz),
        [352600000, 352637500, 352650000],
      );
    }
  }
});
test("returning to East resets radio tuning and a WAV preset switch preserves recording metadata", async (t) => {
  const ui = await setup(t);
  await ui.change("region", "central");
  assert.equal(ui.$("channels").children.length, 3);
  assert.equal(ui.$("center").value, "352.625000");
  await ui.change("region", "east");
  assert.equal(ui.$("channels").children.length, 22);
  assert.equal(ui.$("center").value, "352.603125");
  assert.equal(ui.$("rate").value, "240000");
  await ui.change("input-kind", "wave");
  ui.input("center", "352.600000");
  await ui.change("region", "west");
  assert.equal(ui.$("center").value, "352.600000");
  assert.equal(ui.$("rate").value, "240000");
  assert.equal(ui.$("rate").disabled, true);
});
test("company changes isolate editable formats and restore the source allocation notes", async (t) => {
  const ui = await setup(t);
  assert.equal(ui.$("region").options.length, 3);
  assert.deepEqual(
    Array.from(ui.$("region").options, (o) => o.textContent),
    ["JR 東日本（22波）", "JR 東海（3波）", "JR 西日本（19波）"],
  );
  assert.match(
    ui.$("selected-label").textContent,
    /変則割当：大船渡線 D7 音声第1波/,
  );
  await ui.change("selected-format", "common");
  await ui.change("region", "west");
  assert.equal(ui.$("selected-format").value, "slotted");
  assert.equal(ui.$("selected-label").textContent, "D2 音声第1波");
  await ui.change("region", "east");
  assert.equal(ui.$("selected-format").value, "slotted");
  assert.match(
    ui.$("selected-label").textContent,
    /変則割当：大船渡線 D7 音声第1波/,
  );
});
test("invalid fields expose an error and regain focus without starting", async (t) => {
  const ui = await setup(t);
  ui.input("port", "0");
  await ui.click("start");
  assert.equal(
    ui.calls.some((c) => c.command === "start"),
    false,
  );
  assert.equal(ui.$("port").getAttribute("aria-invalid"), "true");
  assert.equal(ui.w.document.activeElement.id, "port");
  assert.equal(ui.$("field-error").hidden, false);
  ui.input("port", "1234");
  await ui.click("all");
  await ui.click("start");
  assert.equal(ui.$("channels-panel").open, true);
  assert.equal(ui.w.document.activeElement.id, "all");
  assert.equal(ui.$("all").getAttribute("aria-invalid"), "true");
  await ui.click("all");
  await ui.click("start");
  assert.equal(ui.$("port").hasAttribute("aria-invalid"), false);
  assert.equal(ui.$("error").hidden, true);
});
test("empty search has an exit and channel controls have accessible names", async (t) => {
  const ui = await setup(t);
  ui.input("channel-search", "no such channel");
  assert.equal(ui.$("no-channels").hidden, false);
  await ui.click("clear-search");
  assert.equal(
    ui.$("channels").querySelectorAll("tr:not([hidden])").length,
    22,
  );
  assert.equal(ui.w.document.activeElement.id, "channel-search");
  for (const input of ui.$("channels-simple").querySelectorAll("input"))
    assert.match(input.getAttribute("aria-label"), /MHz を受信/);
  assert.equal(
    ui.$("channels-simple").querySelectorAll('button[aria-pressed="true"]')
      .length,
    1,
  );
});
test("pausing data holds the visible message while reception and counts continue", async (t) => {
  const ui = await setup(t);
  await ui.click("start");
  ui.setSnapshot({ status: status([message("first")]), audio: [] });
  await ui.poll();
  assert.match(ui.$("messages").textContent, /first/);
  await ui.click("pause-messages");
  ui.setSnapshot({ status: status([message("second")]), audio: [] });
  await ui.poll();
  assert.match(ui.$("messages").textContent, /first/);
  assert.doesNotMatch(ui.$("messages").textContent, /second/);
  await ui.click("pause-messages");
  assert.match(ui.$("messages").textContent, /second/);
});
test("a snapshot requested before channel selection cannot overwrite the new detail", async (t) => {
  const ui = await setup(t);
  await ui.click("start");
  let deliver;
  ui.setSnapshot(() => new Promise((resolve) => (deliver = resolve)));
  const pending = ui.poll();
  await tick();
  ui.$("channels-simple").querySelectorAll("button")[1].click();
  deliver({ status: status([message("old-channel")]), audio: [] });
  await pending;
  assert.equal(ui.$("selected-frequency").textContent, "352.54375");
  assert.doesNotMatch(ui.$("messages").textContent, /old-channel/);
});

function operationStatus({ receptions = 1, received = "2025-03-14T00:27:00Z", unknown = false } = {}) {
  const s = status();
  const common = s.channels.find((c) => c.config.format === "common");
  common.status.operation_monitor = {
    last_received_at: received, receptions,
    summary: {
      rows: [{ line: "試験Ａ", delayed: 3, on_line: unknown ? null : 40,
        delay_classes: [2, 1, 0], max_delay_min: 7, train_no: unknown ? null : "12C" }],
    },
  };
  return s;
}
test("operation monitor updates independently of manual audio selection and log pause", async (t) => {
  const app = await setup(t);
  await app.click("start");
  const selected = app.$("selected-frequency").textContent;
  app.$("auto-select").checked = false;
  await app.click("pause-messages");
  app.setSnapshot({ status: operationStatus(), audio: [] });
  await app.poll();
  assert.equal(app.$("operation-content").hidden, false);
  assert.match(app.$("operation-rows").textContent, /試験Ａ/);
  assert.match(app.$("operation-rows").textContent, /3 \/ 40/);
  assert.equal(app.$("operation-message-time"), null);
  assert.match(app.$("operation-received-time").textContent, /2025\/03\/14 09:27:00/);
  assert.equal(app.$("selected-frequency").textContent, selected);
  assert.equal(app.$("auto-select").checked, false);
  assert.equal(app.$("pause-messages").getAttribute("aria-pressed"), "true");
  assert.equal(app.$("operation-state").textContent, "受信済み");
  const row = app.$("operation-rows").firstElementChild;
  app.setSnapshot({ status: operationStatus({ receptions: 2, received: "2025-03-14T00:32:00Z" }), audio: [] });
  await app.poll();
  assert.equal(app.$("operation-rows").firstElementChild, row);
  assert.match(app.$("operation-repetitions").textContent, /2 回/);
  assert.match(app.$("operation-received-time").textContent, /09:32:00/);
  assert.equal(app.$("operation-state").textContent, "受信済み");
  // Reveal the controls without disturbing the paused log or audio selection.
  app.$("message-channel").click();
  assert.equal(app.$("channels-panel").open, true);
  assert.equal(app.w.document.activeElement, app.$("channels-title"));
  assert.equal(app.$("monitor-panel").open, true);
  await app.click("channels-title");
  await app.click("monitor-title");
  assert.equal(app.$("channels-panel").open, false);
  assert.equal(app.$("monitor-panel").open, false);
  assert.equal(app.$("auto-select").checked, false);
  assert.equal(app.$("selected-frequency").textContent, selected);
  assert.equal(app.$("pause-messages").getAttribute("aria-pressed"), "true");
  assert.equal(app.$("operation-rows").firstElementChild, row);
});
test("operation monitor distinguishes missing values and resets on a new receive session or profile", async (t) => {
  const app = await setup(t);
  await app.click("start");
  app.setSnapshot({ status: operationStatus({ unknown: true }), audio: [] });
  await app.poll();
  assert.equal(app.$("operation-state").textContent, "受信済み");
  assert.match(app.$("operation-rows").textContent, /3 \/ 不明/);
  const cells = app.$("operation-rows").querySelectorAll(".operation-value");
  assert.equal(cells[3].textContent, "0");
  assert.equal(cells[5].textContent, "不明");
  await app.click("stop");
  assert.match(app.$("operation-state").textContent, /受信停止/);
  await app.click("start");
  assert.equal(app.$("operation-content").hidden, true);
  assert.equal(app.$("operation-rows").children.length, 0);
  app.setSnapshot({ status: operationStatus(), audio: [] });
  await app.poll();
  await app.click("stop");
  await app.change("region", "central");
  assert.equal(app.$("operation-content").hidden, true);
  assert.match(app.$("operation-empty-title").textContent, /共用波が受信対象にありません/);
});
test("operation monitor selects by reception time and ignores legacy message dates", async (t) => {
  const app = await setup(t);
  await app.click("start");
  const s = operationStatus();
  const first = s.channels.find((c) => c.status.operation_monitor);
  first.status.operation_monitor.message_time = "2099-12-31T23:59:59";
  const second = structuredClone(first);
  second.config.id = "second-common";
  second.config.label = "試験共用波Ｂ";
  second.status.operation_monitor.message_time = "2000-01-01T00:00:00";
  second.status.operation_monitor.last_received_at = "2025-03-14T00:28:00Z";
  second.status.operation_monitor.summary.rows[0].line = "試験Ｂ";
  s.channels.push(second);
  app.setSnapshot({ status: s, audio: [] });
  await app.poll();
  assert.match(app.$("operation-source").textContent, /試験共用波Ｂ/);
  assert.match(app.$("operation-rows").textContent, /試験Ｂ/);
  assert.match(app.$("operation-received-time").textContent, /09:28:00/);
  assert.equal(app.$("operation-state").textContent, "受信済み");
  assert.equal(app.$("operation-message-time"), null);
  assert.doesNotMatch(app.$("operation-content").textContent, /2099|2000|電文日時/);
  const row = app.$("operation-rows").firstElementChild;
  second.status.operation_monitor.message_time = "invalid legacy date";
  await app.poll();
  assert.equal(app.$("operation-rows").firstElementChild, row);
  assert.equal(app.$("operation-state").textContent, "受信済み");
  const view = new OperationMonitorView(app.w.document);
  view.update(s, { channels: s.channels.map((c) => c.config), enabled: new Set(), running: true, replay: true });
  assert.equal(app.$("operation-received-label").textContent, "最終読取日時（JST）");
  assert.equal(app.$("operation-state").textContent, "IQ再生 · 受信済み");
});
test("sample-rate candidates follow the input kind and explain only a rate that falls short", async (t) => {
  const ui = await setup(t);
  const chips = () => [...ui.$("rate-presets").querySelectorAll("button")];
  assert.deepEqual(
    chips().map((b) => Number(b.value)),
    [240000, 288000, 1024000, 2048000, 2400000],
  );
  assert.equal(ui.$("rate-hint").hidden, true);
  assert.equal(ui.$("rate").getAttribute("aria-describedby"), "rate-hint");
  chips()[2].click();
  await tick();
  assert.equal(ui.$("rate").value, "1024000");
  assert.deepEqual(
    chips().map((b) => b.getAttribute("aria-pressed")),
    ["false", "false", "true", "false", "false"],
  );
  assert.equal(chips()[2].getAttribute("aria-label").startsWith("1.024M"), true);
  ui.input("rate", "500000");
  assert.match(ui.$("rate-hint").textContent, /RTL-TCP の対応範囲外/);
  ui.input("rate", "240000");
  ui.input("center", "352.70");
  assert.match(ui.$("rate-hint").textContent, /帯域が足りません.*を超えるレートが必要/);
  assert.equal(ui.$("rate-hint").hidden, false);
  await ui.change("input-kind", "sdr");
  assert.deepEqual(
    chips().map((b) => Number(b.value)),
    [240000, 250000, 1000000, 2048000],
  );
  await ui.change("input-kind", "wave");
  assert.equal(ui.$("rate-presets").hidden, true);
  assert.equal(ui.$("rate-hint").hidden, true);
});
test("an invalid rate keeps its hint while pointing at the error", async (t) => {
  const ui = await setup(t);
  ui.input("rate", "500000");
  await ui.click("start");
  assert.equal(ui.$("rate").getAttribute("aria-invalid"), "true");
  assert.equal(
    ui.$("rate").getAttribute("aria-describedby"),
    "field-error rate-hint",
  );
  ui.input("rate", "240000");
  await ui.click("start");
  assert.equal(ui.$("rate").getAttribute("aria-describedby"), "rate-hint");
});
test("session bar mirrors the selected channel, its sync state and locked count", async (t) => {
  const ui = await setup(t);
  const first = presets[0];
  assert.equal(
    ui.$("bar-frequency").textContent,
    (first.frequency_hz / 1e6).toFixed(5),
  );
  assert.equal(ui.$("bar-channel-label").textContent, first.label);
  assert.equal(ui.$("bar-enabled").textContent, String(presets.length));
  assert.equal(ui.$("bar-locked").textContent, "—");
  await ui.click("start");
  await ui.poll();
  assert.equal(ui.$("bar-locked").textContent, "3");
  assert.equal(ui.$("bar-sync").textContent, "同期中");
  assert.equal(ui.$("bar-sync").className, "locked");
  ui.$("channels-simple").children[5].querySelector(".channel-select").click();
  assert.equal(
    ui.$("bar-frequency").textContent,
    (presets[5].frequency_hz / 1e6).toFixed(5),
  );
  await ui.poll();
  assert.equal(ui.$("bar-sync").textContent, "探索中");
  ui.$("bar-channel").click();
  assert.equal(ui.$("monitor-panel").open, true);
  assert.equal(ui.$("bar-recording").textContent, "未保存");
  await ui.click("record-start");
  ui.setRecording({ state: "recording", files: 0, pcm_samples: 0, error: null });
  await ui.poll();
  assert.equal(ui.$("bar-recording").textContent, "保存中");
  assert.equal(ui.$("bar-recording").getAttribute("href"), "#recording-title");
});
test("live monitoring precedes secondary sections in document order", async (t) => {
  const ui = await setup(t);
  const order = ["session-bar", "source-panel", "channels-panel", "monitor-panel", "operation-title", "messages-title", "recording-title"];
  const nodes = order.map((id) => ui.$(id));
  for (let i = 1; i < nodes.length; i++)
    assert.equal(
      nodes[i - 1].compareDocumentPosition(nodes[i]) & ui.w.Node.DOCUMENT_POSITION_FOLLOWING,
      ui.w.Node.DOCUMENT_POSITION_FOLLOWING,
      `${order[i - 1]} should precede ${order[i]}`,
    );
  assert.equal(ui.$("source-panel").contains(ui.$("region")), true);
  // Listening mode controls stay reachable; manual pinning is explained in the monitor.
  for (const id of ["listen", "auto-select"])
    assert.equal(ui.$("session-bar").contains(ui.$(id)), true);
  assert.equal(ui.$("monitor-panel").contains(ui.$("selection-hint")), true);
  ui.$("channels-simple").children[2].querySelector(".channel-select").click();
  assert.equal(ui.$("auto-select").checked, false);
  assert.match(ui.$("selection-hint").textContent, /手動選択で固定中/);
  assert.equal(ui.$("selection-hint").hidden, false);
});
test("errors reach a live region that is present before the message appears", async (t) => {
  const ui = await setup(t, { catalogError: "設定の検証に失敗しました" });
  assert.equal(ui.$("alert-announcer").getAttribute("role"), "alert");
  assert.equal(ui.$("alert-announcer").hidden, false);
  assert.match(ui.$("alert-announcer").textContent, /設定の検証に失敗しました/);
  assert.equal(ui.$("error").hasAttribute("role"), false);
});
test("route dialog errors are announced inside the modal", async (t) => {
  const ui = await setup(t);
  await ui.click("route-open");
  await ui.click("route-apply");
  assert.equal(ui.$("route-dialog").contains(ui.$("route-announcer")), true);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.match(ui.$("route-announcer").textContent, /1つ以上選択/);
});
