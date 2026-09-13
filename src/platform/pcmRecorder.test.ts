import { afterEach, describe, expect, it, vi } from "vitest";
import { PcmRecorder, type RecorderRuntime } from "./pcmRecorder";
import workletSource from "../worklets/pcm-recorder.js?raw";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

class InputTrack extends EventTarget {
  label = "Test microphone";
  readyState = "live";
  muted = false;
  getSettings = vi.fn<() => MediaTrackSettings>(() => ({ noiseSuppression: false }));
  stop = vi.fn(() => { this.readyState = "ended"; });
}

const recorders: PcmRecorder[] = [];
function fixture(options: { script?: boolean; maxSeconds?: number; streamPromise?: Promise<MediaStream>;
  requestWakeLock?: RecorderRuntime["requestWakeLock"] } = {}) {
  const track = new InputTrack();
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream;
  const source = { connect: vi.fn(), disconnect: vi.fn() };
  const sink = { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() };
  const worklet = {
    connect: vi.fn(), disconnect: vi.fn(), onprocessorerror: null as (() => void) | null,
    port: { onmessage: null as ((event: MessageEvent) => void) | null, postMessage: vi.fn(), close: vi.fn() },
  };
  const processor = {
    connect: vi.fn(), disconnect: vi.fn(),
    onaudioprocess: null as ((event: AudioProcessingEvent) => void) | null,
  };
  const context = {
    state: "running", sampleRate: 44_100, destination: {},
    onstatechange: null as (() => void) | null,
    resume: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(async () => { context.state = "closed"; }),
    audioWorklet: options.script ? undefined : { addModule: vi.fn().mockResolvedValue(undefined) },
    createMediaStreamSource: vi.fn(() => source), createGain: vi.fn(() => sink),
    createScriptProcessor: vi.fn(() => processor),
  };
  const page = Object.assign(new EventTarget(), { hidden: false });
  const runtime = {
    requestStream: vi.fn(() => options.streamPromise ?? Promise.resolve(stream)),
    createContext: vi.fn(() => context as unknown as AudioContext),
    createWorklet: vi.fn(() => worklet as unknown as AudioWorkletNode), page,
    requestWakeLock: options.requestWakeLock,
  } satisfies RecorderRuntime;
  const recorder = new PcmRecorder(runtime, options.maxSeconds);
  recorders.push(recorder);
  const samples = (data: number[] | Float32Array) => {
    const pcm = data instanceof Float32Array ? data : new Float32Array(data);
    if (processor.onaudioprocess) {
      processor.onaudioprocess({ inputBuffer: { getChannelData: () => pcm } } as unknown as AudioProcessingEvent);
    } else worklet.port.onmessage?.({ data: { samples: pcm } } as MessageEvent);
  };
  const flushed = () => worklet.port.onmessage?.({ data: { type: "flushed" } } as MessageEvent);
  return { recorder, runtime, context, worklet, processor, track, stream, source, sink, page, samples, flushed };
}

// Settle the browser promise stages without real waits or a DOM dependency.
async function configured() { for (let step = 0; step < 10; step += 1) await Promise.resolve(); }

afterEach(() => {
  recorders.splice(0).forEach((recorder) => recorder.cancel());
  vi.useRealTimers();
});

