import { execFileSync } from "node:child_process";
import path from "node:path";

const appId = "com.sonaweave.app";
const activity = `${appId}/.MainActivity`;
const devtoolsPort = 9222;
const sdkRoot = process.env.ANDROID_SDK_ROOT ?? process.env.ANDROID_HOME;

if (!sdkRoot) {
  throw new Error("ANDROID_HOME or ANDROID_SDK_ROOT must point to the Android SDK.");
}

const adbPath =
  process.platform === "win32"
    ? path.join(sdkRoot, "platform-tools", "adb.exe")
    : path.join(sdkRoot, "platform-tools", "adb");

const delay = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

function adb(...args) {
  return execFileSync(adbPath, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

async function waitForTarget() {
  const endpoint = `http://127.0.0.1:${devtoolsPort}/json`;

  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const targets = await fetch(endpoint).then((response) => response.json());
      const target = targets.find(
        (candidate) =>
          candidate.type === "page" && candidate.url === "https://localhost/",
      );
      if (target?.webSocketDebuggerUrl) {
        return target;
      }
    } catch {
      // The WebView debugging socket appears shortly after the activity starts.
    }
    await delay(250);
  }

  throw new Error("The SonaWeave WebView did not expose a DevTools target.");
}

async function connectToWebView() {
  const pid = adb("shell", "pidof", appId).split(/\s+/)[0];
  if (!pid) {
    throw new Error("SonaWeave is not running on the connected Android device.");
  }

  try {
    adb("forward", "--remove", `tcp:${devtoolsPort}`);
  } catch {
    // There may be no previous forwarding rule.
  }
  adb(
    "forward",
    `tcp:${devtoolsPort}`,
    `localabstract:webview_devtools_remote_${pid}`,
  );

  const target = await waitForTarget();
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });

  let sequence = 0;
  const pending = new Map();

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timeout);
    if (message.error) {
      request.reject(new Error(JSON.stringify(message.error)));
    } else {
      request.resolve(message.result);
    }
  });

  const call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++sequence;
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`DevTools request timed out: ${method}`));
      }, 10_000);
      pending.set(id, { resolve, reject, timeout });
      socket.send(JSON.stringify({ id, method, params }));
    });

  const evaluate = async (expression) => {
    const response = await call("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (response.exceptionDetails) {
      throw new Error(response.exceptionDetails.text ?? "WebView evaluation failed.");
    }
    return response.result.value;
  };

  return { socket, evaluate };
}

async function clickButton(evaluate, label) {
  const serializedLabel = JSON.stringify(label);
  await evaluate(`(() => {
    const button = [...document.querySelectorAll("button")].find(
      (candidate) => candidate.textContent.trim() === ${serializedLabel},
    );
    if (!button) throw new Error("Button not found: " + ${serializedLabel});
    button.click();
    return true;
  })()`);
}

function isRecordAudioGranted() {
  const packageState = adb("shell", "dumpsys", "package", appId);
  return packageState.includes("android.permission.RECORD_AUDIO: granted=true");
}

