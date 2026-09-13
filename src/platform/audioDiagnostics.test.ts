import { describe, expect, it } from "vitest";
import { analyzeAudio, captureTrackSettings, chooseInputChannel } from "./audioDiagnostics";

describe("captured audio diagnostics", () => {
  it("distinguishes actual zeros, very quiet input, normal sound and clipping without claiming carrier detection", () => {
    expect(analyzeAudio(new Float32Array(48_000), 48_000)).toMatchObject({
      status: "silence", durationSeconds: 1, nonZeroFraction: 0, longestZeroSeconds: 1,
    });
    expect(analyzeAudio(new Float32Array(100).fill(0.0001), 48_000).status).toBe("low-level");
    expect(analyzeAudio(new Float32Array([0, 0.25, -0.25, 0]), 48_000)).toMatchObject({
      status: "signal-present", peak: 0.25, nonZeroFraction: 0.5, clippedFraction: 0,
    });
    expect(analyzeAudio(new Float32Array([1, -1, 0, 0]), 48_000)).toMatchObject({
      status: "clipped", peak: 1, clippedFraction: 0.5,
    });
  });

  it("reports invalid samples with finite JSON-safe diagnostics", () => {
    const result = analyzeAudio(new Float32Array([NaN, Infinity, 0, -0.2]), 8_000);
    expect(result).toMatchObject({ status: "invalid", invalidSampleCount: 2, nonZeroFraction: 0.25 });
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
    expect(() => analyzeAudio(new Float32Array(1), NaN)).toThrow("sample rate");
  });

  it("keeps unknown processing settings unknown and excludes identifiers", () => {
    expect(captureTrackSettings({
      deviceId: "private-device-id", groupId: "private-group-id", sampleRate: 48_000,
      channelCount: 2, noiseSuppression: false, echoCancellation: true,
    })).toEqual({ sampleRate: 48_000, channelCount: 2, noiseSuppression: false, echoCancellation: true });
    expect(captureTrackSettings({})).toEqual({});
  });

  it("waits through silent channels then locks one channel despite subsequent level changes", () => {
    const silence = new Float32Array(128);
    const tone = new Float32Array(128).fill(0.25);
    expect(chooseInputChannel([silence, silence], null)).toBeNull();
    const selected = chooseInputChannel([silence, tone], null);
    expect(selected).toBe(1);
    expect(chooseInputChannel([tone, silence], selected)).toBe(1);
    expect(chooseInputChannel([tone], selected)).toBe(0);
  });
});
