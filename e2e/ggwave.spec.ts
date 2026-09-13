import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";

async function openGgWave(page: Page, url = "/") {
  await page.goto(url);
  await page.getByTestId("page-ggwave").click();
  await expect(page.getByTestId("speed-fast")).toBeVisible();
}

test("main and ggwave pages share drafts, examples, and the mobile workspace without truncating long text", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, reducedMotion: "reduce" });
  const page = await context.newPage();
  await page.goto("http://127.0.0.1:5173/");
  await expect(page.getByTestId("mode-fsk")).toBeVisible();
  await expect(page.getByTestId("speed-fast")).toHaveCount(0);
  const draft = "两页共享草稿\nDraft 🙂 123";
  await page.getByTestId("message-input").fill(draft);
  await page.getByTestId("page-ggwave").click();
  await expect(page.getByTestId("message-input")).toHaveValue(draft);
  await expect(page.getByTestId("speed-fast")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".repeat-option")).toHaveCount(0);

  await page.getByTestId("quick-examples").selectOption({ index: 1 });
  const firstExample = await page.getByTestId("message-input").inputValue();
  const firstSelection = await page.getByTestId("quick-examples").inputValue();
  expect(firstExample).not.toBe(draft);
  await page.getByTestId("page-main").click();
  await expect(page.getByTestId("message-input")).toHaveValue(firstExample);
  await expect(page.getByTestId("quick-examples")).toHaveValue(firstSelection);
  await page.getByTestId("quick-examples").selectOption({ index: 2 });
  const secondExample = await page.getByTestId("message-input").inputValue();
  const secondSelection = await page.getByTestId("quick-examples").inputValue();
  expect(secondExample).not.toBe(firstExample);
  await page.getByTestId("page-ggwave").click();
  await expect(page.getByTestId("message-input")).toHaveValue(secondExample);
  await expect(page.getByTestId("quick-examples")).toHaveValue(secondSelection);

  for (const workspace of ["载波", "接收", "诊断", "发送"] as const) {
    await selectWorkspace(page, workspace);
    await page.getByTestId("page-main").click();
    await expect(page.locator(".mobile-tab-bar button[aria-current=page]")).toHaveText(workspace);
    await page.getByTestId("page-ggwave").click();
    await expect(page.locator(".mobile-tab-bar button[aria-current=page]")).toHaveText(workspace);
  }
  await page.getByTestId("page-main").click();
  const longDraft = "声".repeat(60); // 180 UTF-8 bytes: valid on main, above ggwave's limit.
  await page.getByTestId("message-input").fill(longDraft);
  await expect(page.getByTestId("build-signal")).toBeEnabled();
  await page.getByTestId("page-ggwave").click();
  await expect(page.getByTestId("message-input")).toHaveValue(longDraft);
  await expect(page.getByTestId("build-signal")).toBeDisabled();
  await page.getByTestId("page-main").click();
  await expect(page.getByTestId("message-input")).toHaveValue(longDraft);
  await expect(page.getByTestId("build-signal")).toBeEnabled();
  await context.close();
});

test("switching either page pauses its media, and page controls lock during real capture and analysis", async ({ page }) => {
  await installMicrophone(page);
  await page.goto("/");
  for (const current of ["main", "ggwave"] as const) {
    await selectWorkspace(page, "发送");
    await page.getByTestId("message-input").fill("切页测试 OK");
    await page.getByTestId("build-signal").click();
    await selectWorkspace(page, "载波");
    await page.locator(".signal-panel audio").evaluate((element: HTMLAudioElement) => {
      Object.assign(window, { previousPageAudio: element });
    });
    await page.locator(".signal-panel").getByRole("button", { name: "播放声波", exact: true }).click();
    await expect.poll(() => page.evaluate(() => {
      // @ts-expect-error Retain the real element across the page's unmount.
      return window.previousPageAudio.paused;
    })).toBe(false);
    await page.getByTestId(current === "main" ? "page-ggwave" : "page-main").click();
    await expect.poll(() => page.evaluate(() => {
      // @ts-expect-error Retained real media element.
      return window.previousPageAudio.paused;
    })).toBe(true);
  }
  for (const target of ["main", "ggwave"] as const) {
    if (target === "ggwave") await page.getByTestId("page-ggwave").click();
    await selectWorkspace(page, "接收");
    await page.getByTestId("record-button").click();
    await expect(page.getByTestId("recording-meter")).toContainText("麦克风已就绪");
    await expect(page.getByTestId("page-main")).toBeDisabled();
    await expect(page.getByTestId("page-ggwave")).toBeDisabled();
    await page.getByRole("button", { name: "取消接收", exact: true }).click();
    await expect(page.getByTestId("page-main")).toBeEnabled();
    await expect(page.getByTestId("page-ggwave")).toBeEnabled();
    await selectWorkspace(page, "发送");
    await page.getByTestId("build-signal").click();
    await selectWorkspace(page, "载波");
    // Observe the real asynchronous analysis; do not delay or replace Worker
    // responses just to make a transient disabled state easier to test.
    await page.evaluate(() => {
      const probe = { locked: false, observer: undefined as MutationObserver | undefined };
      probe.observer = new MutationObserver(() => {
        const main = document.querySelector<HTMLButtonElement>("[data-testid=page-main]");
        const secondary = document.querySelector<HTMLButtonElement>("[data-testid=page-ggwave]");
        if (main?.disabled && secondary?.disabled) probe.locked = true;
      });
      probe.observer.observe(document.body, { attributes: true, subtree: true, attributeFilter: ["disabled"] });
      Object.assign(window, { analysisPageLock: probe });
    });
    await page.getByTestId("loopback-button").click();
    await expect(page.getByTestId("decoded-text")).toHaveText("切页测试 OK");
    const locked = await page.evaluate(() => {
      // @ts-expect-error Actual DOM mutation probe.
      const probe = window.analysisPageLock;
      probe.observer.disconnect(); return probe.locked;
    });
    expect(locked).toBe(true);
    await expect(page.getByTestId("page-main")).toBeEnabled();
    await expect(page.getByTestId("page-ggwave")).toBeEnabled();
  }
});

