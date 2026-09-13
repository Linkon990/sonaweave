import { expect, test, type Locator, type Page } from "@playwright/test";
import { writeFile } from "node:fs/promises";

const workspaces = [
  { id: "encode", label: "发送" },
  { id: "signal", label: "载波" },
  { id: "receive", label: "接收" },
  { id: "inspect", label: "诊断" },
] as const;

async function settle(page: Page) {
  await expect.poll(() => page.evaluate(() => document.getAnimations().filter(animation =>
    (animation.playState === "running" || animation.pending)
    && animation.effect?.getComputedTiming().iterations !== Infinity).length)).toBe(0);
}

// This is a font-size stress fixture, not a claim to emulate Android fontScale.
// Snapshot every original size before applying overrides to avoid compounding
// inherited sizes. Android smoke separately uses the real native font setting.
async function scaleText(page: Page, factor: number) {
  if (factor === 1) return;
  await page.evaluate(factor => {
    document.querySelectorAll<HTMLElement>("[data-e2e-font]").forEach(element => {
      element.style.fontSize = element.dataset.e2eFont ?? "";
      delete element.dataset.e2eFont;
    });
    const sizes = [...document.querySelectorAll<HTMLElement>("body *")]
      .filter(element => element instanceof HTMLElement)
      .map(element => ({ element, size: parseFloat(getComputedStyle(element).fontSize) }));
    for (const { element, size } of sizes) {
      element.dataset.e2eFont = element.style.fontSize;
      element.style.fontSize = `${size * factor}px`;
    }
  }, factor);
}

async function assertReachable(locator: Locator) {
  await expect(locator).toBeVisible();
  await locator.scrollIntoViewIfNeeded();
  await expect.poll(() => locator.evaluate(element => {
    const rect = element.getBoundingClientRect();
    const viewport = window.visualViewport;
    const top = viewport?.offsetTop ?? 0;
    const left = viewport?.offsetLeft ?? 0;
    const right = left + (viewport?.width ?? innerWidth);
    const bottom = top + (viewport?.height ?? innerHeight);
    const x = Math.max(left + 1, Math.min(right - 1, rect.x + rect.width / 2));
    const y = Math.max(top + 1, Math.min(bottom - 1, rect.y + rect.height / 2));
    const hit = document.elementFromPoint(x, y);
    return rect.width > 0 && rect.height > 0 && rect.right > left && rect.left < right
      && rect.bottom > top && rect.top < bottom && Boolean(hit && (hit === element || element.contains(hit)));
  })).toBe(true);
}

async function assertFixedRoot(page: Page, keyboard = false, dialogOpen = false) {
  await settle(page);
  const geometry = await page.evaluate(() => {
    window.scrollTo(1000, 1000);
    return {
      x: window.scrollX, y: window.scrollY,
      roots: [document.documentElement, document.body, document.getElementById("root")!].map(element => ({
        tag: element.id || element.tagName,
        horizontalOverflow: element.scrollWidth - element.clientWidth,
        verticalOverflow: element.scrollHeight - element.clientHeight,
        top: element.scrollTop,
      })),
    };
  });
  expect(geometry, JSON.stringify(geometry)).toMatchObject({ x: 0, y: 0 });
  for (const root of geometry.roots) {
    expect(root.horizontalOverflow, JSON.stringify(geometry)).toBeLessThanOrEqual(1);
    expect(root.verticalOverflow, JSON.stringify(geometry)).toBeLessThanOrEqual(1);
    expect(root.top, JSON.stringify(geometry)).toBe(0);
  }
  if (dialogOpen) return;
  if (!keyboard) {
    await assertReachable(page.getByRole("navigation", { name: "传输格式", exact: true }));
    await assertReachable(page.getByTestId("page-main"));
    await assertReachable(page.getByTestId("page-ggwave"));
  }
  const navigation = page.getByRole("navigation", { name: "主要工作区", exact: true });
  for (const { label } of workspaces) await assertReachable(navigation.getByRole("button", { name: label, exact: false }));
}

async function chooseWorkspace(page: Page, id: typeof workspaces[number]["id"]) {
  const { label } = workspaces.find(workspace => workspace.id === id)!;
  await page.getByRole("navigation", { name: "主要工作区", exact: true })
    .getByRole("button", { name: label, exact: false }).click();
  await expect(page.locator(`#mobile-panel-${id}`)).toBeVisible();
  await settle(page);
}

