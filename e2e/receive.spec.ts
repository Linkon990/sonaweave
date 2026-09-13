import { expect, test, type Page } from "@playwright/test";

async function openLegacy(page: Page, url = "/") {
  await page.goto(url);
  // FSK/DTMF is the default main page; opening it must not require a detour.
  await expect(page.getByTestId("mode-fsk")).toBeVisible();
  await expect(page.getByTestId("page-ggwave")).toBeVisible();
}

async function makeWav(page: Page, mode: "fsk" | "dtmf", text = "声织 OK") {
  return page.evaluate(async ({ mode, text }) => {
    // The test server compiles the same production core; no alternate decoder.
    // @ts-expect-error Vite serves source modules in this browser-only test.
    const { encodeMessage } = await import("/src/core/protocol.ts");
    // @ts-expect-error Vite source module.
    const { encodeWav } = await import("/src/core/wav.ts");
    const signal = encodeMessage(text, mode).signal;
    return Array.from(new Uint8Array(await encodeWav(signal.samples, signal.sampleRate).arrayBuffer()));
  }, { mode, text });
}

for (const mode of ["fsk", "dtmf"] as const) {
  test(`imports ${mode} with the other send mode selected, including the same file twice`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await openLegacy(page);
    await page.getByTestId(`mode-${mode === "fsk" ? "dtmf" : "fsk"}`).click();
    const buffer = Buffer.from(await makeWav(page, mode));
    for (let attempt = 0; attempt < 2; attempt++) {
      await page.locator("input[type=file]").setInputFiles({ name: `${mode}.wav`, mimeType: "audio/wav", buffer });
      await expect(page.getByTestId("crc-status")).toHaveText("PASS");
      await expect(page.getByTestId("decoded-text")).toHaveText("声织 OK");
      await expect(page.locator(".decode-status-row")).toContainText(mode.toUpperCase());
    }
    expect(errors).toEqual([]);
  });
}

test("raw PCM traverses AudioWorklet and restores a transmitted message", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => {
    window.AudioContext = new Proxy(window.AudioContext, { construct(target, args) {
      // Emulate a 44.1 kHz capture device, including the production Worklet.
      // One graph clock prevents a synthetic inter-context jitter buffer from
      // inserting 10 ms into the virtual input while it synchronizes.
      const context = Reflect.construct(target, [{ ...args[0], sampleRate: 44_100 }]) as AudioContext;
      Object.assign(window, { testProductionContext: context });
      return context;
    } });
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", { value: async () => {
      // @ts-expect-error Observe the context created by the production recorder.
      const context: AudioContext = window.testProductionContext;
      await context.resume();
      const destination = context.createMediaStreamDestination();
      Object.assign(window, { testCapture: { context, destination } });
      return destination.stream;
    } });
  });
  await openLegacy(page);
  await page.getByTestId("record-button").click();
  await expect(page.locator(".decode-status-row strong")).toHaveText("正在监听声波");
  expect(await page.evaluate(() => {
    // @ts-expect-error Actual production graph in the capture-device fixture.
    return window.testProductionContext.sampleRate;
  })).toBe(44_100);
  await expect(page.getByRole("button", { name: "导入音频" })).toBeDisabled();
  await page.evaluate(async () => {
    // @ts-expect-error Vite source module.
    const { encodeMessage } = await import("/src/core/protocol.ts");
    const signal = encodeMessage("PCM 收音验证", "fsk").signal;
    // @ts-expect-error Test-only injected stream fixture.
    const { context, destination } = window.testCapture;
    // Keep a rendered silence tail before clicking stop so queued capture
    // receives the whole packet. The original 48 kHz signal is resampled by
    // the real 44.1 kHz AudioContext before reaching the production Worklet.
    const buffer = context.createBuffer(1, signal.samples.length + Math.ceil(signal.sampleRate * 0.3), signal.sampleRate);
    buffer.copyToChannel(signal.samples, 0);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(destination);
    await new Promise<void>(resolve => { source.onended = () => resolve(); source.start(); });
  });
  await expect(page.getByTestId("recording-meter")).toBeVisible();
  await page.getByTestId("record-button").click();
  await expect(page.getByTestId("crc-status")).toHaveText("PASS");
  await expect(page.getByTestId("decoded-text")).toHaveText("PCM 收音验证");
  await expect(page.getByTestId("record-button")).toHaveText("开始接收");
  expect(errors).toEqual([]);
});