describe("PCM recording lifecycle", () => {
  it("delivers the first and flushed final PCM blocks to the subscriber without allowing buffer detachment", async () => {
    const f = fixture();
    const received: number[][] = [];
    const start = f.recorder.start({ deviceId: "selected-mic", onSamples: (samples, rate) => {
      expect(rate).toBe(44_100);
      received.push([...samples]);
      structuredClone(samples, { transfer: [samples.buffer] });
    } });
    await configured();
    f.samples([0.25, -0.5]);
    await start;
    const stopped = f.recorder.stop();
    f.samples([0.125]);
    f.flushed();
    const recording = await stopped;
    expect(f.runtime.requestStream).toHaveBeenCalledWith({ deviceId: "selected-mic" });
    expect(received).toEqual([[0.25, -0.5], [0.125]]);
    expect([...recording.samples]).toEqual([0.25, -0.5, 0.125]);
    expect(recording.diagnostics).toMatchObject({
      requestedDevice: "selected", blockCount: 2, completion: "stopped", sampleRate: 44_100,
      sampleCount: 3, deviceLabel: "Test microphone", backend: "AudioWorklet",
    });
  });

  it.each([false, true])("isolates subscriber failures while retaining a complete recording (async: %s)", async (async) => {
    const f = fixture();
    const start = f.recorder.start({ onSamples: () => {
      if (async) return Promise.reject(new Error("Worker unavailable"));
      throw new Error("Worker unavailable");
    } });
    await configured();
    f.samples([0.25]);
    await start;
    const stopped = f.recorder.stop();
    f.flushed();
    await expect(stopped).resolves.toMatchObject({ samples: new Float32Array([0.25]) });
    expect(f.recorder.getSnapshot().error).toBeNull();
  });

  it("retains partial PCM and sanitized diagnostics after an interruption, then clears on explicit reset", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.track.getSettings.mockReturnValue({ sampleRate: 48_000, channelCount: 2,
      deviceId: "private-input", groupId: "private-group", noiseSuppression: false });
    const start = f.recorder.start();
    await configured();
    await vi.advanceTimersByTimeAsync(250);
    f.samples([0, 0.25, -0.5, 0]);
    await start;
    await vi.advanceTimersByTimeAsync(150);
    f.track.dispatchEvent(new Event("ended"));
    const recording = f.recorder.getLastRecording();
    expect(recording?.samples).toEqual(new Float32Array([0, 0.25, -0.5, 0]));
    expect(recording?.diagnostics).toMatchObject({
      startupMs: 250, wallDurationMs: 150, completion: "error", errorCode: "interrupted",
      peak: 0.5, nonZeroFraction: 0.5, sampleRate: 44_100,
      trackSettings: { sampleRate: 48_000, channelCount: 2, noiseSuppression: false },
    });
    expect(JSON.stringify(recording?.diagnostics)).not.toContain("private-");
    expect(f.track.stop).toHaveBeenCalledOnce();
    f.recorder.reset();
    expect(f.recorder.getLastRecording()).toBeNull();
  });

  it("keeps a stable ScriptProcessor source channel through leading silence and changing levels", async () => {
    const f = fixture({ script: true });
    f.track.getSettings.mockReturnValue({ channelCount: 2 });
    const start = f.recorder.start();
    await configured();
    const block = (left: number[], right: number[]) => f.processor.onaudioprocess?.({
      inputBuffer: { numberOfChannels: 2, getChannelData: (index: number) => new Float32Array(index === 0 ? left : right) },
    } as unknown as AudioProcessingEvent);
    block([0, 0], [0, 0]);
    await start;
    block([0.01, -0.01], [0.25, -0.25]);
    const stopped = f.recorder.stop();
    block([0.75, -0.75], [0.125, -0.125]);
    const recording = await stopped;
    expect([...recording.samples]).toEqual([0, 0, 0.25, -0.25, 0.125, -0.125]);
    expect(recording.diagnostics).toMatchObject({ observedChannels: 2, selectedChannel: 1 });
    expect(f.context.createScriptProcessor).toHaveBeenCalledWith(2048, 2, 1);
  });

  it("drops queued subscriber delivery on cancel and never exposes samples from a later session", async () => {
    const f = fixture();
    const onSamples = vi.fn();
    const start = f.recorder.start({ onSamples });
    await configured();
    f.samples([0.25]);
    f.recorder.cancel();
    await start;
    expect(onSamples).not.toHaveBeenCalled();
    expect(f.recorder.getLastRecording()).toBeNull();
  });

  it("reports ready only after real PCM arrives, and preserves the final block across repeated stop calls", async () => {
    const f = fixture();
    let ready = false;
    const start = f.recorder.start().then(() => { ready = true; });
    await configured();
    expect(f.context.resume).toHaveBeenCalledOnce();
    expect(f.recorder.getSnapshot().status).toBe("requesting");
    expect(ready).toBe(false);
    f.samples([0.5, -0.5]);
    await start;
    expect(f.recorder.getSnapshot()).toMatchObject({ status: "recording", backend: "AudioWorklet", rms: 0.5 });
    const first = f.recorder.stop();
    const second = f.recorder.stop();
    expect(second).toBe(first);
    expect(f.worklet.port.postMessage).toHaveBeenCalledOnce();
    f.samples([0.25]);
    f.flushed();
    const result = await first;
    expect([...result.samples]).toEqual([0.5, -0.5, 0.25]);
    expect(result.sampleRate).toBe(44_100);
    expect(f.sink.gain.value).toBe(0);
    expect(f.track.stop).toHaveBeenCalledOnce();
    expect(f.context.close).toHaveBeenCalledOnce();
    expect(f.worklet.port.close).toHaveBeenCalledOnce();
  });

  it("releases permission granted after cancel without disturbing a newer recording", async () => {
    const delayed = deferred<MediaStream>();
    const f = fixture({ streamPromise: delayed.promise });
    const first = f.recorder.start();
    const rejected = expect(first).rejects.toMatchObject({ code: "aborted" });
    f.recorder.cancel();
    await rejected;
    expect(f.runtime.createWorklet).not.toHaveBeenCalled();
    expect(f.recorder.getSnapshot().status).toBe("idle");
    f.context.state = "running";
    f.runtime.requestStream.mockImplementation(() => Promise.resolve(f.stream));
    const second = f.recorder.start();
    await configured();
    f.samples([0.2]);
    await second;
    const lateTrack = new InputTrack();
    delayed.resolve({ getTracks: () => [lateTrack] } as unknown as MediaStream);
    await configured();
    expect(lateTrack.stop).toHaveBeenCalledOnce();
    expect(f.recorder.getSnapshot().status).toBe("recording");
    expect(f.track.stop).not.toHaveBeenCalled();
  });

  it("cancels safely while an AudioWorklet module is still loading", async () => {
    const module = deferred<void>();
    const f = fixture();
    f.context.audioWorklet!.addModule.mockReturnValue(module.promise);
    const start = f.recorder.start();
    const rejected = expect(start).rejects.toMatchObject({ code: "aborted" });
    await configured();
    f.recorder.cancel();
    await rejected;
    module.resolve();
    await configured();
    expect(f.runtime.createWorklet).not.toHaveBeenCalled();
    expect(f.track.stop).toHaveBeenCalledOnce();
    expect(f.context.close).toHaveBeenCalledOnce();
  });

  it("does not open duplicate devices while permission or recording is active", async () => {
    const f = fixture();
    const start = f.recorder.start();
    await expect(f.recorder.start()).rejects.toMatchObject({ code: "recording-failed" });
    await configured();
    f.samples([0]);
    await start;
    await expect(f.recorder.start()).rejects.toMatchObject({ code: "recording-failed" });
    expect(f.runtime.requestStream).toHaveBeenCalledOnce();
  });

  it.each(["ended", "background", "suspended"])("surfaces %s interruption immediately and releases resources", async (kind) => {
    const f = fixture();
    const start = f.recorder.start();
    await configured();
    f.samples([0.1]);
    await start;
    if (kind === "background") {
      f.page.hidden = true;
      f.page.dispatchEvent(new Event("visibilitychange"));
    } else if (kind === "suspended") {
      f.context.state = "suspended";
      f.context.onstatechange?.();
    } else f.track.dispatchEvent(new Event(kind));
    expect(f.recorder.getSnapshot()).toMatchObject({ status: "error", error: { code: "interrupted" } });
    expect(f.track.stop).toHaveBeenCalledOnce();
    expect(f.context.close).toHaveBeenCalledOnce();
  });

  it("allows microphone warm-up and transient mute but reports a sustained mute", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.track.muted = true;
    const start = f.recorder.start();
    f.page.hidden = true;
    f.page.dispatchEvent(new Event("visibilitychange"));
    await configured();
    expect(f.recorder.getSnapshot().status).toBe("requesting");
    f.page.hidden = false;
    f.track.muted = false;
    f.samples([0.1]);
    await start;
    f.track.dispatchEvent(new Event("mute"));
    await vi.advanceTimersByTimeAsync(1_000);
    f.track.dispatchEvent(new Event("unmute"));
    f.samples([0.1]);
    await vi.advanceTimersByTimeAsync(600);
    expect(f.recorder.getSnapshot().status).toBe("recording");
    f.track.dispatchEvent(new Event("mute"));
    await vi.advanceTimersByTimeAsync(1_500);
    expect(f.recorder.getSnapshot()).toMatchObject({ status: "error", error: { code: "interrupted" } });
  });

  it("rejects every waiting stop on an audio processor failure", async () => {
    const f = fixture();
    const start = f.recorder.start();
    await configured();
    f.samples([0.1]);
    await start;
    const stopped = f.recorder.stop();
    const repeated = f.recorder.stop();
    f.worklet.onprocessorerror?.();
    await expect(stopped).rejects.toMatchObject({ code: "recording-failed" });
    await expect(repeated).rejects.toMatchObject({ code: "recording-failed" });
    expect(f.recorder.getSnapshot().status).toBe("error");
    expect(f.track.stop).toHaveBeenCalledOnce();
  });

  it("times out a device that grants permission without delivering PCM", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const start = f.recorder.start();
    const rejected = expect(start).rejects.toMatchObject({ code: "no-audio" });
    await configured();
    await vi.advanceTimersByTimeAsync(8_000);
    await rejected;
    expect(f.recorder.getSnapshot().status).toBe("error");
    expect(f.track.stop).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("detects a stalled recording instead of leaving the listening indicator active", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const start = f.recorder.start();
    await configured();
    f.samples([0]);
    await start;
    await vi.advanceTimersByTimeAsync(3_500);
    expect(f.recorder.getSnapshot()).toMatchObject({ status: "error", error: { code: "interrupted" } });
    expect(f.context.close).toHaveBeenCalledOnce();
  });

  it("rejects a missing flush acknowledgement instead of decoding truncated audio", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const start = f.recorder.start();
    await configured();
    f.samples([0.1]);
    await start;
    const stopped = f.recorder.stop();
    const rejected = expect(stopped).rejects.toMatchObject({ code: "interrupted" });
    await vi.advanceTimersByTimeAsync(1_000);
    await rejected;
    expect(f.track.stop).toHaveBeenCalledOnce();
  });

  it("bounds memory, stops at the limit and retains PCM for explicit decoding", async () => {
    const f = fixture({ maxSeconds: 0.01 });
    const start = f.recorder.start();
    await configured();
    f.samples(new Float32Array(500).fill(0.25));
    await start;
    expect(f.recorder.getSnapshot()).toMatchObject({ status: "ready", elapsedSeconds: 0.01 });
    expect(f.track.stop).toHaveBeenCalledOnce();
    const recording = await f.recorder.stop();
    expect(recording.samples.length).toBe(441);
    expect(f.recorder.getSnapshot().status).toBe("processing");
  });

  it.each([false, true])("falls back to copied raw PCM when worklets are unavailable (missing API: %s)", async (missing) => {
    const f = fixture({ script: missing });
    f.context.audioWorklet?.addModule.mockRejectedValue(new Error("Module not supported"));
    const start = f.recorder.start();
    await configured();
    const input = new Float32Array([0.25, -0.5]);
    f.samples(input);
    input.fill(0); // Web Audio reuses its input buffer on the next callback.
    await start;
    expect(f.recorder.getSnapshot().backend).toBe("ScriptProcessor");
    const stopped = f.recorder.stop();
    expect(f.source.disconnect).not.toHaveBeenCalled();
    f.samples([0.125]);
    const recording = await stopped;
    expect([...recording.samples]).toEqual([0.25, -0.5, 0.125]);
    expect(recording.sampleRate).toBe(44_100);
    expect(f.context.close).toHaveBeenCalledOnce();
  });

  it("rejects a stalled ScriptProcessor final block and releases the input", async () => {
    vi.useFakeTimers();
    const f = fixture({ script: true });
    const start = f.recorder.start();
    await configured();
    f.samples([0.2]);
    await start;
    const rejected = expect(f.recorder.stop()).rejects.toMatchObject({ code: "interrupted" });
    await vi.advanceTimersByTimeAsync(1_000);
    await rejected;
    expect(f.processor.onaudioprocess).toBeNull();
    expect(f.track.stop).toHaveBeenCalledOnce();
    expect(f.context.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([false, true])("cancel/unmount rejects a pending stop and ignores late callbacks (ScriptProcessor: %s)", async (script) => {
    const f = fixture({ script });
    const start = f.recorder.start();
    await configured();
    f.samples([0.2]);
    await start;
    const rejected = expect(f.recorder.stop()).rejects.toMatchObject({ code: "aborted" });
    const oldWorkletCallback = f.worklet.port.onmessage;
    const oldScriptCallback = f.processor.onaudioprocess;
    f.recorder.cancel();
    f.recorder.cancel();
    await rejected;
    oldWorkletCallback?.({ data: { samples: new Float32Array([1]) } } as MessageEvent);
    oldScriptCallback?.({ inputBuffer: { getChannelData: () => new Float32Array([1]) } } as unknown as AudioProcessingEvent);
    expect(f.recorder.getSnapshot()).toMatchObject({ status: "idle", elapsedSeconds: 0 });
    expect(f.track.stop).toHaveBeenCalledOnce();
    expect(f.context.close).toHaveBeenCalledOnce();
  });

  it("turns a ScriptProcessor callback error into a visible failure with resource cleanup", async () => {
    const f = fixture({ script: true });
    const start = f.recorder.start();
    await configured();
    f.samples([0.2]);
    await start;
    f.processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => { throw new Error("Input unavailable"); } } } as unknown as AudioProcessingEvent);
    expect(f.recorder.getSnapshot()).toMatchObject({ status: "error", error: { code: "recording-failed" } });
    expect(f.track.stop).toHaveBeenCalledOnce();
    expect(f.context.close).toHaveBeenCalledOnce();
  });

  it("reports a device that ignores the request to disable voice enhancement", async () => {
    const f = fixture();
    f.track.getSettings.mockReturnValue({ noiseSuppression: true });
    const start = f.recorder.start();
    await configured();
    f.samples([0]);
    await start;
    expect(f.recorder.getSnapshot().warning).toContain("语音增强");
  });
});

