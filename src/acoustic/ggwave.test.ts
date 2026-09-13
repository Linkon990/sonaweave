import { describe, expect, it } from "vitest";
import createGgWave, { type GgWaveModule } from "ggwave";
import { simulateChannel } from "../core/channel";
import {
  createGgWaveReceiver, decodeGgWave, encodeGgWaveMessage, GGWAVE_MAX_BYTES,
  type GgWaveReport, type GgWaveSpeed,
} from "./ggwave";

const speeds: GgWaveSpeed[] = ["normal", "fast", "fastest"];
const streamingCases = speeds.flatMap(speed => [44_100, 48_000].map(rate => ({ speed, rate })));
let officialLibraryPromise: Promise<GgWaveModule> | undefined;

async function encodeOfficial(text: string, speed: GgWaveSpeed): Promise<Float32Array> {
  officialLibraryPromise ??= createGgWave({ print: () => {}, printErr: () => {} });
  const library = await officialLibraryPromise;
  library.disableLog();
  const parameters = library.getDefaultParameters();
  parameters.sampleRateInp = parameters.sampleRateOut = 48_000;
  parameters.sampleFormatInp = parameters.sampleFormatOut = library.SampleFormat.GGWAVE_SAMPLE_FORMAT_F32;
  parameters.operatingMode = library.GGWAVE_OPERATING_MODE_TX;
  const instance = library.init(parameters);
  try {
    const protocol = library.ProtocolId[`GGWAVE_PROTOCOL_AUDIBLE_${speed.toUpperCase()}`];
    return new Float32Array(Uint8Array.from(library.encode(instance, new TextEncoder().encode(text), protocol, 30)).buffer);
  } finally { library.free(instance); }
}

function resample(input: Float32Array, rate: number): Float32Array {
  const output = new Float32Array(Math.ceil(input.length * rate / 48_000));
  for (let index = 0; index < output.length; index++) {
    const position = index * 48_000 / rate;
    const left = Math.floor(position);
    const fraction = position - left;
    output[index] = (input[left] ?? 0) * (1 - fraction) + (input[left + 1] ?? 0) * fraction;
  }
  return output;
}

function delayed(input: Float32Array, rate: number): Float32Array {
  const offset = Math.round(rate * 1.137);
  const output = new Float32Array(offset + input.length + Math.round(rate * 0.6));
  output.set(input, offset);
  return output;
}

async function stream(input: Float32Array, rate: number, chunk: number): Promise<GgWaveReport | null> {
  const receiver = await createGgWaveReceiver(rate);
  let report: GgWaveReport | null = null;
  try {
    for (let index = 0; index < input.length; index += chunk) {
      const next = receiver.push(input.subarray(index, index + chunk));
      report ??= next;
    }
    report ??= receiver.finish();
    return report;
  } finally { receiver.close(); }
}