async function selectWorkspace(page: Page, name: "发送" | "载波" | "接收" | "诊断") {
  const navigation = page.getByRole("navigation", { name: "主要工作区" });
  if (await navigation.isVisible()) {
    await navigation.getByRole("button", { name, exact: false }).click();
  }
}

async function installMicrophone(page: Page, delayedPermission = false) {
  await page.addInitScript(({ delayedPermission }) => {
    Object.defineProperty(navigator.mediaDevices, "enumerateDevices", { value: async () => [
      { kind: "audioinput", deviceId: "acoustic-test", groupId: "test", label: "虚拟声学输入", toJSON() { return {}; } },
    ] });
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", { value: async (constraints: MediaStreamConstraints) => {
      const context = new AudioContext({ sampleRate: 44_100 });
      await context.resume();
      const destination = context.createMediaStreamDestination();
      const capture = { context, destination, constraints };
      Object.assign(window, { testCapture: capture });
      if (!delayedPermission) return destination.stream;
      return new Promise<MediaStream>(resolve => {
        Object.assign(window, { allowTestStream: () => resolve(destination.stream) });
      });
    } });
  }, { delayedPermission });
}

async function playWavIntoMicrophone(page: Page, wavBytes: number[]) {
  await page.evaluate(async (wavBytes) => {
    // Replay the actual UI-exported WAV into a virtual microphone endpoint.
    // Encoding, AudioWorklet capture, Worker decode, and WAV import stay real.
    // @ts-expect-error Injected audio device fixture.
    const { context, destination } = window.testCapture;
    const original = await context.decodeAudioData(new Uint8Array(wavBytes).buffer);
    const buffer = context.createBuffer(1, original.length + Math.ceil(context.sampleRate * 0.4), context.sampleRate);
    buffer.copyToChannel(original.getChannelData(0), 0);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(destination);
    await new Promise<void>(resolve => { source.onended = () => resolve(); source.start(); });
  }, wavBytes);
}