describe("recording Screen Wake Lock", () => {
  it("requests only after PCM is ready in the foreground, and releases on normal stop", async () => {
    const release = vi.fn().mockResolvedValue(undefined);
    const requestWakeLock = vi.fn().mockResolvedValue({ release });
    const f = fixture({ requestWakeLock });
    const start = f.recorder.start();
    await configured();
    expect(requestWakeLock).not.toHaveBeenCalled();
    f.page.hidden = true; // The native permission sheet has not returned yet.
    f.samples([0]);
    await start;
    expect(requestWakeLock).not.toHaveBeenCalled();
    f.page.hidden = false;
    f.page.dispatchEvent(new Event("visibilitychange"));
    f.page.dispatchEvent(new Event("visibilitychange"));
    await configured();
    expect(requestWakeLock).toHaveBeenCalledOnce();
    const stopped = f.recorder.stop();
    f.flushed();
    await stopped;
    f.recorder.cancel();
    expect(release).toHaveBeenCalledOnce();
  });

  it.each(["cancel", "error", "limit", "stop"])("releases a delayed grant after %s", async (completion) => {
    const delayedLock = deferred<{ release(): Promise<void> }>();
    const release = vi.fn().mockResolvedValue(undefined);
    const requestWakeLock = vi.fn(() => delayedLock.promise);
    const f = fixture({ requestWakeLock, maxSeconds: completion === "limit" ? 0.01 : 120 });
    const start = f.recorder.start();
    await configured();
    f.samples(new Float32Array(500));
    await start;
    expect(requestWakeLock).toHaveBeenCalledOnce();
    if (completion === "cancel") f.recorder.cancel();
    else if (completion === "error") {
      f.page.hidden = true;
      f.page.dispatchEvent(new Event("visibilitychange"));
    } else if (completion === "stop") {
      const stopped = f.recorder.stop();
      f.flushed();
      await stopped;
    }
    delayedLock.resolve({ release });
    await configured();
    expect(release).toHaveBeenCalledOnce();
    f.recorder.cancel();
    expect(release).toHaveBeenCalledOnce();
  });

  it.each([false, true])("keeps reception working when Wake Lock is denied (synchronous: %s)", async (synchronous) => {
    const requestWakeLock = vi.fn(() => {
      if (synchronous) throw new Error("Screen Wake Lock unavailable");
      return Promise.reject(new Error("Battery saver policy"));
    });
    const f = fixture({ requestWakeLock });
    const start = f.recorder.start();
    await configured();
    f.samples([0.5]);
    await start;
    await configured();
    expect(f.recorder.getSnapshot()).toMatchObject({ status: "recording", error: null });
    const stopped = f.recorder.stop();
    f.flushed();
    await expect(stopped).resolves.toMatchObject({ samples: new Float32Array([0.5]) });
  });

  it.each([false, true])("does not block microphone cleanup if Wake Lock release fails (synchronous: %s)", async (synchronous) => {
    const release = vi.fn(() => {
      if (synchronous) throw new Error("Already released");
      return Promise.reject(new Error("Already released"));
    });
    const f = fixture({ requestWakeLock: vi.fn().mockResolvedValue({ release }) });
    const start = f.recorder.start();
    await configured();
    f.samples([0]);
    await start;
    await configured();
    f.recorder.cancel();
    await configured();
    expect(release).toHaveBeenCalledOnce();
    expect(f.track.stop).toHaveBeenCalledOnce();
    expect(f.context.close).toHaveBeenCalledOnce();
    expect(f.recorder.getSnapshot().status).toBe("idle");
  });
});