const layouts = [
  { width: 320, height: 568, font: 1, colorScheme: "light" },
  { width: 390, height: 844, font: 1, colorScheme: "dark" },
  { width: 412, height: 915, font: 1, colorScheme: "light" },
  { width: 844, height: 390, font: 1, colorScheme: "dark" },
  { width: 320, height: 568, font: 1.3, colorScheme: "dark" },
  { width: 844, height: 390, font: 1.3, colorScheme: "light" },
] as const;

for (const layout of layouts) {
  test(`fixed mobile viewport ${layout.width}x${layout.height}, text ${layout.font * 100}%`, async ({ browser }, testInfo) => {
    const context = await browser.newContext({
      viewport: { width: layout.width, height: layout.height }, hasTouch: true, isMobile: true,
      colorScheme: layout.colorScheme, reducedMotion: "reduce",
    });
    const page = await context.newPage();
    const measurements: unknown[] = [];
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    try {
      await page.goto("http://127.0.0.1:5173/");
      for (const format of ["main", "ggwave"] as const) {
        if (format === "ggwave") await page.getByTestId("page-ggwave").click();
        await chooseWorkspace(page, "encode");
        await scaleText(page, layout.font);
        await assertFixedRoot(page);
        await assertReachable(page.getByTestId("message-input"));
        await page.getByTestId("message-input").fill("声织 01\n".repeat(10));
        await assertReachable(page.getByTestId("build-signal"));
        await page.getByTestId("build-signal").click();
        await chooseWorkspace(page, "signal");
        await assertReachable(page.getByTestId("loopback-button"));
        await page.getByTestId("loopback-button").click();
        await expect(page.getByTestId("decoded-text")).toHaveText("声织 01\n".repeat(10));

        for (const workspace of workspaces) {
          await chooseWorkspace(page, workspace.id);
          await scaleText(page, layout.font);
          await assertFixedRoot(page);
          const panel = page.locator(`#mobile-panel-${workspace.id}`);
          const overflow = await panel.evaluate(element => ({ width: element.clientWidth, height: element.clientHeight,
            x: element.scrollWidth - element.clientWidth, y: element.scrollHeight - element.clientHeight }));
          measurements.push({ format, workspace: workspace.id, ...overflow });
          expect(overflow.x).toBeLessThanOrEqual(1);
          if (layout.height >= 800 && layout.font === 1) expect(overflow.y, JSON.stringify({ format, workspace: workspace.id, overflow })).toBeLessThanOrEqual(1);
          const controls = panel.locator("button:visible, summary:visible, select:visible");
          for (const control of await controls.all()) await assertReachable(control);
          // Exercise real scroll routing. A constrained work area may scroll;
          // the document and the format/navigation controls must remain fixed.
          const box = await panel.boundingBox();
          expect(box).not.toBeNull();
          await page.mouse.move(layout.width / 2, Math.max(1, Math.min(layout.height - 90, box!.y + 40)));
          await page.mouse.wheel(0, 1000);
          await assertFixedRoot(page);
          await page.screenshot({ path: testInfo.outputPath(`${format}-${workspace.id}.png`), fullPage: false });
        }
      }
      expect(errors).toEqual([]);
      await writeFile(testInfo.outputPath("panel-overflow.json"), JSON.stringify(measurements, null, 2));
    } finally { await context.close(); }
  });
}

