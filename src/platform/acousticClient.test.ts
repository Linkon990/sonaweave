import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildAcousticMessage, decodeAcousticRecording, startLiveDecoder } from "./acousticClient";
import type { AcousticReport } from "../acoustic/messages";

const report: AcousticReport = { mode: "ggwave", text: "hello", decodedBytes: new Uint8Array([1]), verification: "reed-solomon" };
class TestWorker {
  static instances: TestWorker[] = [];
  static configure: ((worker: TestWorker) => void) | undefined;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;
  postMessage = vi.fn();
  terminate = vi.fn();
  constructor() { TestWorker.instances.push(this); TestWorker.configure?.(this); }
  emit(data: unknown) { this.onmessage?.({ data } as MessageEvent); }
}
beforeEach(() => {
  TestWorker.instances = []; TestWorker.configure = undefined;
  vi.stubGlobal("Worker", TestWorker);
  vi.useFakeTimers();
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
const latest = () => TestWorker.instances.at(-1)!;

describe("complete acoustic worker jobs", () => {
  it("does not allocate a worker for an already cancelled request", async () => {
    const controller = new AbortController(); controller.abort();
    await expect(buildAcousticMessage("hello", "normal", controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    await expect(decodeAcousticRecording(new Float32Array(1), 48_000, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(TestWorker.instances).toHaveLength(0);
  });

  it("transfers a disposable copy and returns a decoded report with resources released", async () => {
    TestWorker.configure = (worker) => worker.postMessage.mockImplementation((command, transfer) => structuredClone(command, { transfer }));
    const original = new Float32Array([0.2, -0.2]);
    const result = decodeAcousticRecording(original, 48_000, new AbortController().signal);
    expect(original.length).toBe(2);
    latest().emit({ type: "decoded", report });
    await expect(result).resolves.toEqual(report);
    expect(latest().terminate).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels running work once and ignores a stale completion", async () => {
    const controller = new AbortController();
    const result = buildAcousticMessage("hello", "normal", controller.signal);
    const rejected = expect(result).rejects.toMatchObject({ name: "AbortError" });
    const stale = latest().onmessage;
    controller.abort();
    stale?.({ data: { type: "encoded", transmission: {} } } as MessageEvent);
    await rejected;
    expect(latest().terminate).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["worker", "message", "invalid", "unexpected", "posting"])("releases jobs after %s failures", async (kind) => {
    if (kind === "posting") TestWorker.configure = (worker) => worker.postMessage.mockImplementation(() => { throw new Error("post failed"); });
    const result = decodeAcousticRecording(new Float32Array(1), 48_000, new AbortController().signal);
    const rejected = expect(result).rejects.toBeInstanceOf(Error);
    if (kind === "worker") latest().onerror?.();
    else if (kind === "message") latest().onmessageerror?.();
    else if (kind === "invalid") latest().emit(null);
    else if (kind === "unexpected") latest().emit({ type: "ready" });
    await rejected;
    expect(latest().terminate).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("terminates a timed out job and detaches abort handling", async () => {
    const controller = new AbortController();
    const result = buildAcousticMessage("hello", "normal", controller.signal);
    const rejected = expect(result).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(45_000);
    await rejected;
    controller.abort();
    expect(latest().terminate).toHaveBeenCalledOnce();
  });
});

describe("live acoustic worker lifecycle", () => {
  it("preserves the real initialization error instead of replacing it with cancellation", async () => {
    const onError = vi.fn();
    const live = startLiveDecoder(vi.fn(), onError);
    const rejected = expect(live.initialized).rejects.toThrow("WASM loading failed");
    latest().emit({ type: "error", error: "WASM loading failed" });
    await rejected;
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "WASM loading failed" }));
    expect(latest().terminate).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("queues PCM after preparation and delivers only the first report", async () => {
    const onReport = vi.fn();
    const live = startLiveDecoder(onReport, vi.fn());
    const samples = new Float32Array([0.2]);
    live.push(samples, 44_100);
    expect(latest().postMessage.mock.calls[0][0]).toEqual({ type: "prepare" });
    expect(latest().postMessage.mock.calls[1][0]).toEqual({ type: "chunk", samples, sampleRate: 44_100 });
    latest().emit({ type: "ready" }); await live.initialized;
    const stale = latest().onmessage;
    latest().emit({ type: "decoded", report });
    stale?.({ data: { type: "decoded", report } } as MessageEvent);
    live.push(new Float32Array(1), 48_000);
    live.close();
    expect(onReport).toHaveBeenCalledExactlyOnceWith(report);
    expect(latest().postMessage).toHaveBeenCalledTimes(2);
    expect(latest().terminate).toHaveBeenCalledOnce();
  });

  it("can cancel initialization without reporting a decoding failure", async () => {
    const onError = vi.fn();
    const live = startLiveDecoder(vi.fn(), onError);
    live.close(); live.close();
    await expect(live.initialized).rejects.toMatchObject({ name: "AbortError" });
    expect(onError).not.toHaveBeenCalled();
    expect(latest().terminate).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["constructor", "prepare", "chunk"])("reports %s exceptions and closes safely", async (stage) => {
    if (stage === "constructor") vi.stubGlobal("Worker", class { constructor() { throw new Error("constructor failed"); } });
    if (stage === "prepare") TestWorker.configure = (worker) => worker.postMessage.mockImplementation(() => { throw new Error("prepare failed"); });
    const onError = vi.fn();
    const live = startLiveDecoder(vi.fn(), onError);
    const rejected = expect(live.initialized).rejects.toThrow(`${stage} failed`);
    if (stage === "chunk") {
      latest().postMessage.mockImplementation(() => { throw new Error("chunk failed"); });
      live.push(new Float32Array(1), 48_000);
    }
    await vi.runAllTicks(); await rejected;
    expect(onError).toHaveBeenCalledOnce();
    if (stage !== "constructor") expect(latest().terminate).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("flushes once, accepts the final decoded packet, and never sends later PCM", async () => {
    const onReport = vi.fn();
    const live = startLiveDecoder(onReport, vi.fn());
    latest().emit({ type: "ready" }); await live.initialized;
    live.push(new Float32Array(17), 48_000);
    live.finish(); live.finish();
    live.push(new Float32Array(9), 48_000);
    expect(latest().postMessage.mock.calls.map(([command]) => command.type)).toEqual(["prepare", "chunk", "finish"]);
    latest().emit({ type: "decoded", report });
    expect(onReport).toHaveBeenCalledExactlyOnceWith(report);
    expect(latest().terminate).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("finishes an empty result without fabricating success", async () => {
    const onReport = vi.fn(); const onError = vi.fn();
    const live = startLiveDecoder(onReport, onError);
    live.finish();
    latest().emit({ type: "ready" }); await live.initialized;
    expect(vi.getTimerCount()).toBe(1);
    latest().emit({ type: "finished" });
    expect(onReport).not.toHaveBeenCalled(); expect(onError).not.toHaveBeenCalled();
    expect(latest().terminate).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("times out initialization with its real cause", async () => {
    const onError = vi.fn();
    const live = startLiveDecoder(vi.fn(), onError);
    const rejected = expect(live.initialized).rejects.toThrow("initialization timed out");
    await vi.advanceTimersByTimeAsync(15_000); await rejected;
    expect(onError).toHaveBeenCalledOnce();
    expect(latest().terminate).toHaveBeenCalledOnce();
  });
});