it("the actual worklet preserves all PCM samples across block boundaries and flushes the remainder", () => {
  type Processor = { process(inputs: Float32Array[][]): boolean; port: { onmessage(event: { data: { type: string } }): void } };
  let ProcessorClass!: new () => Processor;
  const messages: { samples?: Float32Array; type?: string }[] = [];
  // Evaluate the shipped worklet source with only its host API substituted.
  new Function("AudioWorkletProcessor", "registerProcessor", workletSource)(
    class { port = { postMessage: (message: { samples?: Float32Array; type?: string }) => messages.push(message) }; },
    (_name: string, constructor: new () => Processor) => { ProcessorClass = constructor; },
  );
  const processor = new ProcessorClass();
  const input = Float32Array.from({ length: 5_003 }, (_, index) => Math.sin(index * 0.37));
  processor.process([]);
  expect(messages).toHaveLength(0);
  for (let offset = 0; offset < input.length; offset += 128) processor.process([[input.slice(offset, offset + 128)]]);
  processor.port.onmessage({ data: { type: "flush" } });
  const captured = messages.flatMap((message) => message.samples ? [...message.samples] : []);
  expect(captured).toEqual([...input]);
  expect(messages.at(-1)).toEqual({ type: "flushed" });
  expect(processor.process([[new Float32Array(128)]])).toBe(false);
});

