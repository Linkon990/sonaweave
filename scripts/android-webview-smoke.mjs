import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const appId = "com.sonaweave.app";
const sdkRoot = process.env.ANDROID_SDK_ROOT ?? process.env.ANDROID_HOME;
const serialArgs = process.env.ANDROID_SERIAL ? ["-s", process.env.ANDROID_SERIAL] : [];
const outputDir = process.env.SONAWEAVE_SMOKE_OUTPUT_DIR;
const devtoolsPort = Number(process.env.SONAWEAVE_DEVTOOLS_PORT ?? 9333);
if (!sdkRoot) throw new Error("ANDROID_HOME or ANDROID_SDK_ROOT must point to the Android SDK.");
if (outputDir) mkdirSync(outputDir, { recursive: true });
const adbPath = path.join(sdkRoot, "platform-tools", process.platform === "win32" ? "adb.exe" : "adb");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function adb(...args) {
  return execFileSync(adbPath, [...serialArgs, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function screenshot(name) {
  if (outputDir) writeFileSync(path.join(outputDir, `${name}.png`), execFileSync(adbPath, [...serialArgs, "exec-out", "screencap", "-p"]));
}
async function waitUntil(read, matches, label, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  let state;
  while (Date.now() < deadline) {
    state = await read();
    if (matches(state)) return state;
    await delay(150);
  }
  throw new Error(`${label}: ${JSON.stringify(state)}`);
}
async function openApp(legacy = false) {
  adb("shell", "am", "force-stop", appId);
  adb("shell", "am", "start", "-W", "-n", `${appId}/.MainActivity`);
  const pid = adb("shell", "pidof", appId).split(/\s+/)[0];
  if (!pid) throw new Error("SonaWeave is not running.");
  adb("forward", `tcp:${devtoolsPort}`, `localabstract:webview_devtools_remote_${pid}`);
  const target = await waitUntil(async () => {
    try {
      const targets = await fetch(`http://127.0.0.1:${devtoolsPort}/json`).then((r) => r.json());
      return targets.find((item) => item.type === "page" && item.url === "https://localhost/");
    } catch { return null; }
  }, (value) => value?.webSocketDebuggerUrl, "No WebView DevTools target");
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  let sequence = 0;
  const pending = new Map();
  const exceptions = [];
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.method === "Runtime.exceptionThrown") exceptions.push(message.params.exceptionDetails);
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timeout);
    if (message.error) request.reject(new Error(JSON.stringify(message.error)));
    else request.resolve(message.result);
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`DevTools timeout: ${method}`)); }, 20_000);
    pending.set(id, { resolve, reject, timeout });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const result = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  await call("Runtime.enable");
  await waitUntil(() => evaluate('Boolean(document.querySelector("[data-testid=build-signal]"))'), Boolean, "App UI did not load");
  await waitUntil(() => evaluate('Boolean(document.querySelector("[data-testid=mode-fsk]"))'), Boolean, "FSK/DTMF must be the default main page");
  if (!legacy) {
    await clickTestId(evaluate, "page-ggwave");
    await waitUntil(() => evaluate('Boolean(document.querySelector("[data-testid=speed-fast]"))'), Boolean, "ggwave secondary page did not load");
  }
  return { socket, evaluate, exceptions, call };
}
async function clickTestId(evaluate, testId) {
  await evaluate(`(() => {
    const button = document.querySelector('[data-testid=' + ${JSON.stringify(testId)} + ']');
    if (!button || button.disabled || !button.getClientRects().length) throw new Error("Visible enabled control not found: " + ${JSON.stringify(testId)});
    button.scrollIntoView({ block: "center" }); button.click();
  })()`);
}
async function switchPage(evaluate, pageName) {
  await clickTestId(evaluate, `page-${pageName}`);
  const marker = pageName === "main" ? "mode-fsk" : "speed-fast";
  await waitUntil(() => evaluate(`Boolean(document.querySelector('[data-testid=' + ${JSON.stringify(marker)} + ']'))`), Boolean, "Selected page did not finish loading");
}
async function openRecordingEvidence(evaluate) {
  await clickButton(evaluate, "本次录音 · 回听与导出");
  await waitUntil(() => evaluate('Boolean(document.querySelector("dialog[open] audio")?.src)'), Boolean, "Recording evidence dialog did not open");
}
async function closeDialog(evaluate) {
  await evaluate('document.querySelector("dialog[open] button[aria-label=关闭]").click()');
  await waitUntil(() => evaluate('Boolean(document.querySelector("dialog[open]"))'), value => !value, "Dialog did not close");
}
async function clickButton(evaluate, label) {
  await evaluate(`(() => {
    const button = [...document.querySelectorAll("button")].find((item) =>
      item.textContent.trim() === ${JSON.stringify(label)} && item.getClientRects().length > 0);
    if (!button || button.disabled) throw new Error("Visible enabled button not found: " + ${JSON.stringify(label)});
    button.scrollIntoView({ block: "center" }); button.click();
  })()`);
}
async function captureState(evaluate) {
  return evaluate(`(() => {
    const meter = document.querySelector("[data-testid=recording-meter] meter");
    return {
      buttonText: document.querySelector("[data-testid=record-button]")?.textContent.trim(),
      buttonDisabled: document.querySelector("[data-testid=record-button]")?.disabled,
      statusText: document.querySelector(".decode-status-row strong")?.textContent.trim(),
      meterVisible: Boolean(meter?.getClientRects().length), meterValue: meter?.value,
      elapsedText: document.querySelector(".meter-heading > span")?.textContent.trim(),
      pageText: document.body.innerText.slice(-1500),
    };
  })()`);
}
async function startCapture(evaluate, legacy = true) {
  await clickButton(evaluate, "接收");
  await clickTestId(evaluate, "record-button");
  return waitUntil(() => captureState(evaluate), (s) => s.buttonText === "停止并分析" &&
    s.statusText === (legacy ? "正在监听声波" : "麦克风已就绪，现在可以播放") && s.meterVisible && /\/ 120 秒/.test(s.elapsedText), "First PCM / meter did not arrive");
}
async function stopCapture(evaluate, legacy = true) {
  await clickTestId(evaluate, "record-button");
  return waitUntil(() => captureState(evaluate), (s) => s.buttonText === "开始接收" && !s.buttonDisabled && !s.meterVisible,
    "PCM capture / decoding did not stop", 50_000);
}
async function expectDecoded(evaluate, expected, legacy = true) {
  return waitUntil(() => evaluate(`({
    crc: document.querySelector("[data-testid=crc-status]")?.textContent.trim(),
    verification: document.querySelector("[data-testid=verification-status]")?.textContent.trim(),
    restored: Boolean(document.querySelector(".decoded-output.success")),
    text: document.querySelector("[data-testid=decoded-text]")?.textContent.trim(),
  })`), (s) => (legacy ? s.crc === "PASS" : s.verification === "Reed-Solomon") && s.restored && s.text === expected,
    "Exact text / integrity decode did not pass", 50_000);
}
async function buildSignal(evaluate, mode, message) {
  await clickButton(evaluate, "发送");
  await clickButton(evaluate, mode);
  await evaluate(`(() => {
    const input = document.querySelector("[data-testid=message-input]");
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(input, ${JSON.stringify(message)});
    input.dispatchEvent(new Event("input", { bubbles: true }));
  })()`);
  await clickTestId(evaluate, "build-signal");
  await waitUntil(() => evaluate('Boolean(document.querySelector("audio")?.src) && !document.querySelector("[data-testid=loopback-button]").disabled'), Boolean, "Signal was not generated");
  // Use visible mobile navigation, never click controls inside hidden panels.
  await clickButton(evaluate, "载波");
}

