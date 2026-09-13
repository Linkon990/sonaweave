import type { DecodeReport } from "../core/protocol";
import type { GgWaveReport, GgWaveSpeed, GgWaveTransmission } from "./ggwave";

export type AcousticReport = DecodeReport | GgWaveReport;
export type AcousticCommand = { type: "encode"; text: string; speed: GgWaveSpeed } |
  { type: "decode"; samples: Float32Array; sampleRate: number } |
  { type: "prepare" } | { type: "chunk"; samples: Float32Array; sampleRate: number } | { type: "finish" };
export type AcousticResponse = { type: "encoded"; transmission: GgWaveTransmission } |
  { type: "decoded"; report: AcousticReport } | { type: "ready" } | { type: "finished" } |
  { type: "error"; error: string };

export function packetPlayback(samples: Float32Array, sampleRate: number, repeats: number): Float32Array {
  if (!Number.isFinite(sampleRate) || sampleRate < 8_000 || sampleRate > 96_000 ||
    !Number.isInteger(repeats) || repeats < 1 || repeats > 3 || samples.length === 0) {
    throw new Error("Invalid playback parameters");
  }
  const lead = Math.round(sampleRate * 0.35);
  const gap = Math.round(sampleRate * 0.4);
  const tail = Math.round(sampleRate * 0.3);
  const length = lead + samples.length * repeats + gap * (repeats - 1) + tail;
  if (length / sampleRate > 120) throw new Error("Playback exceeds 120 seconds");
  const output = new Float32Array(length);
  for (let index = 0; index < repeats; index++) output.set(samples, lead + index * (samples.length + gap));
  return output;
}