describe("real ggwave WASM interoperability", () => {
  it.each(streamingCases)("round trips multilingual UTF-8 using $speed at $rate Hz", async ({ speed, rate }) => {
    const text = "你好 SonaWeave 🙂 / 42";
    const transmission = await encodeGgWaveMessage(text, speed);
    const report = await decodeGgWave(resample(transmission.signal.samples, rate), rate);
    expect(report.text).toBe(text);
    expect(report.decodedBytes).toEqual(new TextEncoder().encode(text));
    expect(report.verification).toBe("reed-solomon");
    expect(transmission.signal.durationSeconds).toBeGreaterThan(1);
  });

  it.each(streamingCases)("accepts 128-sample worklet chunks in $speed at $rate Hz with arbitrary leading silence", async ({ speed, rate }) => {
    const text = "128 samples / 接收 🙂";
    const { signal } = await encodeGgWaveMessage(text, speed);
    const report = await stream(delayed(resample(signal.samples, rate), rate), rate, 128);
    expect(report?.text).toBe(text);
  });

  it.each(streamingCases)("accepts irregular chunks and a 140-byte message in $speed at $rate Hz", async ({ speed, rate }) => {
    const text = "中".repeat(44) + "🙂🙂";
    expect(new TextEncoder().encode(text)).toHaveLength(GGWAVE_MAX_BYTES);
    const { signal } = await encodeGgWaveMessage(text, speed);
    const report = await stream(delayed(resample(signal.samples, rate), rate), rate, 777);
    expect(report?.text).toBe(text);
  });

  it("recovers quiet audio with deterministic noise and echo", async () => {
    const text = "quiet microphone";
    const { signal } = await encodeGgWaveMessage(text);
    const distorted = simulateChannel(signal.samples, 48_000, { snrDb: 12, dropoutPercent: 0, echoPercent: 30 });
    for (let index = 0; index < distorted.length; index++) distorted[index] *= 0.02;
    expect((await decodeGgWave(delayed(distorted, 48_000), 48_000)).text).toBe(text);
  });

  it("decodes a GibberLink-compatible FASTEST packet from a separate ggwave instance", async () => {
    const library = await createGgWave({ print: () => {}, printErr: () => {} });
    library.disableLog();
    const instance = library.init(library.getDefaultParameters());
    try {
      const text = "AB$hello GibberLink";
      const bytes = Uint8Array.from(library.encode(instance, text, library.ProtocolId.GGWAVE_PROTOCOL_AUDIBLE_FASTEST, 10));
      const report = await decodeGgWave(new Float32Array(bytes.buffer), 48_000);
      // The sender ID is application data: preserve it rather than stripping
      // an arbitrary user's text containing a dollar sign.
      expect(report.text).toBe(text);
    } finally { library.free(instance); }
  });

  it("retains owned audio and decoded bytes after subsequent WASM operations", async () => {
    const first = await encodeGgWaveMessage("first");
    const sampleCopy = first.signal.samples.slice();
    const report = await decodeGgWave(first.signal.samples, 48_000);
    const second = await encodeGgWaveMessage("a different second message");
    await decodeGgWave(second.signal.samples, 48_000);
    expect(first.signal.samples).toEqual(sampleCopy);
    expect(new TextDecoder().decode(report.decodedBytes)).toBe("first");
  });

  it.each(speeds)("does not mistake text 'first' for an end marker in %s", async (speed) => {
    const { signal } = await encodeGgWaveMessage("first", speed);
    expect((await decodeGgWave(signal.samples, 48_000)).text).toBe("first");
  });

  it("uses actual protocol speeds with decreasing duration at the same 48 kHz sample rate", async () => {
    const transmissions = await Promise.all(speeds.map(speed => encodeGgWaveMessage("你好，声织已就绪。", speed)));
    expect(transmissions.map(transmission => transmission.signal.sampleRate)).toEqual([48_000, 48_000, 48_000]);
    expect(transmissions.map(transmission => transmission.speed)).toEqual(speeds);
    // 5/4/3 data frames per group, preserving the original 48 kHz time base,
    // marker lengths and Fastest waveform. Playback-rate tricks cannot pass.
    expect(transmissions.map(transmission => transmission.signal.samples.length)).toEqual([104_448, 90_112, 75_776]);
    expect(transmissions[0].signal.durationSeconds).toBeGreaterThan(transmissions[1].signal.durationSeconds);
    expect(transmissions[1].signal.durationSeconds).toBeGreaterThan(transmissions[2].signal.durationSeconds);
    for (const transmission of transmissions) {
      expect((await decodeGgWave(transmission.signal.samples, transmission.signal.sampleRate)).text).toBe(transmission.text);
    }
  });

  it("defaults to the four-frame standard protocol", async () => {
    const text = "default fast / 默认";
    const implicit = await encodeGgWaveMessage(text);
    const explicit = await encodeGgWaveMessage(text, "fast");
    expect(implicit.speed).toBe("fast");
    expect(implicit.signal.samples).toEqual(explicit.signal.samples);
  });

  it.each(["first", "你好，声织已就绪。", "中".repeat(44) + "🙂🙂"])("preserves every upstream Fastest PCM byte for %s", async (text) => {
    const official = await encodeOfficial(text, "fastest");
    const transmission = await encodeGgWaveMessage(text, "fastest");
    const actualBytes = new Uint8Array(transmission.signal.samples.buffer);
    const expectedBytes = new Uint8Array(official.buffer);
    expect(actualBytes.length).toBe(expectedBytes.length);
    expect(actualBytes.every((byte, index) => byte === expectedBytes[index])).toBe(true);
  });

  it.each(streamingCases)("still receives upstream $speed recordings at $rate Hz", async ({ speed, rate }) => {
    const text = "旧版录音 / upstream 🙂";
    const official = await encodeOfficial(text, speed);
    expect((await stream(delayed(resample(official, rate), rate), rate, 128))?.text).toBe(text);
  });

  it.each(speeds)("does not accept a wrong-speed short codeword in %s", async speed => {
    // Upstream's first-RS-success policy misread these ordinary short packets,
    // including valid UTF-8 NULs in place of "ok" and "42".
    for (const text of ["one", "two", "yes", "ok", "42", " ", "\u0000"]) {
      const { signal } = await encodeGgWaveMessage(text, speed);
      expect((await stream(delayed(signal.samples, 48_000), 48_000, 128))?.text).toBe(text);
    }
  });

  it.each(speeds)("resolves ambiguous upstream short %s packets using the recorded tones", async speed => {
    for (const text of ["one", "yes", "ok", "42", "A".repeat(12)]) {
      const official = await encodeOfficial(text, speed);
      expect((await stream(delayed(official, 48_000), 48_000, 777))?.text).toBe(text);
    }
  });

  it.each(["normal", "fast"] as const)("shortens %s without changing the Fastest waveform or sample rate", async speed => {
    const text = "中".repeat(44) + "🙂🙂";
    const official = await encodeOfficial(text, speed);
    const transmission = await encodeGgWaveMessage(text, speed);
    expect(transmission.signal.samples.length).toBeLessThan(official.length);
    expect(transmission.signal.sampleRate).toBe(48_000);
    expect((await decodeGgWave(transmission.signal.samples, 48_000)).text).toBe(text);
  });

  it("continues across separate messages within one receiver", async () => {
    const first = await encodeGgWaveMessage("one");
    const second = await encodeGgWaveMessage("two");
    const receiver = await createGgWaveReceiver(48_000);
    try {
      expect(receiver.push(delayed(first.signal.samples, 48_000))?.text).toBe("one");
      expect(receiver.push(delayed(second.signal.samples, 48_000))?.text).toBe("two");
    } finally { receiver.close(); }
  });

  it("does not display non-UTF-8 binary packets and still receives the next text", async () => {
    const library = await createGgWave({ print: () => {}, printErr: () => {} });
    library.disableLog();
    const instance = library.init(library.getDefaultParameters());
    const receiver = await createGgWaveReceiver(48_000);
    try {
      const bytes = Uint8Array.from(library.encode(instance, new Uint8Array([0xff, 0xfe, 0x80]), library.ProtocolId.GGWAVE_PROTOCOL_AUDIBLE_NORMAL, 20));
      expect(receiver.push(delayed(new Float32Array(bytes.buffer), 48_000))).toBeNull();
      const next = await encodeGgWaveMessage("valid after binary");
      expect(receiver.push(delayed(next.signal.samples, 48_000))?.text).toBe("valid after binary");
    } finally { library.free(instance); receiver.close(); }
  });
});