test("silent PCM has an actionable error and a cancelled start releases a late stream", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", { value: async () => {
      const context = new AudioContext();
      await context.resume();
      const destination = context.createMediaStreamDestination();
      Object.assign(window, { lateStream: destination.stream });
      return new Promise(resolve => { Object.assign(window, { allowTestStream: () => resolve(destination.stream) }); });
    } });
  });
  await openLegacy(page);
  await page.getByTestId("record-button").click();
  await expect(page.getByTestId("record-button")).toHaveText("正在启动");
  await page.getByRole("button", { name: "取消接收" }).click();
  await page.evaluate(() => {
    // @ts-expect-error Test fixture.
    window.allowTestStream();
  });
  await expect.poll(() => page.evaluate(() => {
    // @ts-expect-error Test fixture.
    return window.lateStream.getTracks()[0].readyState;
  })).toBe("ended");
  await expect(page.getByTestId("record-button")).toHaveText("开始接收");
  const silence = await page.evaluate(async () => {
    // @ts-expect-error Vite source module.
    const { encodeWav } = await import("/src/core/wav.ts");
    return Array.from(new Uint8Array(await encodeWav(new Float32Array(48_000), 48_000).arrayBuffer()));
  });
  await page.locator("input[type=file]").setInputFiles({ name: "silence.wav", mimeType: "audio/wav", buffer: Buffer.from(silence) });
  await expect(page.getByTestId("decoded-text")).toContainText("没有录到有效声音");
});

test("landscape touch navigation and reduced motion keep the selected panel usable", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 900, height: 412 }, hasTouch: true, isMobile: true, reducedMotion: "reduce" });
  const page = await context.newPage();
  await openLegacy(page, "http://127.0.0.1:5173/");
  await expect(page.locator(".mobile-tab-bar")).toBeVisible();
  await page.locator(".mobile-tab-bar").getByRole("button", { name: "接收", exact: false }).click();
  await expect(page.getByTestId("record-button")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(await page.locator(".decode-icon").evaluate(element => {
    const icon = element.querySelector("svg")!.getBoundingClientRect();
    const box = element.getBoundingClientRect();
    return Math.abs(icon.x + icon.width / 2 - box.x - box.width / 2) < 1
      && Math.abs(icon.y + icon.height / 2 - box.y - box.height / 2) < 1;
  })).toBe(true);
  const duration = await page.locator(".mobile-tab-selection").evaluate(element => parseFloat(getComputedStyle(element).animationDuration));
  expect(duration).toBeLessThan(0.001);
  await context.close();
});

for (const width of [320, 360, 390, 1365]) {
  for (const colorScheme of ["light", "dark"] as const) {
    test(`layout ${width}px ${colorScheme}`, async ({ browser }, testInfo) => {
      const context = await browser.newContext({ viewport: { width, height: 844 }, colorScheme, reducedMotion: "reduce" });
      const page = await context.newPage();
      await openLegacy(page, "http://127.0.0.1:5173/");
      await page.getByTestId("build-signal").click();
      await page.getByTestId("loopback-button").click();
      await expect(page.getByTestId("crc-status")).toHaveText("PASS");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      const centered = await page.locator(".decode-icon").evaluate(element => {
        const icon = element.querySelector("svg")!.getBoundingClientRect();
        const box = element.getBoundingClientRect();
        return Math.abs(icon.x + icon.width / 2 - box.x - box.width / 2) < 1 && Math.abs(icon.y + icon.height / 2 - box.y - box.height / 2) < 1;
      });
      expect(centered).toBe(true);
      if (width < 760) {
        await expect(page.locator(".mobile-tab-bar")).toBeVisible();
        for (const label of ["发送", "载波", "接收", "诊断", "接收"]) {
          await page.locator(".mobile-tab-bar").getByRole("button", { name: label, exact: false }).click();
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        }
      }
      await page.screenshot({ path: testInfo.outputPath(`receive-${width}-${colorScheme}.png`), fullPage: true });
      await context.close();
    });
  }
}