it("the shipped worklet preserves opposite-polarity stereo and locks after leading silence", () => {
  type Processor = { process(inputs: Float32Array[][]): boolean; port: { onmessage(event: { data: { type: string } }): void } };
  let ProcessorClass!: new () => Processor;
  const messages: { samples?: Float32Array; selectedChannel?: number; observedChannels?: number }[] = [];
  new Function("AudioWorkletProcessor", "registerProcessor", workletSource)(
    class { port = { postMessage: (message: typeof messages[number]) => messages.push(message) }; },
    (_name: string, constructor: new () => Processor) => { ProcessorClass = constructor; },
  );
  const processor = new ProcessorClass();
  const zeros = new Float32Array(2048);
  processor.process([[zeros, zeros]]);
  const tone = Float32Array.from({ length: 2048 }, (_, index) => Math.sin(index * 0.37) * 0.25);
  processor.process([[tone.map((sample) => -sample * 0.5), tone]]);
  // The first selected channel remains stable even if the other later gets louder.
  processor.process([[tone.map((sample) => -sample * 2), tone]]);
  processor.process([[tone.slice(0, 17), tone.slice(0, 17)]]);
  processor.port.onmessage({ data: { type: "flush" } });
  const blocks = messages.filter((message) => message.samples);
  expect(blocks[0].samples).toEqual(zeros);
  expect(blocks[1]).toMatchObject({ observedChannels: 2, selectedChannel: 1 });
  expect(blocks[1].samples).toEqual(tone);
  expect(blocks[2].samples).toEqual(tone);
  expect(blocks[3].samples).toEqual(tone.slice(0, 17));
});
