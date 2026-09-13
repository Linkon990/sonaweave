import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const engine = vi.hoisted(() => ({
  createGgWaveReceiver: vi.fn(), decodeGgWave: vi.fn(), encodeGgWaveMessage: vi.fn(), decodeSamplesAuto: vi.fn(),
}));
vi.mock("../acoustic/ggwave", () => engine);
vi.mock("../core/protocol", () => ({ decodeSamplesAuto: engine.decodeSamplesAuto }));

const report = { mode: "ggwave", text: "received", decodedBytes: new Uint8Array([1]), verification: "reed-solomon" };
const receiver = { push: vi.fn(), finish: vi.fn(), close: vi.fn() };
let host: { onmessage: ((event: MessageEvent) => void) | null; postMessage: ReturnType<typeof vi.fn> };
async function settle() { for (let index = 0; index < 30; index++) await Promise.resolve(); }
function send(data: object) { host.onmessage?.({ data } as MessageEvent); }

beforeEach(async () => {
  vi.resetModules(); vi.clearAllMocks();
  receiver.push.mockReturnValue(null); receiver.finish.mockReturnValue(null);
  engine.createGgWaveReceiver.mockResolvedValue(receiver);
  host = { onmessage: null, postMessage: vi.fn() }; vi.stubGlobal("self", host);
  await import("../workers/acoustic.worker");
});
afterEach(() => vi.unstubAllGlobals());

describe("acoustic worker message ordering and validation", () => {
  it("retains the PCM head and order while engine initialization is pending", async () => {
    let ready!: (value: typeof receiver) => void;
    engine.createGgWaveReceiver.mockReturnValueOnce(new Promise((resolve) => { ready = resolve; }));
    send({ type: "prepare" });
    const first = new Float32Array([0.1]); const second = new Float32Array([0.2]);
    send({ type: "chunk", samples: first, sampleRate: 48_000 });
    send({ type: "chunk", samples: second, sampleRate: 48_000 });
    await settle(); expect(receiver.push).not.toHaveBeenCalled();
    ready(receiver); await settle();
    expect(receiver.push.mock.calls.map(([samples]) => samples)).toEqual([first, second]);
    expect(host.postMessage).toHaveBeenCalledWith({ type: "ready" });
  });

  it("finishes the receiver only after the final queued PCM and publishes a tail-only result", async () => {
    receiver.finish.mockReturnValue(report);
    send({ type: "prepare" });
    const tail = new Float32Array(17);
    send({ type: "chunk", samples: tail, sampleRate: 48_000 });
    send({ type: "finish" }); send({ type: "finish" });
    send({ type: "chunk", samples: new Float32Array(2), sampleRate: 48_000 });
    await settle();
    expect(receiver.push).toHaveBeenCalledExactlyOnceWith(tail);
    expect(receiver.finish).toHaveBeenCalledOnce();
    expect(receiver.close).toHaveBeenCalledOnce();
    expect(host.postMessage).toHaveBeenLastCalledWith({ type: "decoded", report });
    expect(receiver.push.mock.invocationCallOrder[0]).toBeLessThan(receiver.finish.mock.invocationCallOrder[0]);
  });

  it("finishes silence without claiming a decoded packet", async () => {
    send({ type: "prepare" }); send({ type: "finish" }); await settle();
    expect(host.postMessage).toHaveBeenLastCalledWith({ type: "finished" });
    expect(receiver.close).toHaveBeenCalledOnce();
  });

  it("stops all queued work after initialization fails", async () => {
    engine.createGgWaveReceiver.mockRejectedValueOnce(new Error("WASM failed"));
    send({ type: "prepare" });
    send({ type: "chunk", samples: new Float32Array(1), sampleRate: 48_000 });
    await settle();
    expect(engine.createGgWaveReceiver).toHaveBeenCalledOnce();
    expect(receiver.push).not.toHaveBeenCalled();
    expect(host.postMessage).toHaveBeenCalledExactlyOnceWith({ type: "error", error: "WASM failed" });
  });

  it("adapts once to the actual input rate and reports later rate changes instead of discarding the packet head", async () => {
    send({ type: "prepare" });
    send({ type: "chunk", samples: new Float32Array(10), sampleRate: 44_100 });
    send({ type: "chunk", samples: new Float32Array(10), sampleRate: 48_000 });
    await settle();
    expect(engine.createGgWaveReceiver.mock.calls.map(([rate]) => rate)).toEqual([48_000, 44_100]);
    expect(receiver.push).toHaveBeenCalledOnce();
    expect(host.postMessage).toHaveBeenLastCalledWith({ type: "error", error: expect.stringContaining("采样率发生变化") });
  });

  it.each([192_000, NaN, 0])("rejects unsupported rate %s before passing it to either decoder", async (sampleRate) => {
    send({ type: "decode", samples: new Float32Array(1), sampleRate }); await settle();
    expect(engine.decodeGgWave).not.toHaveBeenCalled(); expect(engine.decodeSamplesAuto).not.toHaveBeenCalled();
    expect(host.postMessage).toHaveBeenCalledWith({ type: "error", error: expect.stringContaining("8–96") });
  });

  it("rejects non-finite PCM before both decoders", async () => {
    send({ type: "decode", samples: new Float32Array([NaN]), sampleRate: 48_000 }); await settle();
    expect(engine.decodeGgWave).not.toHaveBeenCalled(); expect(engine.decodeSamplesAuto).not.toHaveBeenCalled();
    expect(host.postMessage).toHaveBeenLastCalledWith({ type: "error", error: expect.stringContaining("无效") });
  });

  it("bounds the whole streaming session rather than each individual block", async () => {
    const samples = new Float32Array(8_000 * 61);
    send({ type: "prepare" });
    send({ type: "chunk", samples, sampleRate: 8_000 });
    send({ type: "chunk", samples, sampleRate: 8_000 });
    await settle();
    expect(receiver.push).toHaveBeenCalledOnce();
    expect(host.postMessage).toHaveBeenLastCalledWith({ type: "error", error: expect.stringContaining("120 秒") });
  });

  it("returns a valid legacy packet when ggwave cannot recover a recording", async () => {
    engine.decodeGgWave.mockRejectedValue(new Error("No ggwave packet"));
    const legacy = { mode: "fsk", text: "old sender" };
    engine.decodeSamplesAuto.mockReturnValue(legacy);
    send({ type: "decode", samples: new Float32Array(10), sampleRate: 48_000 }); await settle();
    expect(host.postMessage).toHaveBeenLastCalledWith({ type: "decoded", report: legacy });
  });

  it("preserves both decoder causes when a recording fails all modes", async () => {
    engine.decodeGgWave.mockRejectedValue(new Error("No ggwave packet"));
    engine.decodeSamplesAuto.mockImplementation(() => { throw new Error("No old training"); });
    send({ type: "decode", samples: new Float32Array(10), sampleRate: 48_000 }); await settle();
    expect(host.postMessage).toHaveBeenLastCalledWith({ type: "error", error: expect.stringMatching(/No ggwave packet.*No old training/) });
  });
});
