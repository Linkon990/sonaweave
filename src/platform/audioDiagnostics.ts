export type AudioSignalStatus = "silence" | "low-level" | "clipped" | "signal-present" | "invalid";

/** These measurements describe captured sound, never protocol/carrier detection. */
export type AudioDiagnostics = {
  status: AudioSignalStatus;
  sampleRate: number;
  sampleCount: number;
  durationSeconds: number;
  rms: number;
  peak: number;
  clippedFraction: number;
  nonZeroFraction: number;
  invalidSampleCount: number;
  longestZeroSeconds: number;
};

export function analyzeAudio(samples: Float32Array, sampleRate: number): AudioDiagnostics {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) throw new Error("Invalid audio sample rate");
  let energy = 0;
  let peak = 0;
  let clipped = 0;
  let nonZero = 0;
  let invalidSampleCount = 0;
  let zeroRun = 0;
  let longestZeroRun = 0;
  for (const sample of samples) {
    if (!Number.isFinite(sample)) { invalidSampleCount += 1; zeroRun = 0; continue; }
    const magnitude = Math.abs(sample);
    energy += sample * sample;
    peak = Math.max(peak, magnitude);
    if (magnitude >= 0.995) clipped += 1;
    if (sample !== 0) { nonZero += 1; zeroRun = 0; }
    else { zeroRun += 1; longestZeroRun = Math.max(longestZeroRun, zeroRun); }
  }
  const count = Math.max(1, samples.length);
  const rms = Math.sqrt(energy / count);
  const clippedFraction = clipped / count;
  return {
    status: invalidSampleCount ? "invalid" : rms < 1e-6 ? "silence" : clippedFraction >= 0.001
      ? "clipped" : rms < 0.002 ? "low-level" : "signal-present",
    sampleRate, sampleCount: samples.length, durationSeconds: samples.length / sampleRate,
    rms, peak, clippedFraction, nonZeroFraction: nonZero / count, invalidSampleCount,
    longestZeroSeconds: longestZeroRun / sampleRate,
  };
}

/** Allowlist only; browser device/group identifiers never enter exported data. */
export type CaptureTrackSettings = Pick<MediaTrackSettings,
  "sampleRate" | "sampleSize" | "channelCount" |
  "autoGainControl" | "echoCancellation" | "noiseSuppression"> & { latency?: number };

export function captureTrackSettings(settings: MediaTrackSettings & { latency?: number }): CaptureTrackSettings {
  const result: CaptureTrackSettings = {};
  for (const key of ["sampleRate", "sampleSize", "channelCount", "latency"] as const) {
    const value = settings[key];
    if (typeof value === "number" && Number.isFinite(value)) result[key] = value;
  }
  for (const key of ["autoGainControl", "echoCancellation", "noiseSuppression"] as const) {
    if (typeof settings[key] === "boolean") result[key] = settings[key];
  }
  return result;
}

/** Lock to the first audible channel decision, avoiding phase jumps per block. */
export function chooseInputChannel(channels: Float32Array[], selectedChannel: number | null): number | null {
  if (selectedChannel !== null && selectedChannel < channels.length) return selectedChannel;
  let strongest = 0;
  let strongestEnergy = 0;
  for (let channel = 0; channel < channels.length; channel += 1) {
    let energy = 0;
    for (const sample of channels[channel]) energy += sample * sample;
    if (energy > strongestEnergy) { strongest = channel; strongestEnergy = energy; }
  }
  return strongestEnergy > (channels[strongest]?.length ?? 0) * 1e-10 ? strongest : null;
}