for (const speed of ["normal", "fast", "fastest"] as const) {
  test(`ggwave ${speed} completes its real-worker digital self-check`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await openGgWave(page);
    await page.locator("textarea#message").fill("声织 E2E 🙂");
    await page.getByTestId(`speed-${speed}`).click();
    await page.getByTestId("build-signal").click();
    await page.getByTestId("loopback-button").click();
    await expect(page.getByTestId("decoded-text")).toHaveText("声织 E2E 🙂");
    await expect(page.getByTestId("crc-status")).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}

test("ggwave rejects an oversized UTF-8 message before generation", async ({ page }) => {
  await openGgWave(page);
  await page.locator("textarea#message").fill("中".repeat(47));
  await expect(page.getByTestId("build-signal")).toBeDisabled();
  await expect(page.getByText(/141.*140|140.*141/)).toBeVisible();
  await page.locator("textarea#message").fill("中".repeat(46) + "ab");
  await expect(page.getByTestId("build-signal")).toBeEnabled();
});

for (const speed of ["normal", "fast", "fastest"] as const) {
test(`production AudioWorklet and ggwave ${speed} Worker decode the selected send WAV, then reimport its recorded WAV`, async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await installMicrophone(page);
  await openGgWave(page);
  const text = `自动接收 ${speed} OK`;
  await page.getByTestId("message-input").fill(text);
  await page.getByTestId(`speed-${speed}`).click();
  await expect(page.getByTestId(`speed-${speed}`)).toHaveAttribute("aria-pressed", "true");
  await page.getByTestId("build-signal").click();
  await selectWorkspace(page, "载波");
  const transmitDownload = page.waitForEvent("download");
  await page.locator(".signal-panel").getByRole("button", { name: /导出.*WAV/ }).click();
  const sentWav = await transmitDownload;
  expect(sentWav.suggestedFilename()).toBe(`sonaweave-ggwave-${speed}.wav`);
  const sentBytes = await readFile((await sentWav.path())!);
  expect(sentBytes.subarray(0, 4).toString()).toBe("RIFF");
  await selectWorkspace(page, "接收");
  await page.locator("#input-device").selectOption("acoustic-test");
  await page.getByTestId("record-button").click();
  await expect(page.getByTestId("recording-meter")).toBeVisible();
  await expect(page.getByTestId("recording-meter")).toContainText("麦克风已就绪");
  await playWavIntoMicrophone(page, Array.from(sentBytes));
  await expect(page.getByTestId("decoded-text")).toHaveText(text, { timeout: 15_000 });
  await expect(page.getByTestId("recording-meter")).toHaveCount(0);
  await expect(page.locator("audio[aria-label='回听本次录音']")).toBeVisible();
  await expect(page.getByTestId("export-recording")).toBeEnabled();
  await expect(page.getByTestId("export-diagnostic")).toBeEnabled();
  await expect.poll(() => page.evaluate(() => {
    // @ts-expect-error Injected audio device fixture.
    return window.testCapture.destination.stream.getTracks()[0].readyState;
  })).toBe("ended");
  expect(await page.evaluate(() => {
    // @ts-expect-error Injected audio device fixture.
    return window.testCapture.constraints.audio.deviceId;
  })).toEqual({ exact: "acoustic-test" });
  const recordingDownload = page.waitForEvent("download");
  await page.getByTestId("export-recording").click();
  const recording = await recordingDownload;
  const recordingBytes = await readFile((await recording.path())!);
  expect(recordingBytes.subarray(0, 4).toString()).toBe("RIFF");
  expect(recordingBytes.length).toBeGreaterThan(20_000);
  await page.getByTestId("audio-file").setInputFiles({ name: `${speed}-captured.wav`, mimeType: "audio/wav", buffer: recordingBytes });
  await expect(page.getByTestId("receive-status")).toContainText("音频文件");
  await expect(page.getByTestId("decoded-text")).toHaveText(text);
  await expect(page.getByTestId("verification-status")).toHaveText("Reed-Solomon");
  expect(errors).toEqual([]);
});
}

test("silent microphone capture keeps replayable WAV and diagnostic JSON after decoding fails", async ({ page }) => {
  await installMicrophone(page);
  await openGgWave(page);
  await selectWorkspace(page, "接收");
  await page.getByTestId("record-button").click();
  await expect(page.getByTestId("recording-meter")).toBeVisible();
  await expect(page.getByTestId("recording-meter")).toContainText("麦克风已就绪");
  // Wait for real PCM callbacks, not a stubbed decoder or fabricated recording.
  await expect.poll(() => page.evaluate(() => {
    // @ts-expect-error Injected audio device fixture.
    return window.testCapture.context.currentTime;
  })).toBeGreaterThan(0.6);
  await page.getByTestId("record-button").click();
  await expect(page.getByTestId("decoded-text")).toContainText(/没有|未收到|静音/);
  await expect(page.locator("audio[aria-label='回听本次录音']")).toBeVisible();
  const wavDownload = page.waitForEvent("download");
  await page.getByTestId("export-recording").click();
  const wav = await wavDownload;
  const wavBytes = await readFile((await wav.path())!);
  expect(wavBytes.subarray(0, 4).toString()).toBe("RIFF");
  expect(wavBytes.subarray(8, 12).toString()).toBe("WAVE");
  expect(wavBytes.length).toBeGreaterThan(1000);
  const diagnosticDownload = page.waitForEvent("download");
  await page.getByTestId("export-diagnostic").click();
  const diagnostic = await diagnosticDownload;
  const json = JSON.parse(await readFile((await diagnostic.path())!, "utf8"));
  expect(json.capture.backend).toBe("AudioWorklet");
  expect(json.audio.status).toBe("silence");
  expect(json.result.engineError).toContain("ggwave：");
  expect(json.result.engineError).toContain("兼容 FSK/DTMF：");
  await expect(page.getByTestId("record-button")).toBeEnabled();
});

