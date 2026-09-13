import { describe, expect, it } from "vitest";
import { protectWithHamming, recoverWithHamming } from "./hamming";
import { createFrame, parseFrame } from "./frame";
import { compressLzw, decompressLzw } from "./lzw";
import { modulate, type ModemMode } from "./modem";
import { decodeSamples, decodeSamplesAuto, encodeMessage } from "./protocol";
import { simulateChannel } from "./channel";

// Fixed fixtures model recording alignment and sample clocks, not codec internals.
function resample(input: Float32Array, ratio: number): Float32Array {
  const output = new Float32Array(Math.floor(input.length * ratio));
  for (let index = 0; index < output.length; index += 1) {
    const position = index / ratio;
    const left = Math.floor(position);
    const fraction = position - left;
    output[index] = (input[left] ?? 0) * (1 - fraction) + (input[left + 1] ?? 0) * fraction;
  }
  return output;
}

function join(...segments: Float32Array[]): Float32Array {
  const output = new Float32Array(segments.reduce((length, segment) => length + segment.length, 0));
  let offset = 0;
  for (const segment of segments) {
    output.set(segment, offset);
    offset += segment.length;
  }
  return output;
}

// A fixed digital room/phone fixture, not an over-the-air measurement. The
// filtering and 7 ms reflection displace envelope minima without clipping or
// destroying the carrier. Uniform attenuation of a clean waveform misses this.
function filteredReflection(input: Float32Array, clockRatio: number): Float32Array {
  const lowPass = (samples: Float32Array, frequency: number) => {
    const coefficient = 1 - Math.exp(-2 * Math.PI * frequency / 48_000);
    let state = 0;
    return samples.map((sample) => (state += coefficient * (sample - state)));
  };
  const low = lowPass(lowPass(input, 2_400), 2_400);
  const bass = lowPass(low, 300);
  const direct = low.map((sample, index) => sample - bass[index]);
  const reflected = join(direct, new Float32Array(12_000));
  for (let index = 336; index < reflected.length; index += 1) {
    reflected[index] += (direct[index - 336] ?? 0) * 0.5;
  }
  const captured = resample(reflected, clockRatio);
  const noiseRms = Math.sqrt(captured.reduce((power, sample) => power + sample * sample, 0) / captured.length)
    / 10 ** (24 / 20);
  let seed = 0x735627;
  const random = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return ((seed >>> 0) + 1) / 4_294_967_297;
  };
  return captured.map((sample) => {
    const noise = Math.fround(Math.sqrt(-2 * Math.log(random())) * Math.cos(2 * Math.PI * random()));
    // Quantize like an exported 16-bit PCM recording at a modest input level.
    return Math.round(Math.fround(sample + noise * noiseRms) * 0.1 * 32_767) / 32_768;
  });
}