for (const viewport of [{ width: 320, height: 568 }, { width: 844, height: 390 }]) {
  test(`mobile setting sheets remain reachable and contain focus at ${viewport.width}x${viewport.height}`, async ({ browser }, testInfo) => {
    test.setTimeout(60_000);
    const context = await browser.newContext({ viewport, hasTouch: true, isMobile: true, reducedMotion: "reduce", colorScheme: "dark" });
    const page = await context.newPage();
    try {
      await page.goto("http://127.0.0.1:5173/");
      let opened = 0;
      for (const format of ["main", "ggwave"] as const) {
        if (format === "ggwave") await page.getByTestId("page-ggwave").click();
        for (const workspace of workspaces) {
          await chooseWorkspace(page, workspace.id);
          const triggers = page.locator(`#mobile-panel-${workspace.id} button[aria-haspopup=dialog]`);
          for (const trigger of await triggers.all()) {
            const title = (await trigger.innerText()).trim();
            await trigger.click();
            const dialog = page.getByRole("dialog", { name: title, exact: true });
            await expect(dialog).toBeVisible();
            await scaleText(page, 1.3);
            await settle(page);
            await assertReachable(dialog.getByRole("button", { name: "关闭", exact: true }));
            const lastContent = dialog.locator(".detail-content p, .detail-content code, .detail-content label, .detail-content button, .detail-content small").last();
            if (await lastContent.count()) await assertReachable(lastContent);
            for (let step = 0; step < 7; step++) {
              await page.keyboard.press(step % 2 ? "Shift+Tab" : "Tab");
              expect(await dialog.evaluate(element => element.contains(document.activeElement))).toBe(true);
            }
            await assertFixedRoot(page, false, true);
            await page.screenshot({ path: testInfo.outputPath(`${format}-${workspace.id}-${opened}.png`), fullPage: false });
            await page.keyboard.press("Escape");
            await expect(dialog).toHaveCount(0);
            await expect(trigger).toBeFocused();
            await assertFixedRoot(page);
            await trigger.click();
            await dialog.getByRole("button", { name: "关闭", exact: true }).click();
            await expect(dialog).toHaveCount(0);
            await expect(trigger).toBeFocused();
            opened++;
          }
        }
      }
      expect(opened).toBeGreaterThanOrEqual(8);
    } finally { await context.close(); }
  });
}

for (const viewport of [{ width: 390, height: 844, editingHeight: 390 }, { width: 844, height: 390, editingHeight: 220 }]) {
  test(`focused editor survives a reduced visible viewport at ${viewport.width}px`, async ({ browser }, testInfo) => {
    const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, hasTouch: true, isMobile: true, reducedMotion: "reduce" });
    const page = await context.newPage();
    try {
      await page.goto("http://127.0.0.1:5173/");
      for (const format of ["main", "ggwave"] as const) {
        if (format === "ggwave") await page.getByTestId("page-ggwave").click();
        await chooseWorkspace(page, "encode");
        await page.getByTestId("message-input").fill("键盘输入保持可见");
        // Headless Chrome has no native IME. Resize the visible viewport while
        // focus stays in the real editor; Android smoke covers an actual IME.
        await page.setViewportSize({ width: viewport.width, height: viewport.editingHeight });
        await expect(page.locator("html")).toHaveAttribute("data-keyboard", "true");
        await expect(page.locator(".workspace-header")).toBeHidden();
        await expect(page.locator(".command-bar")).toBeHidden();
        await assertReachable(page.getByTestId("message-input"));
        await assertReachable(page.getByTestId("build-signal"));
        await assertFixedRoot(page, true);
        await page.getByTestId("message-input").press("End");
        await page.getByTestId("message-input").pressSequentially(" IME");
        await expect(page.getByTestId("message-input")).toHaveValue("键盘输入保持可见 IME");
        await page.screenshot({ path: testInfo.outputPath(`${format}-editing.png`), fullPage: false });
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        await expect(page.locator("html")).toHaveAttribute("data-keyboard", "false");
        await assertFixedRoot(page);
        await expect(page.getByTestId("message-input")).toHaveValue("键盘输入保持可见 IME");
      }
    } finally { await context.close(); }
  });
}

test("format and workspace transitions animate normally and respect reduced motion", async ({ browser }) => {
  for (const reducedMotion of ["no-preference", "reduce"] as const) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, reducedMotion });
    const page = await context.newPage();
    try {
      await page.goto("http://127.0.0.1:5173/");
      await settle(page);
      await page.evaluate(() => {
        const probe: { duration: number; name: string }[] = [];
        Object.assign(window, { viewportMotionProbe: probe });
        document.addEventListener("click", () => {
          const collect = () => document.getAnimations().forEach(animation => {
            const timing = animation.effect?.getComputedTiming();
            if (timing && timing.iterations !== Infinity) probe.push({ duration: Number(timing.duration), name: animation.id });
          });
          requestAnimationFrame(() => { collect(); requestAnimationFrame(collect); });
        }, true);
      });
      await page.getByTestId("page-ggwave").click();
      await chooseWorkspace(page, "receive");
      await page.getByTestId("page-main").click();
      await chooseWorkspace(page, "encode");
      const durations = await page.evaluate(() => {
        // @ts-expect-error DOM animation observation fixture.
        return window.viewportMotionProbe.map((effect: { duration: number }) => effect.duration) as number[];
      });
      if (reducedMotion === "reduce") expect(durations.every(duration => duration <= 1)).toBe(true);
      else expect(durations.some(duration => duration >= 100)).toBe(true);
      await assertFixedRoot(page);
    } finally { await context.close(); }
  }
});