test("a live Worker failure preserves partial real PCM and its original error", async ({ page }) => {
  await installMicrophone(page);
  await page.addInitScript(() => {
    const OriginalWorker = window.Worker;
    window.Worker = class extends OriginalWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        // Keep the actual production Worker and decoder. Expose this instance
        // solely to inject the browser's worker-error event after PCM arrives.
        if (String(url).includes("acoustic.worker")) Object.assign(window, { testAcousticWorker: this });
      }
    };
  });
  await openGgWave(page);
  await selectWorkspace(page, "接收");
  await page.getByTestId("record-button").click();
  await expect(page.getByTestId("recording-meter")).toContainText("麦克风已就绪");
  const toneStartedAt = await page.evaluate(() => {
    // @ts-expect-error Injected audio device fixture.
    const { context, destination } = window.testCapture;
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.frequency.value = 200;
    gain.gain.value = 0.05;
    oscillator.connect(gain).connect(destination);
    oscillator.start();
    return context.currentTime;
  });
  await expect.poll(() => page.evaluate(() => {
    // @ts-expect-error Injected audio device fixture.
    return window.testCapture.context.currentTime;
  })).toBeGreaterThan(toneStartedAt + 0.5);
  await page.evaluate(() => {
    // @ts-expect-error Exposed real production Worker fixture.
    window.testAcousticWorker.dispatchEvent(new ErrorEvent("error", { message: "Injected worker failure after capture" }));
  });
  await expect(page.getByTestId("receive-status")).toContainText("未能完成接收");
  await expect(page.locator("audio[aria-label='回听本次录音']")).toBeVisible();
  await expect.poll(() => page.evaluate(() => {
    // @ts-expect-error Injected audio device fixture.
    return window.testCapture.destination.stream.getTracks()[0].readyState;
  })).toBe("ended");
  const wavDownload = page.waitForEvent("download");
  await page.getByTestId("export-recording").click();
  const wav = await wavDownload;
  const wavBytes = await readFile((await wav.path())!);
  expect(wavBytes.subarray(0, 4).toString()).toBe("RIFF");
  expect(wavBytes.length).toBeGreaterThan(20_000);
  const diagnosticDownload = page.waitForEvent("download");
  await page.getByTestId("export-diagnostic").click();
  const diagnostic = await diagnosticDownload;
  const json = JSON.parse(await readFile((await diagnostic.path())!, "utf8"));
  expect(json.capture.backend).toBe("AudioWorklet");
  expect(json.audio.rms).toBeGreaterThan(0.005);
  expect(json.result.status).toBe("error");
  expect(json.result.engineError).toBe("Audio engine failed to load");
  await expect(page.getByTestId("record-button")).toBeEnabled();
});

test("cancelling ggwave microphone startup stops a delayed permission stream", async ({ page }) => {
  await installMicrophone(page, true);
  await openGgWave(page);
  await selectWorkspace(page, "接收");
  await page.getByTestId("record-button").click();
  await expect.poll(() => page.evaluate(() => "allowTestStream" in window)).toBe(true);
  await page.getByRole("button", { name: "取消接收", exact: true }).click();
  await page.evaluate(() => {
    // @ts-expect-error Injected permission fixture.
    window.allowTestStream();
  });
  await expect.poll(() => page.evaluate(() => {
    // @ts-expect-error Injected audio device fixture.
    return window.testCapture.destination.stream.getTracks()[0].readyState;
  })).toBe("ended");
  await expect(page.getByTestId("record-button")).toBeEnabled();
  await expect(page.locator("audio[aria-label='回听本次录音']")).toHaveCount(0);
});

for (const viewport of [{ width: 320, height: 844 }, { width: 390, height: 844 }, { width: 900, height: 412 }, { width: 1365, height: 900 }]) {
  test(`ggwave secondary workflow fits viewport ${viewport.width}x${viewport.height}`, async ({ browser }, testInfo) => {
    const touch = viewport.width < 1200;
    const context = await browser.newContext({ viewport, hasTouch: touch, isMobile: touch, reducedMotion: "reduce", colorScheme: "dark" });
    const page = await context.newPage();
    await openGgWave(page, "http://127.0.0.1:5173/");
    await page.locator("textarea#message").fill("移动接收 OK");
    await page.getByTestId("build-signal").click();
    await expect(page.getByTestId("loopback-button")).toBeVisible();
    await page.getByTestId("loopback-button").click();
    await expect(page.getByTestId("decoded-text")).toHaveText("移动接收 OK");
    for (const view of ["发送", "载波", "接收", "诊断", "接收"] as const) {
      await selectWorkspace(page, view);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    }
    expect(await page.locator(".decode-icon").evaluate(element => {
      const icon = element.querySelector("svg")!.getBoundingClientRect();
      const box = element.getBoundingClientRect();
      return Math.abs(icon.x + icon.width / 2 - box.x - box.width / 2) < 1
        && Math.abs(icon.y + icon.height / 2 - box.y - box.height / 2) < 1;
    })).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`ggwave-${viewport.width}.png`), fullPage: true });
    await context.close();
  });
}
