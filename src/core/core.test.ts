import { describe, expect, it } from "vitest";
import { simulateChannel } from "./channel";
import { createFrame, parseFrame } from "./frame";
import { protectWithHamming, recoverWithHamming } from "./hamming";
import { compressLzw, decompressLzw } from "./lzw";
import { decodeSamples, encodeMessage } from "./protocol";
import { encodeWav } from "./wav";

describe("LZW12 codec", () => {
  it.each([
    "hello hello hello hello",
    "网络不可用时保持设备靠近。网络不可用时保持设备靠近。",
    "emoji: 📡📡📡 / UTF-8",
  ])("round-trips UTF-8 bytes for %s", (text) => {
    const input = new TextEncoder().encode(text);
    const compressed = compressLzw(input);
    expect(decompressLzw(compressed)).toEqual(input);
  });
});

describe("Hamming SECDED", () => {
  it("corrects every possible single-bit error in a codeword", () => {
    const source = new Uint8Array([0xa5, 0x00, 0xff]);
    const protectedBytes = protectWithHamming(source);

    for (let codeword = 0; codeword < protectedBytes.length; codeword += 1) {
      for (let bit = 0; bit < 8; bit += 1) {
        const damaged = new Uint8Array(protectedBytes);
        damaged[codeword] ^= 1 << bit;
        const recovered = recoverWithHamming(damaged);
        expect(recovered.data).toEqual(source);
        expect(recovered.correctedCodewords).toBe(1);
        expect(recovered.uncorrectableCodewords).toBe(0);
      }
    }
  });

  it("detects a double-bit error", () => {
    const protectedBytes = protectWithHamming(new Uint8Array([0x5a]));
    protectedBytes[0] ^= 0b0000_0011;
    const recovered = recoverWithHamming(protectedBytes);
    expect(recovered.uncorrectableCodewords).toBe(1);
  });
});

describe("SWP-1 frame", () => {
  it("parses metadata and validates CRC16", () => {
    const payload = new TextEncoder().encode("frame payload");
    const frame = createFrame(payload, { compressed: false, originalLength: payload.length, messageId: 0x1234 });
    const parsed = parseFrame(frame);
    expect(parsed.messageId).toBe(0x1234);
    expect(parsed.payload).toEqual(payload);
    expect(parsed.crcValid).toBe(true);
  });

  it("detects payload corruption", () => {
    const payload = new TextEncoder().encode("crc check");
    const frame = createFrame(payload, { compressed: false, originalLength: payload.length });
    frame[10] ^= 0x20;
    expect(parseFrame(frame).crcValid).toBe(false);
  });
});

describe("audio modem", () => {
  it("round-trips a protected frame through FSK audio", () => {
    const transmission = encodeMessage("FSK loopback / 近场", "fsk", { messageId: 0x0102 });
    const report = decodeSamples(
      transmission.signal.samples,
      transmission.signal.sampleRate,
      transmission.mode,
    );
    expect(report.text).toBe(transmission.text);
    expect(report.frame.crcValid).toBe(true);
    expect(report.modem.confidence).toBeGreaterThan(0.8);
  });

  it("round-trips a protected frame through DTMF audio", () => {
    const transmission = encodeMessage("OK-27", "dtmf", { messageId: 0x0304 });
    const report = decodeSamples(
      transmission.signal.samples,
      transmission.signal.sampleRate,
      transmission.mode,
    );
    expect(report.text).toBe(transmission.text);
    expect(report.frame.crcValid).toBe(true);
    expect(report.modem.confidence).toBeGreaterThan(0.7);
  });

  it("survives the clear-room channel simulation", () => {
    const transmission = encodeMessage("channel test channel test", "fsk", { messageId: 0x0506 });
    const samples = simulateChannel(transmission.signal.samples, transmission.signal.sampleRate, {
      snrDb: 34,
      dropoutPercent: 0.5,
      echoPercent: 2,
    });
    const report = decodeSamples(samples, transmission.signal.sampleRate, transmission.mode);
    expect(report.text).toBe(transmission.text);
    expect(report.frame.crcValid).toBe(true);
  });

  it("finds an FSK frame after arbitrary recording silence", () => {
    const transmission = encodeMessage("delayed microphone start", "fsk", { messageId: 0x0708 });
    const leadingSilence = Math.round(transmission.signal.sampleRate * 1.35);
    const trailingSilence = Math.round(transmission.signal.sampleRate * 0.75);
    const recording = new Float32Array(leadingSilence + transmission.signal.samples.length + trailingSilence);
    recording.set(transmission.signal.samples, leadingSilence);

    const report = decodeSamples(recording, transmission.signal.sampleRate, transmission.mode);
    expect(report.text).toBe(transmission.text);
    expect(report.modem.startSample).toBeGreaterThan(leadingSilence);
    expect(report.modem.confidence).toBeGreaterThan(0.8);
  });

  it("finds a DTMF frame after arbitrary recording silence", () => {
    const transmission = encodeMessage("D7", "dtmf", { messageId: 0x090a });
    const leadingSilence = Math.round(transmission.signal.sampleRate * 0.8);
    const trailingSilence = Math.round(transmission.signal.sampleRate * 0.4);
    const recording = new Float32Array(leadingSilence + transmission.signal.samples.length + trailingSilence);
    recording.set(transmission.signal.samples, leadingSilence);

    const report = decodeSamples(recording, transmission.signal.sampleRate, transmission.mode);
    expect(report.text).toBe(transmission.text);
    expect(report.modem.startSample).toBeGreaterThan(leadingSilence);
    expect(report.modem.confidence).toBeGreaterThan(0.7);
  });

  it("writes a standards-shaped PCM WAV container", async () => {
    const blob = encodeWav(new Float32Array([0, 0.5, -0.5, 1, -1]), 48_000);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe("RIFF");
    expect(new TextDecoder().decode(bytes.slice(8, 12))).toBe("WAVE");
    expect(new DataView(bytes.buffer).getUint32(24, true)).toBe(48_000);
    expect(bytes.length).toBe(44 + 5 * 2);
  });
});