for (const height of [568, 844, 915]) for (const format of ["main", "ggwave"] as const) {
  test(`mobile ${format} live capture and retained recording fit ${height}px without scrolling the work area`, async ({ browser }, testInfo) => {
    test.setTimeout(60_000);
    const context = await browser.newContext({ viewport: { width: height === 568 ? 320 : height === 844 ? 390 : 412, height }, hasTouch: true, isMobile: true, reducedMotion: "reduce" });
    const page = await context.newPage();
    await page.addInitScript(() => {
      window.AudioContext = new Proxy(window.AudioContext, { construct(target, args) {
        const context = Reflect.construct(target, args) as AudioContext;
        Object.assign(window, { mobileRecorderContext: context });
        return context;
      } });
      window.Worker = new Proxy(window.Worker, { construct(target, args) {
        const worker = Reflect.construct(target, args) as Worker;
        if (String(args[0]).includes("decode.worker")) {
          const post = worker.postMessage.bind(worker);
          worker.postMessage = ((message: { samples?: Float32Array; sampleRate?: number }, transfer: Transferable[]) => {
            if (message.samples instanceof Float32Array) Object.assign(window, {
              mobileDecoderInput: { samples: message.samples.slice(), sampleRate: message.sampleRate },
            });
            post(message, transfer);
          }) as Worker["postMessage"];
        }
        return worker;
      } });
      Object.defineProperty(navigator.mediaDevices, "getUserMedia", { value: async () => {
        // The recorder creates its context before requesting a stream. Share
        // that clock: unrelated AudioContexts can add/drop 10 ms of simulated
        // MediaStream audio while synchronizing and corrupt the test signal.
        // @ts-expect-error Test observes the actual production context.
        const context: AudioContext = window.mobileRecorderContext;
        await context.resume();
        const destination = context.createMediaStreamDestination();
        Object.assign(window, { mobileCapture: { context, destination } });
        return destination.stream;
      } });
    });
    try {
      await page.goto("http://127.0.0.1:5173/");
        if (format === "ggwave") await page.getByTestId("page-ggwave").click();
        await chooseWorkspace(page, "encode");
        await page.getByTestId("message-input").fill("手机接收 OK");
        await page.getByTestId("build-signal").click();
        await chooseWorkspace(page, "signal");
        const wav = await page.locator(".signal-panel audio").evaluate(async (element: HTMLAudioElement) =>
          Array.from(new Uint8Array(await fetch(element.src).then(response => response.arrayBuffer()))));
        await chooseWorkspace(page, "receive");
        await page.getByTestId("record-button").click();
        await expect(page.getByTestId("recording-meter")).toContainText("麦克风已就绪");
        await assertFixedRoot(page);
        await assertReachable(page.getByTestId("record-button"));
        await assertReachable(page.getByRole("button", { name: "取消接收", exact: true }));
        const panelOverflow = () => page.locator("#mobile-panel-receive").evaluate(element => element.scrollHeight - element.clientHeight);
        expect(await panelOverflow()).toBeLessThanOrEqual(1);
        await page.screenshot({ path: testInfo.outputPath(`${format}-recording.png`), fullPage: false });
        await page.evaluate(async wav => {
          // The signal is produced by the actual send UI. This virtual mic
          // covers UI/Worklet/Worker behavior, not physical air transmission.
          // @ts-expect-error Virtual microphone fixture.
          const { context, destination } = window.mobileCapture;
          const original = await context.decodeAudioData(new Uint8Array(wav).buffer);
          const buffer = context.createBuffer(1, original.length + Math.ceil(context.sampleRate * 0.4), context.sampleRate);
          buffer.copyToChannel(original.getChannelData(0), 0);
          const source = context.createBufferSource(); source.buffer = buffer; source.connect(destination);
          Object.assign(window, { mobilePlayEnded: false });
          source.onended = () => Object.assign(window, { mobilePlayEnded: true }); source.start();
        }, wav);
        if (format === "main") {
          await expect.poll(() => page.evaluate(() => {
            // @ts-expect-error Actual signal playback completion.
            return window.mobilePlayEnded;
          })).toBe(true);
          await page.getByTestId("record-button").click();
        }
        try {
          await expect(page.getByTestId("decoded-text")).toHaveText("手机接收 OK");
        } catch (error) {
          await writeFile(testInfo.outputPath("sent.wav"), new Uint8Array(wav));
          if (format === "main") {
            const captured = await page.evaluate(async () => {
              // Preserve exactly what the actual decode worker received.
              // @ts-expect-error Vite serves the production WAV encoder.
              const { encodeWav } = await import("/src/core/wav.ts");
              // @ts-expect-error Observation fixture, no decode replacement.
              const { samples, sampleRate } = window.mobileDecoderInput;
              return Array.from(new Uint8Array(await encodeWav(samples, sampleRate).arrayBuffer()));
            });
            await writeFile(testInfo.outputPath("captured-worker-input.wav"), new Uint8Array(captured));
          }
          throw error;
        }
        await expect(page.getByTestId("recording-meter")).toHaveCount(0);
        expect(await panelOverflow()).toBeLessThanOrEqual(1);
        await assertFixedRoot(page);
        await page.screenshot({ path: testInfo.outputPath(`${format}-received.png`), fullPage: false });
        if (format === "ggwave") {
          const trigger = page.getByRole("button", { name: "本次录音 · 回听与导出", exact: true });
          await assertReachable(trigger);
          await trigger.click();
          const dialog = page.getByRole("dialog", { name: "本次录音 · 回听与导出", exact: true });
          await assertReachable(dialog.getByTestId("export-recording"));
          await assertReachable(dialog.getByTestId("export-diagnostic"));
          await expect(dialog.getByTestId("export-recording")).toBeEnabled();
          await expect(dialog.getByTestId("export-diagnostic")).toBeEnabled();
          const audio = dialog.locator("audio");
          await audio.evaluate(async (element: HTMLAudioElement) => {
            Object.assign(window, { mobileRecordingPlayer: element });
            element.loop = true; await element.play();
          });
          await expect.poll(() => audio.evaluate((element: HTMLAudioElement) => element.paused)).toBe(false);
          await dialog.getByRole("button", { name: "关闭", exact: true }).click();
          await expect(trigger).toBeFocused();
          expect(await page.evaluate(() => {
            // @ts-expect-error Retained real playback element verifies cleanup.
            return window.mobileRecordingPlayer.paused;
          })).toBe(true);
          await assertFixedRoot(page);
        }
    } finally { await context.close(); }
  });
}