describe("ggwave validation and lifecycle", () => {
  it("rejects oversize UTF-8 before the library can silently truncate it", async () => {
    await expect(encodeGgWaveMessage("A".repeat(141))).rejects.toThrow("140");
    await expect(encodeGgWaveMessage("中".repeat(47))).rejects.toThrow("140");
  });

  it("rejects empty messages and recordings", async () => {
    await expect(encodeGgWaveMessage("")).rejects.toThrow();
    await expect(decodeGgWave(new Float32Array(), 48_000)).rejects.toThrow("录音为空");
  });

  it("rejects silence and incomplete packets without reporting a decoded message", async () => {
    await expect(decodeGgWave(new Float32Array(48_000), 48_000)).rejects.toThrow("尚未收到完整");
    const { signal } = await encodeGgWaveMessage("complete packet needed");
    await expect(decodeGgWave(signal.samples.slice(0, signal.samples.length / 2), 48_000)).rejects.toThrow("尚未收到完整");
  });

  it.each([0, Number.NaN, 192_000])("rejects invalid input rate %s", async (rate) => {
    await expect(createGgWaveReceiver(rate)).rejects.toThrow("采样率");
  });

  it("flushes the tail once and releases a receiver idempotently", async () => {
    const receiver = await createGgWaveReceiver(48_000);
    expect(receiver.push(new Float32Array(51))).toBeNull();
    expect(receiver.finish()).toBeNull();
    expect(receiver.finish()).toBeNull();
    expect(() => receiver.push(new Float32Array(128))).toThrow("已结束");
    receiver.close();
    receiver.close();
    expect(receiver.finish()).toBeNull();
  });

  it("rejects non-finite PCM", async () => {
    const receiver = await createGgWaveReceiver(48_000);
    try { expect(() => receiver.push(new Float32Array([Number.NaN]))).toThrow("无效"); }
    finally { receiver.close(); }
  });
});