async function runMicrophoneCapture() {
  const permissionWasGranted = isRecordAudioGranted();
  adb("shell", "pm", "grant", appId, "android.permission.RECORD_AUDIO");
  adb("shell", "am", "force-stop", appId);
  adb("shell", "am", "start", "-W", "-n", activity);

  const { socket, evaluate } = await connectToWebView();
  try {
    await clickButton(evaluate, "麦克风接收");

    const startDeadline = Date.now() + 10_000;
    let state;
    while (Date.now() < startDeadline) {
      state = await evaluate(`(() => ({
        buttonText: [...document.querySelectorAll("button")]
          .find((button) => button.textContent.trim() === "停止并解码" || button.textContent.trim() === "麦克风接收")
          ?.textContent.trim(),
        statusText: document.querySelector(".decode-status-row strong")?.textContent?.trim(),
        pageText: document.body.innerText,
      }))()`);
      if (state.buttonText === "停止并解码" && state.statusText === "正在监听声波") break;
      if (state.pageText.includes("Permission denied")) {
        throw new Error("The WebView denied microphone capture despite Android permission.");
      }
      await delay(100);
    }

    if (state?.buttonText !== "停止并解码" || state.statusText !== "正在监听声波") {
      throw new Error(`Microphone recording did not start. Last UI state: ${JSON.stringify(state)}`);
    }

    await delay(750);
    await clickButton(evaluate, "停止并解码");

    const stopDeadline = Date.now() + 10_000;
    while (Date.now() < stopDeadline) {
      state = await evaluate(`(() => ({
        buttonText: [...document.querySelectorAll("button")]
          .find((button) => button.textContent.trim() === "停止并解码" || button.textContent.trim() === "麦克风接收")
          ?.textContent.trim(),
        pageText: document.body.innerText,
      }))()`);
      if (state.buttonText === "麦克风接收") break;
      await delay(100);
    }

    if (state?.buttonText !== "麦克风接收") {
      throw new Error(`Microphone recording did not stop. Last UI state: ${JSON.stringify(state)}`);
    }
    if (state.pageText.includes("Permission denied")) {
      throw new Error("The microphone flow ended with a permission error.");
    }

    return {
      androidPermissionGranted: true,
      webViewCaptureStarted: true,
      mediaRecorderStopped: true,
    };
  } finally {
    socket.close();
    if (!permissionWasGranted) {
      adb("shell", "pm", "revoke", appId, "android.permission.RECORD_AUDIO");
    }
  }
}

async function runMode(mode) {
  adb("shell", "am", "force-stop", appId);
  adb("shell", "am", "start", "-W", "-n", activity);

  const { socket, evaluate } = await connectToWebView();
  try {
    await clickButton(evaluate, mode);
    await delay(150);
    await clickButton(evaluate, "编织声波");

    const buildDeadline = Date.now() + 10_000;
    while (Date.now() < buildDeadline) {
      const loopbackReady = await evaluate(
        '!document.querySelector("[data-testid=loopback-button]").disabled',
      );
      if (loopbackReady) break;
      await delay(100);
    }

    const loopbackReady = await evaluate(
      '!document.querySelector("[data-testid=loopback-button]").disabled',
    );
    if (!loopbackReady) {
      throw new Error(`${mode} signal was not ready within 10 seconds.`);
    }

    await clickButton(evaluate, "运行回环解码");

    const startedAt = Date.now();
    const deadline = startedAt + 30_000;
    let bodyText = "";

    while (Date.now() < deadline) {
      const status = await evaluate(`(() => ({
        crc: document.querySelector("[data-testid=crc-status]")?.textContent?.trim(),
        restored: Boolean(document.querySelector(".decoded-output.success")),
        decodedText: document.querySelector("[data-testid=decoded-text]")?.textContent?.trim(),
      }))()`);
      if (status.crc === "PASS" && status.restored) {
        bodyText = await evaluate("document.body.innerText");
        const highlights = bodyText
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => /PASS|CRC|消息完整还原|纠正|置信/.test(line));
        return {
          mode,
          elapsedMs: Date.now() - startedAt,
          crcPass: true,
          restored: true,
          decodedCharacters: status.decodedText.length,
          highlights,
        };
      }
      bodyText = await evaluate("document.body.innerText");
      await delay(250);
    }

    throw new Error(
      `${mode} loopback did not pass within 30 seconds. Last UI text: ${bodyText.slice(-500)}`,
    );
  } finally {
    socket.close();
  }
}

const deviceState = adb("get-state");
if (deviceState !== "device") {
  throw new Error(`Android device is not ready: ${deviceState || "not connected"}`);
}

const microphone = await runMicrophoneCapture();
const results = [];
for (const mode of ["FSK", "DTMF"]) {
  results.push(await runMode(mode));
}

console.log(JSON.stringify({ deviceState, microphone, results }, null, 2));