test("a settings dialog stays within a panned visual viewport", async ({ browser }, testInfo) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, reducedMotion: "reduce" });
  const page = await context.newPage();
  try {
    await page.goto("http://127.0.0.1:5173/");
    await chooseWorkspace(page, "inspect");
    // Geometry-only regression for browser keyboard panning. Native Android
    // keyboard tests remain separate and never replace visualViewport values.
    await page.evaluate(() => {
      Object.defineProperty(visualViewport, "offsetTop", { value: 180, configurable: true });
      Object.defineProperty(visualViewport, "height", { value: 380, configurable: true });
      visualViewport!.dispatchEvent(new Event("resize"));
      visualViewport!.dispatchEvent(new Event("scroll"));
    });
    await page.getByRole("button", { name: "协议详情", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "协议详情", exact: true });
    await settle(page);
    const bounds = await dialog.boundingBox();
    expect(bounds!.y).toBeGreaterThanOrEqual(180);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(560);
    await assertReachable(dialog.getByRole("button", { name: "关闭", exact: true }));
    await assertReachable(dialog.locator(".inspector-note p"));
    await assertFixedRoot(page, false, true);
    await page.screenshot({ path: testInfo.outputPath("panned-visual-viewport.png"), fullPage: false });
    await dialog.getByRole("button", { name: "关闭", exact: true }).click();
    await expect(dialog).toHaveCount(0);
  } finally { await context.close(); }
});