async function runMicrophoneCapture() {
  const { socket, evaluate, exceptions } = await openApp(true);
  try {
    const startedAt = Date.now();
    await startCapture(evaluate);
    const startupMs = Date.now() - startedAt;
    const state = await waitUntil(() => captureState(evaluate), (s) => parseInt(s.elapsedText) >= 1, "Real microphone PCM timer did not advance");
    const captureLayout = await receivePanelLayout(evaluate);
    screenshot("android-real-microphone-ready");
    const stopped = await stopCapture(evaluate);
    assert.ok(!/Permission denied/.test(stopped.pageText));
    assert.equal(exceptions.length, 0, JSON.stringify(exceptions));
    return { androidPermissionGranted: true, webViewCaptureStarted: true, firstPcmStartupMs: startupMs,
      inputMeterVisible: state.meterVisible, elapsedText: state.elapsedText, pcmCaptureStopped: true, captureLayout };
  } finally { socket.close(); }
}
async function buildGgSignal(evaluate, speed, message) {
  await clickButton(evaluate, "发送");
  await clickTestId(evaluate, `speed-${speed}`);
  await evaluate(`(() => {
    const input = document.querySelector("[data-testid=message-input]");
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(input, ${JSON.stringify(message)});
    input.dispatchEvent(new Event("input", { bubbles: true }));
  })()`);
  await clickTestId(evaluate, "build-signal");
  await waitUntil(() => evaluate('Boolean(document.querySelector("audio")?.src) && !document.querySelector("[data-testid=loopback-button]").disabled'), Boolean, "ggwave signal was not generated", 30_000);
  await clickButton(evaluate, "载波");
}
async function runGgMicrophoneCapture() {
  const { socket, evaluate, exceptions } = await openApp();
  try {
    const startedAt = Date.now();
    await startCapture(evaluate, false);
    const startupMs = Date.now() - startedAt;
    const state = await waitUntil(() => captureState(evaluate), (s) => parseInt(s.elapsedText) >= 1, "ggwave microphone PCM timer did not advance");
    const captureLayout = await receivePanelLayout(evaluate);
    screenshot("android-ggwave-real-microphone-ready");
    await stopCapture(evaluate, false);
    const retainedLayout = await receivePanelLayout(evaluate);
    await openRecordingEvidence(evaluate);
    const evidence = await evaluate(`({ wav: Boolean(document.querySelector("[data-testid=export-recording]")), diagnostic: Boolean(document.querySelector("[data-testid=export-diagnostic]")), player: Boolean(document.querySelector('audio[aria-label="回听本次录音"]')?.src) })`);
    assert.ok(evidence.wav && evidence.diagnostic && evidence.player, JSON.stringify(evidence));
    assert.equal(exceptions.length, 0, JSON.stringify(exceptions));
    return { firstPcmAndDecoderStartupMs: startupMs, inputMeterVisible: state.meterVisible, elapsedText: state.elapsedText,
      captureStopped: true, recordingRetained: evidence, captureLayout, retainedLayout, method: "Real emulator microphone startup/stop only; no physical air decode assertion" };
  } finally { socket.close(); }
}
async function runGgMode(speed) {
  const { socket, evaluate, exceptions } = await openApp();
  const message = `Android ggwave ${speed} 声织`;
  try {
    await buildGgSignal(evaluate, speed, message);
    const startedAt = Date.now();
    await clickTestId(evaluate, "loopback-button");
    const result = await expectDecoded(evaluate, message, false);
    screenshot(`android-ggwave-loopback-${speed}`);
    assert.equal(exceptions.length, 0, JSON.stringify(exceptions));
    return { speed, elapsedMs: Date.now() - startedAt, verification: result.verification, decodedText: result.text };
  } finally { socket.close(); }
}
async function runGgInjectedPcm(speed, sampleRate) {
  const { socket, evaluate, exceptions } = await openApp();
  const message = `PCM ${speed} ${sampleRate} 接收`;
  try {
    await buildGgSignal(evaluate, speed, message);
    await evaluate(`(async () => {
      const context = new AudioContext({ sampleRate: ${sampleRate} }); await context.resume();
      const original = await context.decodeAudioData(await fetch(document.querySelector("audio").src).then(r => r.arrayBuffer()));
      // Let live reception finish while the fixture keeps feeding silent PCM;
      // no manual stop or offline decode is allowed to produce the text.
      const buffer = context.createBuffer(1, original.length + Math.round(context.sampleRate), context.sampleRate);
      buffer.copyToChannel(original.getChannelData(0), 0);
      const destination = context.createMediaStreamDestination();
      const source = context.createBufferSource(); source.buffer = buffer; source.connect(destination);
      const originals = { getUserMedia: navigator.mediaDevices.getUserMedia, AudioWorkletNode, Worker };
      const test = window.__sonaweaveSmoke = { context, source, destination, originals, worklets: [], workers: [], sourceEnded: false };
      source.onended = () => { test.sourceEnded = true; };
      navigator.mediaDevices.getUserMedia = async () => destination.stream;
      window.AudioWorkletNode = new Proxy(originals.AudioWorkletNode, { construct(target, args) { test.worklets.push(args[1]); return Reflect.construct(target, args); }});
      window.Worker = new Proxy(originals.Worker, { construct(target, args) { test.workers.push(String(args[0])); return Reflect.construct(target, args); }});
    })()`);
    await startCapture(evaluate, false);
    const startedAt = Date.now();
    await evaluate("window.__sonaweaveSmoke.source.start(window.__sonaweaveSmoke.context.currentTime + 0.2)");
    const decoded = await expectDecoded(evaluate, message, false);
    const completed = await waitUntil(() => captureState(evaluate), s => s.buttonText === "开始接收" && !s.buttonDisabled && !s.meterVisible, "ggwave did not automatically release capture");
    const retainedLayout = await receivePanelLayout(evaluate);
    await openRecordingEvidence(evaluate);
    const instrumentation = await evaluate(`({
      worklets: window.__sonaweaveSmoke.worklets, workers: window.__sonaweaveSmoke.workers,
      tracksStopped: window.__sonaweaveSmoke.destination.stream.getTracks().every(track => track.readyState === "ended"),
      recordingRetained: Boolean(document.querySelector("[data-testid=export-recording]")),
      sourceEnded: window.__sonaweaveSmoke.sourceEnded,
    })`);
    assert.ok(instrumentation.worklets.includes("sonaweave-pcm"), "Production AudioWorklet was not used");
    assert.ok(instrumentation.workers.some(url => url.startsWith("https://localhost/") && url.includes("acoustic.worker")), "Packaged live decoder worker was not used");
    assert.ok(instrumentation.tracksStopped && instrumentation.recordingRetained, JSON.stringify(instrumentation));
    const recordedWavBytes = await evaluate(`(async () => {
      const player = document.querySelector('audio[aria-label="回听本次录音"]');
      const blob = await fetch(player.src).then(response => response.blob());
      window.__sonaweaveSmoke.recordedWavFile = new File([blob], ${JSON.stringify(`${speed}-${sampleRate}-recording.wav`)}, { type: "audio/wav" });
      return blob.size;
    })()`);
    await closeDialog(evaluate);
    await evaluate(`(() => {
      const files = new DataTransfer(); files.items.add(window.__sonaweaveSmoke.recordedWavFile);
      const input = document.querySelector("[data-testid=audio-file]"); input.files = files.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    })()`);
    assert.ok(recordedWavBytes > 20_000, "Retained WAV was unexpectedly short");
    await waitUntil(() => evaluate('document.querySelector("[data-testid=receive-status]")?.textContent.includes("音频文件")'), Boolean, "Recorded WAV was not reimported");
    await expectDecoded(evaluate, message, false);
    assert.equal(exceptions.length, 0, JSON.stringify(exceptions));
    screenshot(`android-ggwave-pcm-${speed}-${sampleRate}`);
    return { speed, sampleRate, elapsedMs: Date.now() - startedAt, decodedText: decoded.text, verification: decoded.verification,
      automaticallyStopped: completed.buttonText === "开始接收", ...instrumentation, recordedWavBytes, recordedWavReimported: true, retainedLayout,
      method: "Generated WAV → test MediaStream → production AudioWorklet → packaged live ggwave worker, automatic result/stop without manual analysis; not physical air transmission" };
  } finally {
    await evaluate(`(async () => { const test = window.__sonaweaveSmoke; if (!test) return;
      navigator.mediaDevices.getUserMedia = test.originals.getUserMedia; window.AudioWorkletNode = test.originals.AudioWorkletNode; window.Worker = test.originals.Worker;
      try { test.source.stop(); } catch {} test.destination.stream.getTracks().forEach(track => track.stop()); await test.context.close(); delete window.__sonaweaveSmoke;
    })()`).catch(() => {});
    socket.close();
  }
}
async function runSharedPages() {
  const { socket, evaluate, exceptions } = await openApp(true);
  try {
    const draft = "双页草稿 Draft 123";
    await evaluate(`(() => {
      const input = document.querySelector("[data-testid=message-input]");
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(input, ${JSON.stringify(draft)});
      input.dispatchEvent(new Event("input", { bubbles: true }));
    })()`);
    await clickButton(evaluate, "接收");
    await switchPage(evaluate, "ggwave");
    const secondary = await evaluate(`({ draft: document.querySelector("[data-testid=message-input]").value,
      workspace: document.querySelector(".mobile-tab-bar [aria-current=page]")?.textContent.trim(),
      fastDefault: document.querySelector("[data-testid=speed-fast]").getAttribute("aria-pressed"),
      repeatedOption: Boolean(document.querySelector(".repeat-option")) })`);
    assert.deepEqual(secondary, { draft, workspace: "接收", fastDefault: "true", repeatedOption: false });
    await clickButton(evaluate, "发送");
    const example = await evaluate(`(() => {
      const selector = document.querySelector("[data-testid=quick-examples]");
      selector.selectedIndex = 1; selector.dispatchEvent(new Event("change", { bubbles: true }));
      return selector.value;
    })()`);
    const exampleText = await evaluate('document.querySelector("[data-testid=message-input]").value');
    await switchPage(evaluate, "main");
    assert.deepEqual(await evaluate(`({ example: document.querySelector("[data-testid=quick-examples]").value,
      draft: document.querySelector("[data-testid=message-input]").value,
      workspace: document.querySelector(".mobile-tab-bar [aria-current=page]")?.textContent.trim() })`), { example, draft: exampleText, workspace: "发送" });
    await evaluate(`(() => { const input = document.querySelector("[data-testid=message-input]");
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(input, "声".repeat(60));
      input.dispatchEvent(new Event("input", { bubbles: true })); })()`);
    await switchPage(evaluate, "ggwave");
    assert.deepEqual(await evaluate(`({ draft: document.querySelector("[data-testid=message-input]").value,
      disabled: document.querySelector("[data-testid=build-signal]").disabled })`), { draft: "声".repeat(60), disabled: true });
    await switchPage(evaluate, "main");
    assert.equal(await evaluate('document.querySelector("[data-testid=message-input]").value'), "声".repeat(60));
    assert.equal(exceptions.length, 0, JSON.stringify(exceptions));
    screenshot("android-shared-pages-main");
    return { mainDefault: true, sharedDraft: true, sharedExample: true, sharedWorkspace: true, longDraftPreserved: true, oversizedGgWaveDisabled: true, defaultGgWaveSpeed: "fast", singlePlayback: true };
  } finally { socket.close(); }
}
async function runGgWorkerFailure() {
  const { socket, evaluate, exceptions } = await openApp();
  try {
    await evaluate(`(() => {
      const test = window.__sonaweaveFailure = { Worker, getUserMedia: navigator.mediaDevices.getUserMedia, workers: [], streams: [] };
      window.Worker = new Proxy(test.Worker, { construct(target, args) { const worker = Reflect.construct(target, args); test.workers.push(worker); return worker; }});
      navigator.mediaDevices.getUserMedia = async (...args) => { const stream = await test.getUserMedia.apply(navigator.mediaDevices, args); test.streams.push(stream); return stream; };
    })()`);
    await startCapture(evaluate, false);
    await waitUntil(() => captureState(evaluate), s => parseInt(s.elapsedText) >= 1, "Microphone did not collect PCM before injected worker failure");
    await evaluate('window.__sonaweaveFailure.workers[0].dispatchEvent(new ErrorEvent("error", { message: "Synthetic Android smoke worker failure" }))');
    await waitUntil(() => captureState(evaluate), s => s.buttonText === "开始接收" && !s.buttonDisabled && !s.meterVisible && s.statusText === "未能完成接收", "Worker failure did not stop the healthy recorder");
    await openRecordingEvidence(evaluate);
    const evidence = await evaluate(`(async () => {
      const audio = document.querySelector('audio[aria-label="回听本次录音"]');
      const blob = audio?.src ? await fetch(audio.src).then(response => response.blob()) : null;
      return { wavBytes: blob?.size ?? 0, wavExportEnabled: document.querySelector("[data-testid=export-recording]")?.disabled === false,
        diagnosticExportEnabled: document.querySelector("[data-testid=export-diagnostic]")?.disabled === false,
        tracksStopped: window.__sonaweaveFailure.streams.flatMap(stream => stream.getTracks()).every(track => track.readyState === "ended"),
        error: document.querySelector("[data-testid=decoded-text]")?.textContent.trim() };
    })()`);
    assert.ok(evidence.wavBytes > 8_000 && evidence.wavExportEnabled && evidence.diagnosticExportEnabled && evidence.tracksStopped, JSON.stringify(evidence));
    assert.equal(exceptions.length, 0, JSON.stringify(exceptions));
    screenshot("android-ggwave-worker-failure-retains-recording");
    return { ...evidence, method: "Inject a Worker error event after real emulator microphone PCM arrives; verify stop/flush preserves a playable WAV and diagnostic export controls" };
  } finally {
    await evaluate(`(() => { const test = window.__sonaweaveFailure; if (!test) return; window.Worker = test.Worker; navigator.mediaDevices.getUserMedia = test.getUserMedia; delete window.__sonaweaveFailure; })()`).catch(() => {});
    socket.close();
  }
}
async function runMode(mode) {
  const { socket, evaluate, exceptions } = await openApp(true);
  const message = `Android ${mode} 声织`;
  try {
    await buildSignal(evaluate, mode, message);
    const startedAt = Date.now();
    await clickTestId(evaluate, "loopback-button");
    const result = await expectDecoded(evaluate, message);
    screenshot(`android-loopback-${mode.toLowerCase()}`);
    assert.equal(exceptions.length, 0, JSON.stringify(exceptions));
    return { mode, elapsedMs: Date.now() - startedAt, crcPass: true, restored: true, decodedText: result.text };
  } finally { socket.close(); }
}
async function runInjectedPcm(mode) {
  console.error(`PCM injection ${mode}: starting`);
  const { socket, evaluate, exceptions } = await openApp(true);
  const message = `PCM ${mode} 离线`;
  try {
    await buildSignal(evaluate, mode, message);
    console.error(`PCM injection ${mode}: configuring source`);
    await evaluate(`(async () => {
      const encoded = await fetch(document.querySelector("audio").src).then((r) => r.arrayBuffer());
      const originals = { getUserMedia: navigator.mediaDevices.getUserMedia, AudioContext, AudioWorkletNode, Worker };
      const test = window.__sonaweaveSmoke = { context: null, source: null, destination: null, originals, encoded, worklets: [], workers: [] };
      window.AudioContext = new Proxy(originals.AudioContext, { construct(target, args) {
        const context = Reflect.construct(target, args); test.context = context; return context;
      }});
      navigator.mediaDevices.getUserMedia = async () => {
        // The actual recorder creates its context before requesting the input.
        // Share its clock so a second graph's jitter buffer cannot alter the
        // virtual signal. Production MediaStream/Worklet/Worker stay intact.
        const context = test.context; await context.resume();
        const original = await context.decodeAudioData(encoded.slice(0));
        const buffer = context.createBuffer(1, original.length + Math.ceil(context.sampleRate * 0.3), context.sampleRate);
        buffer.copyToChannel(original.getChannelData(0), 0);
        const destination = context.createMediaStreamDestination();
        const source = context.createBufferSource(); source.buffer = buffer; source.connect(destination);
        Object.assign(test, { source, destination }); return destination.stream;
      };
      window.AudioWorkletNode = new Proxy(originals.AudioWorkletNode, { construct(target, args) {
        test.worklets.push(args[1]); return Reflect.construct(target, args);
      }});
      window.Worker = new Proxy(originals.Worker, { construct(target, args) {
        test.workers.push(String(args[0])); const worker = Reflect.construct(target, args);
        if (String(args[0]).includes("decode.worker")) {
          const post = worker.postMessage.bind(worker);
          worker.postMessage = (message, transfer) => {
            if (message.samples instanceof Float32Array) test.decoderInput = { samples: message.samples.slice(), sampleRate: message.sampleRate };
            post(message, transfer);
          };
        }
        return worker;
      }});
    })()`);
    console.error(`PCM injection ${mode}: starting production capture`);
    await startCapture(evaluate);
    await evaluate(`(() => { const test = window.__sonaweaveSmoke; test.ended = false;
      test.source.onended = () => { test.ended = true; }; test.source.start(test.context.currentTime + 0.2); })()`);
    const meter = await waitUntil(() => captureState(evaluate), (s) => s.meterValue > 0.1, "Injected PCM did not reach the meter");
    await waitUntil(() => evaluate("window.__sonaweaveSmoke.ended"), Boolean, "Injected source did not finish", 20_000);
    await delay(250);
    await stopCapture(evaluate);
    console.error(`PCM injection ${mode}: verifying decoded text`);
    const decoded = await expectDecoded(evaluate, message);
    const instrumentation = await evaluate(`({ worklets: window.__sonaweaveSmoke.worklets, workers: window.__sonaweaveSmoke.workers,
      tracksStopped: window.__sonaweaveSmoke.destination.stream.getTracks().every((track) => track.readyState === "ended") })`);
    assert.ok(instrumentation.worklets.includes("sonaweave-pcm"), "Production AudioWorklet was not used");
    assert.ok(instrumentation.workers.some((url) => url.startsWith("https://localhost/") && url.includes("decode.worker")), "Packaged decode worker was not used");
    assert.ok(instrumentation.tracksStopped, "Capture track leaked after stop");
    assert.equal(exceptions.length, 0, JSON.stringify(exceptions));
    screenshot(`android-pcm-injection-${mode.toLowerCase()}`);
    return { mode, exactText: decoded.text, crcPass: true, observedMeter: meter.meterValue, ...instrumentation,
      method: "Generated WAV → virtual MediaStream sharing the production capture clock → production AudioWorklet → production decode worker; not an over-the-air test" };
  } catch (error) {
    try {
      if (await evaluate("Boolean(window.__sonaweaveSmoke?.decoderInput)")) await saveInjectedFixture(evaluate, mode);
    } catch { /* Evidence transport must not replace the original test error. */ }
    throw error;
  } finally {
    await evaluate(`(async () => { const test = window.__sonaweaveSmoke; if (!test) return;
      navigator.mediaDevices.getUserMedia = test.originals.getUserMedia;
      window.AudioContext = test.originals.AudioContext;
      window.AudioWorkletNode = test.originals.AudioWorkletNode; window.Worker = test.originals.Worker;
      test.destination?.stream.getTracks().forEach((track) => track.stop()); await test.context?.close(); delete window.__sonaweaveSmoke;
    })()`).catch(() => {});
    socket.close();
  }
}
async function saveInjectedFixture(evaluate, mode) {
  if (!outputDir) return;
  const audio = await evaluate(`(() => {
    const test = window.__sonaweaveSmoke;
    const base64 = buffer => { const bytes = new Uint8Array(buffer), parts = [];
      for (let offset = 0; offset < bytes.length; offset += 32768) parts.push(String.fromCharCode(...bytes.subarray(offset, offset + 32768)));
      return btoa(parts.join("")); };
    return { sent: base64(test.encoded), samples: base64(test.decoderInput.samples.buffer), sampleRate: test.decoderInput.sampleRate };
  })()`);
  const samples = Buffer.from(audio.samples, "base64");
  const header = Buffer.alloc(44);
  header.write("RIFF", 0); header.writeUInt32LE(36 + samples.byteLength, 4); header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(3, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(audio.sampleRate, 24); header.writeUInt32LE(audio.sampleRate * 4, 28);
  header.writeUInt16LE(4, 32); header.writeUInt16LE(32, 34); header.write("data", 36); header.writeUInt32LE(samples.byteLength, 40);
  writeFileSync(path.join(outputDir, `android-${mode.toLowerCase()}-fixture-sent.wav`), Buffer.from(audio.sent, "base64"));
  writeFileSync(path.join(outputDir, `android-${mode.toLowerCase()}-fixture-captured.wav`), Buffer.concat([header, samples]));
}
async function settledUi(evaluate) {
  return waitUntil(() => evaluate(`({
    navMotion: document.querySelector(".mobile-tab-bar")?.dataset.motion,
    runningFiniteAnimations: document.getAnimations().filter(animation =>
      (animation.playState === "running" || animation.pending) && animation.effect?.getComputedTiming().iterations !== Infinity).length,
  })`), state => state.navMotion === "idle" && state.runningFiniteAnimations === 0, "UI transitions did not settle");
}
async function fixedViewportState(evaluate, keyboard = false, dialogOpen = false) {
  await settledUi(evaluate);
  const state = await evaluate(`(() => {
    window.scrollTo(1000, 1000);
    const bounds = element => { const r = element.getBoundingClientRect(); return { x:r.x, y:r.y, width:r.width, height:r.height, right:r.right, bottom:r.bottom }; };
    const viewport = visualViewport;
    const controls = [...document.querySelectorAll(${JSON.stringify(dialogOpen ? 'dialog[open] button[aria-label="关闭"]' : keyboard ? ".mobile-tab-bar button" : ".page-switch button, .mobile-tab-bar button")})].map(element => {
      const r = bounds(element), hit = document.elementFromPoint(r.x + r.width/2, r.y + r.height/2);
      return { label: element.textContent.trim(), ...r, hit: Boolean(hit && (hit === element || element.contains(hit))),
        inside: r.x >= -1 && r.right <= innerWidth + 1 && r.y >= (viewport?.offsetTop ?? 0) - 1
          && r.bottom <= (viewport?.offsetTop ?? 0) + (viewport?.height ?? innerHeight) + 1 };
    });
    return { width: innerWidth, height: innerHeight, visualHeight: viewport?.height ?? innerHeight,
      scrollX, scrollY,
      roots: [document.documentElement, document.body, document.getElementById("root")].map(element => ({
        tag: element.id || element.tagName, horizontalOverflow: element.scrollWidth - element.clientWidth,
        verticalOverflow: element.scrollHeight - element.clientHeight, top: element.scrollTop })),
      shell: bounds(document.querySelector(".app-shell")), controls,
      background: getComputedStyle(document.querySelector(".app-shell")).backgroundColor,
    };
  })()`);
  assert.equal(state.scrollX, 0, JSON.stringify(state));
  assert.equal(state.scrollY, 0, JSON.stringify(state));
  assert.ok(state.roots.every(root => root.horizontalOverflow <= 1 && root.verticalOverflow <= 1 && root.top === 0), JSON.stringify(state));
  assert.equal(state.controls.length, dialogOpen ? 1 : keyboard ? 4 : 6, JSON.stringify(state));
  assert.ok(state.controls.every(control => control.hit && control.inside), JSON.stringify(state));
  return state;
}
async function currentWorkspaceControls(evaluate, panelId) {
  const controls = await evaluate(`(async () => {
    const panel = document.getElementById(${JSON.stringify(`mobile-panel-${panelId}`)});
    const controls = [...panel.querySelectorAll("button, summary, select")].filter(element => element.getClientRects().length > 0);
    const results = [];
    for (const element of controls) {
      element.scrollIntoView({ block: "nearest" });
      await new Promise(resolve => requestAnimationFrame(resolve));
      const r = element.getBoundingClientRect(), hit = document.elementFromPoint(r.x + r.width/2, r.y + r.height/2);
      results.push({ label: element.textContent.trim().slice(0, 90), reachable: Boolean(hit && (hit === element || element.contains(hit))) });
    }
    return results;
  })()`);
  assert.ok(controls.every(control => control.reachable), JSON.stringify({ panelId, controls }));
  return controls;
}
async function receivePanelLayout(evaluate) {
  const viewport = await fixedViewportState(evaluate);
  const overflow = await evaluate(`(() => { const panel = document.querySelector("#mobile-panel-receive");
    return { x: panel.scrollWidth - panel.clientWidth, y: panel.scrollHeight - panel.clientHeight }; })()`);
  assert.ok(overflow.x <= 1 && (viewport.height < 800 || overflow.y <= 1), JSON.stringify({ viewport, overflow }));
  return { width: viewport.width, height: viewport.height, ...overflow, rootScrollX: viewport.scrollX, rootScrollY: viewport.scrollY };
}
async function runDialogs(legacy = true) {
  const { socket, evaluate, call, exceptions } = await openApp(legacy);
  const dialogs = [];
  try {
    for (const [id, label] of [["encode", "发送"], ["signal", "载波"], ["receive", "接收"], ["inspect", "诊断"]]) {
      await clickButton(evaluate, label);
      await settledUi(evaluate);
      const titles = await evaluate(`[...document.querySelectorAll(${JSON.stringify(`#mobile-panel-${id} button[aria-haspopup=dialog]`)})].map(button => button.textContent.trim())`);
      for (const title of titles) {
        const point = await evaluate(`(() => {
          const button = [...document.querySelectorAll("button[aria-haspopup=dialog]")].find(element => element.textContent.trim() === ${JSON.stringify(title)} && element.getClientRects().length);
          button.scrollIntoView({ block: "center" }); const r = button.getBoundingClientRect(); return { x: r.x + r.width/2, y: r.y + r.height/2 };
        })()`);
        // Native touch supplies the focus behavior that a programmatic .click()
        // lacks, so close-to-trigger restoration is measured as the user sees it.
        await call("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ ...point, id: 1 }] });
        await call("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        await waitUntil(() => evaluate('document.querySelector("dialog[open] h2")?.textContent.trim()'), value => value === title, "Dialog title did not match its trigger");
        await fixedViewportState(evaluate, false, true);
        const detail = await evaluate(`(async () => {
          const dialog = document.querySelector("dialog[open]"), content = dialog.querySelector(".detail-content");
          const last = [...content.querySelectorAll("p, code, label, button, small")].at(-1);
          if (last) { last.scrollIntoView({ block: "end" }); await new Promise(resolve => requestAnimationFrame(resolve)); }
          const r = last?.getBoundingClientRect(), point = r ? document.elementFromPoint(r.x + r.width/2, Math.min(r.bottom - 1, r.y + r.height/2)) : null;
          return { title: dialog.querySelector("h2").textContent.trim(), contentScroll: content.scrollTop,
            endReachable: !last || Boolean(point && (point === last || last.contains(point))),
            labelled: dialog.getAttribute("aria-labelledby") === dialog.querySelector("h2").id };
        })()`);
        assert.ok(detail.endReachable && detail.labelled, JSON.stringify(detail));
        let nativeBodyBoundaryWraps = 0;
        for (let step = 0; step < 5; step++) {
          await call("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 });
          await call("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 });
          const focus = await evaluate(`(() => { const dialog = document.querySelector("dialog[open]");
            return { inside: dialog.contains(document.activeElement), body: document.activeElement === document.body, modal: dialog.matches(":modal") }; })()`);
          if (!focus.inside && focus.body && focus.modal) {
            // Android WebView exposes BODY at its native focus-cycle boundary.
            // The background must stay inert and the next Tab must wrap back.
            assert.equal(await evaluate(`(() => { const button = document.querySelector("[data-testid=page-main]"); button.focus(); return document.activeElement === button; })()`), false, "Modal background accepted focus");
            await call("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 });
            await call("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 });
            nativeBodyBoundaryWraps++;
          }
          assert.equal(await evaluate('document.querySelector("dialog[open]").contains(document.activeElement)'), true, "Tab focus escaped the active dialog");
        }
        screenshot(`android-${legacy ? "main" : "ggwave"}-${id}-dialog-${dialogs.length}`);
        await closeDialog(evaluate);
        assert.equal(await evaluate('document.activeElement?.textContent.trim()'), title, "Closing the dialog did not restore focus to its trigger");
        await fixedViewportState(evaluate);
        dialogs.push({ id, ...detail, focusContained: true, nativeBodyBoundaryWraps, focusRestored: true });
      }
    }
    assert.equal(dialogs.length, 4, JSON.stringify(dialogs));
    assert.equal(exceptions.length, 0, JSON.stringify(exceptions));
    return dialogs;
  } finally { socket.close(); }
}
async function runKeyboard(legacy = true) {
  const previousIme = adb("shell", "settings", "get", "secure", "show_ime_with_hard_keyboard");
  const { socket, evaluate, call, exceptions } = await openApp(legacy);
  try {
    adb("shell", "settings", "put", "secure", "show_ime_with_hard_keyboard", "1");
    await clickButton(evaluate, "发送");
    const before = await fixedViewportState(evaluate);
    const point = await evaluate(`(() => {
      const input = document.querySelector("[data-testid=message-input]");
      input.scrollIntoView({ block: "center" });
      const r = input.getBoundingClientRect(); return { x: r.x + r.width/2, y: r.y + Math.min(30, r.height/2) };
    })()`);
    // A real WebView touch requests the Android IME; no visualViewport stub or
    // CSS-only keyboard simulation is used in the native acceptance test.
    await call("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ ...point, id: 1 }] });
    await call("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    const keyboard = await waitUntil(async () => ({
      viewport: await evaluate("({ inner: innerHeight, visual: visualViewport.height, inputFocused: document.activeElement?.matches('[data-testid=message-input]') })"),
      shown: /mInputShown=true|mIsInputViewShown=true|isInputViewShown=true|inputShown=true/.test(adb("shell", "dumpsys", "input_method")),
    }), state => state.shown && state.viewport.inputFocused && state.viewport.visual < before.visualHeight - 120, "Real Android keyboard did not open and reduce the visible viewport");
    adb("shell", "input", "text", "IMEprobe");
    await waitUntil(() => evaluate('document.querySelector("[data-testid=message-input]").value'), value => value.includes("IMEprobe"), "Native keyboard input did not update the text draft");
    const during = await fixedViewportState(evaluate, true);
    const controls = await currentWorkspaceControls(evaluate, "encode");
    screenshot(`android-${legacy ? "main" : "ggwave"}-real-keyboard`);
    adb("shell", "input", "keyevent", "KEYCODE_BACK");
    await waitUntil(() => evaluate(`({ visual: visualViewport.height,
      app: document.querySelector(".app-shell").getBoundingClientRect().height,
      keyboard: document.documentElement.dataset.keyboard })`),
      state => Math.abs(state.visual - before.visualHeight) <= 1 && Math.abs(state.app - before.visualHeight) <= 1 && state.keyboard === "false",
      "App viewport did not recover after the real keyboard resize event");
    const after = await fixedViewportState(evaluate);
    assert.equal(exceptions.length, 0, JSON.stringify(exceptions));
    return { nativeIme: true, beforeHeight: before.visualHeight, keyboardHeight: keyboard.viewport.visual, recoveredHeight: after.visualHeight,
      nativeTextEntry: true, controls, during, after };
  } finally {
    if (/mInputShown=true|mIsInputViewShown=true|isInputViewShown=true|inputShown=true/.test(adb("shell", "dumpsys", "input_method"))) adb("shell", "input", "keyevent", "KEYCODE_BACK");
    if (previousIme === "null") adb("shell", "settings", "delete", "secure", "show_ime_with_hard_keyboard");
    else adb("shell", "settings", "put", "secure", "show_ime_with_hard_keyboard", previousIme);
    socket.close();
  }
}
async function inspectLayout(evaluate, name, dark) {
  await waitUntil(() => evaluate('matchMedia("(prefers-color-scheme: dark)").matches'), (v) => v === dark, "WebView theme did not follow Android");
  const workspaces = [];
  for (const [id, label] of [["encode", "发送"], ["signal", "载波"], ["inspect", "诊断"], ["receive", "接收"]]) {
    await clickButton(evaluate, label);
    const viewport = await fixedViewportState(evaluate);
    const overflow = await evaluate(`(() => { const panel = document.getElementById(${JSON.stringify(`mobile-panel-${id}`)});
      return { x: panel.scrollWidth - panel.clientWidth, y: panel.scrollHeight - panel.clientHeight }; })()`);
    assert.ok(overflow.x <= 1, JSON.stringify({ name, id, overflow }));
    if (viewport.height >= 800 && !name.includes("font-130")) assert.ok(overflow.y <= 1, JSON.stringify({ name, id, overflow }));
    const controls = await currentWorkspaceControls(evaluate, id);
    await fixedViewportState(evaluate);
    screenshot(`${name}-${id}`);
    workspaces.push({ id, overflow, controls, viewport });
  }
  const settled = await waitUntil(() => evaluate(`({
    navMotion: document.querySelector(".mobile-tab-bar")?.dataset.motion,
    panelOpacity: getComputedStyle(document.querySelector(".receiver-section")).opacity,
    runningFiniteAnimations: document.getAnimations().filter((animation) =>
      (animation.playState === "running" || animation.pending) && animation.effect?.getComputedTiming().iterations !== Infinity).length,
  })`), (s) => s.navMotion === "idle" && s.panelOpacity === "1" && s.runningFiniteAnimations === 0,
  "Navigation, panel or theme transitions did not settle");
  const state = await evaluate(`(() => {
    const rect = (selector) => { const r = document.querySelector(selector).getBoundingClientRect(); return { x:r.x, y:r.y, width:r.width, height:r.height, bottom:r.bottom }; };
    const icon = rect(".decode-icon"), svg = rect(".decode-icon svg"), nav = rect(".mobile-tab-bar"), receiver = rect(".receiver-section");
    const root = getComputedStyle(document.documentElement);
    return { width: innerWidth, height: innerHeight, overflow: document.documentElement.scrollWidth > innerWidth,
      dark: matchMedia("(prefers-color-scheme: dark)").matches, navVisible: nav.height > 0,
      iconCenterDelta: [svg.x + svg.width/2 - icon.x - icon.width/2, svg.y + svg.height/2 - icon.y - icon.height/2],
      contentClearOfNav: receiver.bottom <= nav.y, receiverBottom: receiver.bottom, navTop: nav.y,
      safeTop: root.getPropertyValue("--safe-top").trim(), safeBottom: root.getPropertyValue("--safe-bottom").trim() };
  })()`);
  assert.ok(!state.overflow && state.navVisible && state.contentClearOfNav, JSON.stringify(state));
  assert.ok(state.iconCenterDelta.every((v) => Math.abs(v) <= 1), JSON.stringify(state));
  // Native screencap must wait for the compositor to paint the scroll/theme
  // changes already reflected in getBoundingClientRect().
  await evaluate("new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  await delay(100);
  screenshot(name);
  const nativeAppearance = adb("shell", "dumpsys", "window").split(/\r?\n/).filter((line) => /appearance=|mAppearance|mSystemUiVisibility=/.test(line));
  return { name, ...state, ...settled, workspaces, nativeAppearance };
}
async function runLayouts(legacy = true) {
  const previous = {
    night: adb("shell", "cmd", "uimode", "night").split(":").at(-1).trim(),
    font: adb("shell", "settings", "get", "system", "font_scale"),
    autoRotation: adb("shell", "settings", "get", "system", "accelerometer_rotation"),
    rotation: adb("shell", "settings", "get", "system", "user_rotation"),
  };
  let socket = null;
  let evaluate;
  const results = [];
  try {
    adb("shell", "settings", "put", "system", "accelerometer_rotation", "0");
    adb("shell", "settings", "put", "system", "user_rotation", "0");
    for (const dark of [false, true]) {
      adb("shell", "cmd", "uimode", "night", dark ? "yes" : "no");
      // uiMode is intentionally omitted from MainActivity.configChanges so
      // WebView reinitializes its prefers-color-scheme value. Reconnect CDP
      // after Android recreates the Activity instead of using a dead target.
      socket?.close();
      // Emulator theme changes are asynchronous; wait for WindowManager and
      // the recreated Activity before attaching DevTools.
      await delay(1000);
      ({ socket, evaluate } = await openApp(legacy));
      results.push(await inspectLayout(evaluate, `android-${legacy ? "main" : "ggwave"}-portrait-${dark ? "dark" : "light"}`, dark));
    }
    adb("shell", "settings", "put", "system", "font_scale", "1.3");
    // Android recreates activities for fontScale changes. Reconnect to the new
    // WebView instead of treating its intentionally destroyed CDP context as a
    // recording or layout failure.
    socket.close();
    ({ socket, evaluate } = await openApp(legacy));
    results.push(await inspectLayout(evaluate, `android-${legacy ? "main" : "ggwave"}-font-130-dark`, true));
    adb("shell", "settings", "put", "system", "user_rotation", "1");
    await waitUntil(() => evaluate("innerWidth > innerHeight"), Boolean, "Android did not rotate");
    results.push(await inspectLayout(evaluate, `android-${legacy ? "main" : "ggwave"}-landscape-font-130-dark`, true));
    return results;
  } finally {
    for (const [name, value] of [["font_scale", previous.font], ["user_rotation", previous.rotation], ["accelerometer_rotation", previous.autoRotation]]) {
      if (value === "null") adb("shell", "settings", "delete", "system", name);
      else adb("shell", "settings", "put", "system", name, value);
    }
    adb("shell", "cmd", "uimode", "night", previous.night); socket.close();
  }
}

const deviceState = adb("get-state");
if (deviceState !== "device") throw new Error(`Android device not ready: ${deviceState}`);
const packageState = adb("shell", "dumpsys", "package", appId);
const installedApkPath = adb("shell", "pm", "path", appId).split(/\r?\n/).find((line) => line.endsWith("/base.apk")).replace(/^package:/, "");
const installedPackage = {
  versionName: packageState.match(/versionName=(\S+)/)?.[1],
  versionCode: Number(packageState.match(/versionCode=(\d+)/)?.[1]),
  sha256: adb("shell", "sha256sum", installedApkPath).split(/\s+/)[0],
};
const permissionWasGranted = packageState.includes("android.permission.RECORD_AUDIO: granted=true");
if (process.env.SONAWEAVE_EXPECT_VERSION) assert.equal(installedPackage.versionName, process.env.SONAWEAVE_EXPECT_VERSION, "Installed APK version is stale");
if (process.env.SONAWEAVE_EXPECT_VERSION_CODE) assert.equal(installedPackage.versionCode, Number(process.env.SONAWEAVE_EXPECT_VERSION_CODE), "Installed APK versionCode is stale");
const finalQuick = process.argv.includes("--final-quick");
const resumeMain = process.argv.includes("--resume-main");
let report = { deviceState, installedPackage, serial: process.env.ANDROID_SERIAL ?? "default", status: "running", scope: finalQuick ? "Final APK: microphone, live fast/48000 receive, worker failure recording retention" : "Full smoke" };
if (resumeMain) {
  assert.ok(outputDir, "A saved report directory is required to continue smoke testing");
  const previous = JSON.parse(readFileSync(path.join(outputDir, "android-smoke.json"), "utf8"));
  assert.equal(previous.installedPackage.sha256, installedPackage.sha256, "Cannot combine tests from different APKs");
  assert.equal(previous.ggwaveLoopback?.length, 3, "Prior ggwave self-checks are incomplete");
  assert.equal(previous.ggwavePcmInjection?.length, 6, "Prior ggwave live checks are incomplete");
  assert.ok(previous.ggwavePcmInjection.every(result => result.recordedWavReimported && result.tracksStopped));
  assert.equal(previous.ggwaveLayouts?.length, 4, "Prior ggwave layouts are incomplete");
  assert.ok(previous.ggwaveWorkerFailure?.tracksStopped && previous.microphone?.pcmCaptureStopped);
  assert.equal(previous.results?.length, 2, "Prior FSK/DTMF self-checks are incomplete");
  report = { ...previous, status: "running", continuation: {
    matchingApkSha256: installedPackage.sha256,
    retained: "Passed microphone, ggwave 3 self-checks / 6 streams / WAV reimport / worker-failure / 4 layouts and main self-checks from the complete run",
    repeated: "Main FSK/DTMF virtual PCM with one capture clock",
    remaining: "Main four layouts, both real Android keyboards and both pages' setting dialogs",
  } };
  delete report.error;
}
const saveReport = () => {
  if (outputDir) writeFileSync(path.join(outputDir, finalQuick ? "android-smoke-final.json" : "android-smoke.json"), JSON.stringify(report, null, 2));
};
try {
  if (resumeMain) {
    const mainPcmPassed = report.pcmInjection?.length === 2 && report.pcmInjection.every(result =>
      result.crcPass && result.tracksStopped && result.method.includes("sharing the production capture clock"));
    if (!mainPcmPassed) {
      report.pcmInjection = [];
      for (const mode of ["FSK", "DTMF"]) { report.pcmInjection.push(await runInjectedPcm(mode)); saveReport(); }
    }
    if (report.layouts?.length !== 4) { report.layouts = await runLayouts(true); saveReport(); }
    report.keyboard ??= {};
    if (!report.keyboard.main?.nativeIme) { report.keyboard.main = await runKeyboard(true); saveReport(); }
    if (!report.keyboard.ggwave?.nativeIme) { report.keyboard.ggwave = await runKeyboard(false); saveReport(); }
    report.dialogs ??= {};
    if (report.dialogs.main?.length !== 4) { report.dialogs.main = await runDialogs(true); saveReport(); }
    if (report.dialogs.ggwave?.length !== 4) { report.dialogs.ggwave = await runDialogs(false); saveReport(); }
    report.status = "passed"; saveReport(); console.log(JSON.stringify(report, null, 2));
  } else if (process.argv.includes("--ui-only")) {
    report.scope = "UI interim: fixed viewport, four workspaces, native font/rotation and real keyboard";
    report.layouts = [...await runLayouts(false), ...await runLayouts(true)];
    report.keyboard = { main: await runKeyboard(true), ggwave: await runKeyboard(false) };
    report.dialogs = { main: await runDialogs(true), ggwave: await runDialogs(false) };
    report.status = "passed";
    if (outputDir) writeFileSync(path.join(outputDir, "android-ui-interim.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } else if (process.argv.includes("--layout-only")) {
    report.layouts = [...await runLayouts(false), ...await runLayouts(true)];
    report.status = "passed";
    if (outputDir) writeFileSync(path.join(outputDir, "android-layouts.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } else {
    adb("shell", "pm", "grant", appId, "android.permission.RECORD_AUDIO");
    if (!finalQuick) {
      console.error("Shared main/ggwave page state: starting");
      report.pageSharing = await runSharedPages(); saveReport();
    }
    if (!process.argv.includes("--legacy-only")) {
      console.error("ggwave real microphone capture: starting");
      report.ggwaveMicrophone = await runGgMicrophoneCapture(); saveReport();
      report.ggwaveLoopback = [];
      for (const speed of finalQuick ? [] : ["normal", "fast", "fastest"]) {
        console.error(`ggwave loopback ${speed}: starting`);
        report.ggwaveLoopback.push(await runGgMode(speed)); saveReport();
      }
      report.ggwavePcmInjection = [];
      for (const speed of finalQuick ? ["fast"] : ["normal", "fast", "fastest"]) for (const rate of finalQuick ? [48_000] : [48_000, 44_100]) {
        console.error(`ggwave live PCM ${speed} / ${rate}: starting`);
        report.ggwavePcmInjection.push(await runGgInjectedPcm(speed, rate)); saveReport();
      }
      console.error("ggwave Worker failure recording retention: starting");
      report.ggwaveWorkerFailure = await runGgWorkerFailure(); saveReport();
      if (!finalQuick && !process.argv.includes("--skip-layout")) {
        console.error("ggwave theme, font scale and orientation: starting");
        report.ggwaveLayouts = await runLayouts(false); saveReport();
      }
    }
    if (!finalQuick && !process.argv.includes("--ggwave-only")) {
      console.error("Legacy real microphone capture: starting");
      report.microphone = await runMicrophoneCapture(); saveReport();
      report.results = [];
      for (const mode of ["FSK", "DTMF"]) { console.error(`Legacy loopback ${mode}: starting`); report.results.push(await runMode(mode)); saveReport(); }
      report.pcmInjection = [];
      for (const mode of ["FSK", "DTMF"]) { report.pcmInjection.push(await runInjectedPcm(mode)); saveReport(); }
      if (!process.argv.includes("--skip-layout")) {
        console.error("Legacy theme, font scale and orientation: starting");
        report.layouts = await runLayouts(true); saveReport();
      }
    }
    if (!finalQuick && !process.argv.includes("--skip-layout")) {
      console.error("Real Android keyboard: starting");
      report.keyboard = { main: await runKeyboard(true), ggwave: await runKeyboard(false) }; saveReport();
      report.dialogs = { main: await runDialogs(true), ggwave: await runDialogs(false) }; saveReport();
    }
    report.status = "passed"; saveReport();
    console.log(JSON.stringify(report, null, 2));
  }
} catch (error) {
  report.status = "failed"; report.error = error instanceof Error ? error.stack : String(error); saveReport();
  try { screenshot("android-smoke-failure"); } catch { /* Preserve the original failure. */ }
  throw error;
} finally {
  if (!permissionWasGranted) adb("shell", "pm", "revoke", appId, "android.permission.RECORD_AUDIO");
  adb("forward", "--remove", `tcp:${devtoolsPort}`);
}
