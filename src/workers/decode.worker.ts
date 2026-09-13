import { decodeSamples, decodeSamplesAuto } from "../core/protocol";
import type { ModemMode } from "../core/modem";

self.onmessage = (event: MessageEvent<{ samples: Float32Array; sampleRate: number; mode?: ModemMode }>) => {
  const { samples, sampleRate, mode } = event.data;
  try {
    if (!Number.isFinite(sampleRate) || sampleRate < 8_000 || sampleRate > 192_000 || samples.length / sampleRate > 120.1) {
      throw new Error("Audio duration or sample rate is unsupported");
    }
    const report = mode ? decodeSamples(samples, sampleRate, mode) : decodeSamplesAuto(samples, sampleRate);
    self.postMessage({ report });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : "Audio decode failed" });
  }
};