describe("recorded audio reception regressions", () => {
  it.each([0.9999, 1, 1.0001])("receives FSK after phone filtering and reflection at clock ratio %s", (ratio) => {
    const text = "你好，这是一次声波传输测试。";
    const signal = encodeMessage(text, "fsk", { messageId: 0x1234, compression: false }).signal;
    const recording = filteredReflection(signal.samples, ratio);
    const report = decodeSamples(recording, 48_000, "fsk");
    expect(report.text).toBe(text);
    expect(report.frame.crcValid).toBe(true);
    expect(report.fec.uncorrectableCodewords).toBe(0);
  });

  it("recovers an FSK frame whose payload timing is displaced by several early reflections", () => {
    const text = "你好，这是一次声波传输测试。";
    const signal = encodeMessage(text, "fsk", { messageId: 0x1234, compression: false }).signal;
    const recording = join(signal.samples.map((sample) => sample * 0.1), new Float32Array(12_000));
    for (const [milliseconds, gain] of [[2.7, 0.65], [5.3, -0.45], [11.2, 0.35], [23, 0.25], [47, 0.15]]) {
      const delay = Math.round(48 * milliseconds);
      for (let index = delay; index < recording.length; index += 1) {
        recording[index] += (signal.samples[index - delay] ?? 0) * gain * 0.1;
      }
    }
    const report = decodeSamples(recording, 48_000, "fsk");
    expect(report.text).toBe(text);
    expect(report.frame.crcValid).toBe(true);
    expect(report.fec.uncorrectableCodewords).toBe(0);
  });

  it("receives FSK at every 32-sample phase of an 8 ms recording window", () => {
    const signal = encodeMessage("window alignment", "fsk", { messageId: 21 }).signal;
    const failures: number[] = [];
    for (let padding = 0; padding < 384; padding += 32) {
      try {
        expect(decodeSamples(join(new Float32Array(padding), signal.samples), 48_000, "fsk").text)
          .toBe("window alignment");
      } catch {
        failures.push(padding);
      }
    }
    expect(failures).toEqual([]);
  });

  it.each<ModemMode>(["fsk", "dtmf"])("ignores a loud earlier unrelated sound before %s", (mode) => {
    const signal = encodeMessage("after noise", mode, { messageId: 22 }).signal;
    const noise = Float32Array.from({ length: 9_600 }, (_, index) => 0.8 * Math.sin(index * 0.131));
    const recording = join(noise, new Float32Array(24_137), signal.samples);
    expect(decodeSamples(recording, 48_000, mode).text).toBe("after noise");
  });

  it.each<ModemMode>(["fsk", "dtmf"])("receives a long %s message recorded at 44.1 kHz", (mode) => {
    const text = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz / long recording without compression";
    const signal = encodeMessage(text, mode, { messageId: 23, compression: false }).signal;
    expect(decodeSamples(resample(signal.samples, 44_100 / 48_000), 44_100, mode).text).toBe(text);
  });

  it.each<[ModemMode, number]>([["fsk", 0.997], ["fsk", 1.003], ["dtmf", 0.997], ["dtmf", 1.003]])(
    "tracks %s sample clock ratio %s",
    (mode, ratio) => {
      const text = "Clock drift: 0123456789 abcdefghijklmnopqrstuvwxyz";
      const signal = encodeMessage(text, mode, { messageId: 24, compression: false }).signal;
      expect(decodeSamples(resample(signal.samples, ratio), 48_000, mode).text).toBe(text);
    },
  );

  it.each<ModemMode>(["fsk", "dtmf"])("continues after an earlier %s frame fails CRC", (mode) => {
    const first = encodeMessage("damaged", mode, { messageId: 25 });
    const frame = new Uint8Array(first.frame);
    frame[10] ^= 0x08;
    const damaged = modulate(protectWithHamming(frame), mode);
    const second = encodeMessage("valid later frame", mode, { messageId: 26 });
    const recording = join(damaged.samples, new Float32Array(7_123), second.signal.samples);
    expect(decodeSamples(recording, 48_000, mode).text).toBe(second.text);
  });

  it("rejects silence and deterministic non-carrier audio", () => {
    expect(() => decodeSamples(new Float32Array(48_000), 48_000, "fsk")).toThrow();
    const tone = Float32Array.from({ length: 48_000 }, (_, index) => 0.5 * Math.sin(index * 0.11));
    expect(() => decodeSamples(tone, 48_000, "fsk")).toThrow();
    expect(() => decodeSamples(tone, 48_000, "dtmf")).toThrow();
  });

  it.each<ModemMode>(["fsk", "dtmf"])("automatically identifies %s despite the opposite selected mode", (mode) => {
    const text = "自动识别";
    const signal = encodeMessage(text, mode, { messageId: 27 }).signal;
    const report = decodeSamplesAuto(signal.samples, 48_000, mode === "fsk" ? "dtmf" : "fsk");
    expect(report.text).toBe(text);
    expect(report.mode).toBe(mode);
    expect(report.frame.crcValid).toBe(true);
  });

  it.each<ModemMode>(["fsk", "dtmf"])("receives %s with quiet gain, noise, and an independent 16 kHz capture rate", (mode) => {
    const signal = encodeMessage("quiet capture", mode, { messageId: 28 }).signal;
    const noisy = simulateChannel(signal.samples, 48_000, { snrDb: 21, dropoutPercent: 0, echoPercent: 7 }, 3281);
    const recording = resample(noisy, 16_000 / 48_000);
    for (let index = 0; index < recording.length; index += 1) recording[index] *= 0.025;
    expect(decodeSamplesAuto(recording, 16_000).text).toBe("quiet capture");
  });

  it.each<ModemMode>(["fsk", "dtmf"])("refuses a truncated %s transmission", (mode) => {
    const signal = encodeMessage("complete frame is required", mode, { messageId: 29 }).signal;
    expect(() => decodeSamplesAuto(signal.samples.slice(0, Math.floor(signal.samples.length * 0.75)), 48_000)).toThrow();
  });

  it("rejects deterministic broadband noise and a CRC-damaged frame in automatic mode", () => {
    let seed = 8349281;
    const noise = Float32Array.from({ length: 96_000 }, () => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return ((seed >>> 0) / 0xffffffff - 0.5) * 0.2;
    });
    expect(() => decodeSamplesAuto(noise, 48_000)).toThrow(/training sequence/);
    const transmission = encodeMessage("damaged only", "fsk", { messageId: 30 });
    const frame = new Uint8Array(transmission.frame);
    frame[10] ^= 0x04;
    const signal = modulate(protectWithHamming(frame), "fsk");
    expect(() => decodeSamplesAuto(signal.samples, 48_000)).toThrow(/CRC mismatch/);
  });

  it("reports invalid or silent capture before searching for a frame", () => {
    expect(() => decodeSamplesAuto(new Float32Array(48_000), 48_000)).toThrow(/No audible signal/);
    expect(() => decodeSamplesAuto(new Float32Array([Number.NaN]), 48_000)).toThrow(/invalid samples/);
    expect(() => decodeSamplesAuto(new Float32Array([0.1]), 0)).toThrow(/sample rate/);
  });

  it.each([0.997, 1.003])("tracks clock ratio %s across the maximum 480-byte FSK message", (ratio) => {
    const text = Array.from({ length: 160 }, (_, index) => String.fromCharCode(0x4e00 + index)).join("");
    expect(new TextEncoder().encode(text)).toHaveLength(480);
    const signal = encodeMessage(text, "fsk", { messageId: 31, compression: false }).signal;
    expect(decodeSamples(resample(signal.samples, ratio), 48_000, "fsk").text).toBe(text);
  });

  it.each([0.997, 1.003])("tracks clock ratio %s across a 96-byte DTMF message", (ratio) => {
    const text = Array.from({ length: 96 }, (_, index) => String.fromCharCode(32 + index % 94)).join("");
    const signal = encodeMessage(text, "dtmf", { messageId: 32, compression: false }).signal;
    expect(decodeSamples(resample(signal.samples, ratio), 48_000, "dtmf").text).toBe(text);
  });

  it("rejects uncorrectable FEC even when altered payload bytes collide under CRC16", () => {
    const frame = createFrame(new TextEncoder().encode("ABCDE"), { compressed: false, originalLength: 5, messageId: 33 });
    const protectedBytes = protectWithHamming(frame);
    // CRC16's generator polynomial permits this deterministic body collision:
    // three payload bytes XOR 01 10 21. Each changed nibble also flips parity,
    // so SECDED explicitly detects four double-bit errors, without correcting.
    protectedBytes[10 * 2 + 1] ^= 0x02 | 0x80;
    protectedBytes[11 * 2] ^= 0x02 | 0x80;
    protectedBytes[12 * 2] ^= 0x04 | 0x80;
    protectedBytes[12 * 2 + 1] ^= 0x02 | 0x80;
    const recovery = recoverWithHamming(protectedBytes);
    expect(recovery.uncorrectableCodewords).toBe(4);
    expect(parseFrame(recovery.data).crcValid).toBe(true);
    expect(new TextDecoder().decode(parseFrame(recovery.data).payload)).toBe("@RbDE");
    const signal = modulate(protectedBytes, "fsk");
    expect(() => decodeSamples(signal.samples, 48_000, "fsk")).toThrow(/uncorrectable/);
  });

  it("bounds LZW expansion by the frame's declared original byte length", () => {
    const compressed = compressLzw(new Uint8Array(65_535).fill(65));
    const frame = createFrame(compressed, { compressed: true, originalLength: 2, messageId: 34 });
    const signal = modulate(protectWithHamming(frame), "fsk");
    expect(() => decodeSamples(signal.samples, 48_000, "fsk")).toThrow(/LZW output exceeds/);
    expect(decompressLzw(compressed)).toHaveLength(65_535);
  });
});
