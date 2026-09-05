import { bitsToBytes, bytesToBits } from "./bytes";

export type ModemMode = "fsk" | "dtmf";

export interface ModulatedSignal {
  mode: ModemMode;
  samples: Float32Array;
  sampleRate: number;
  durationSeconds: number;
  payloadSymbols: number;
}

export interface DemodulatedData {
  bytes: Uint8Array;
  confidence: number;
  symbolConfidences: number[];
  syncScore: number;
  symbolsRead: number;
  startSample: number;
}

const SAMPLE_RATE = 48_000;
const LEAD_SILENCE_SECONDS = 0.09;
const TAIL_SILENCE_SECONDS = 0.12;
const FSK_BAUD = 600;
const FSK_ZERO_HZ = 1_800;
const FSK_ONE_HZ = 3_000;
const FSK_PREAMBLE = Array.from({ length: 32 }, (_, index) => index % 2);
const FSK_SYNC = bytesToBits(new Uint8Array([0xd3, 0x91]));
const FSK_TRAINING = [...FSK_PREAMBLE, ...FSK_SYNC];

const DTMF_ROWS = [697, 770, 852, 941];
const DTMF_COLUMNS = [1209, 1336, 1477, 1633];
const DTMF_TONE_SECONDS = 0.036;
const DTMF_GAP_SECONDS = 0.006;
const DTMF_TRAINING = [0xa, 0x5, 0xa, 0x5, 0xd, 0xe, 0xa, 0xd];

interface ToneBasis {
  cos: Float64Array;
  sin: Float64Array;
}

function createBasis(frequency: number, length: number, sampleRate: number): ToneBasis {
  const cos = new Float64Array(length);
  const sin = new Float64Array(length);
  const angularStep = (Math.PI * 2 * frequency) / sampleRate;
  for (let index = 0; index < length; index += 1) {
    cos[index] = Math.cos(angularStep * index);
    sin[index] = Math.sin(angularStep * index);
  }
  return { cos, sin };
}

function toneEnergy(
  samples: Float32Array,
  start: number,
  basis: ToneBasis,
  trimStart = 0,
  trimEnd = 0,
): number {
  let real = 0;
  let imaginary = 0;
  const end = basis.cos.length - trimEnd;

  for (let index = trimStart; index < end; index += 1) {
    const sample = samples[start + index] ?? 0;
    real += sample * basis.cos[index];
    imaginary += sample * basis.sin[index];
  }

  const length = Math.max(1, end - trimStart);
  return (real * real + imaginary * imaginary) / (length * length);
}

function writeTone(
  output: Float32Array,
  start: number,
  length: number,
  frequencies: readonly number[],
  sampleRate: number,
  amplitude: number,
): void {
  const fadeSamples = Math.max(2, Math.min(Math.floor(sampleRate * 0.0015), Math.floor(length / 4)));

  for (let index = 0; index < length; index += 1) {
    const fadeIn = Math.min(1, index / fadeSamples);
    const fadeOut = Math.min(1, (length - 1 - index) / fadeSamples);
    const envelope = Math.max(0, Math.min(fadeIn, fadeOut));
    let sample = 0;

    for (const frequency of frequencies) {
      sample += Math.sin((Math.PI * 2 * frequency * index) / sampleRate);
    }

    output[start + index] = (sample / frequencies.length) * amplitude * envelope;
  }
}

function findBestOffset(
  minimumStart: number,
  maximumStart: number,
  coarseStep: number,
  scoreAt: (start: number) => number,
): { start: number; score: number } {
  let bestStart = minimumStart;
  let bestScore = Number.NEGATIVE_INFINITY;

  for (let start = minimumStart; start <= maximumStart; start += coarseStep) {
    const score = scoreAt(start);
    if (score > bestScore) {
      bestScore = score;
      bestStart = start;
    }
  }

  const refineStart = Math.max(minimumStart, bestStart - coarseStep);
  const refineEnd = Math.min(maximumStart, bestStart + coarseStep);
  for (let start = refineStart; start <= refineEnd; start += 1) {
    const score = scoreAt(start);
    if (score > bestScore) {
      bestScore = score;
      bestStart = start;
    }
  }

  return { start: bestStart, score: bestScore };
}

function findSignalOnset(samples: Float32Array, sampleRate: number): number {
  const windowLength = Math.max(32, Math.round(sampleRate * 0.008));
  const windowCount = Math.floor(samples.length / windowLength);
  if (windowCount < 3) return 0;

  const levels = new Float64Array(windowCount);
  for (let windowIndex = 0; windowIndex < windowCount; windowIndex += 1) {
    let power = 0;
    const start = windowIndex * windowLength;
    for (let index = start; index < start + windowLength; index += 1) {
      power += samples[index] * samples[index];
    }
    levels[windowIndex] = Math.sqrt(power / windowLength);
  }

  const sorted = Array.from(levels).sort((first, second) => first - second);
  const floor = sorted[Math.floor(sorted.length * 0.05)] ?? 0;
  const peak = sorted[sorted.length - 1] ?? 0;
  const threshold = floor + (peak - floor) * 0.3;

  for (let index = 0; index < levels.length - 1; index += 1) {
    if (levels[index] >= threshold && levels[index + 1] >= threshold) {
      return index * windowLength;
    }
  }

  return 0;
}

function modulateFsk(bytes: Uint8Array): ModulatedSignal {
  const samplesPerSymbol = Math.round(SAMPLE_RATE / FSK_BAUD);
  const payloadBits = bytesToBits(bytes);
  const symbols = [...FSK_TRAINING, ...payloadBits];
  const leadSamples = Math.round(SAMPLE_RATE * LEAD_SILENCE_SECONDS);
  const tailSamples = Math.round(SAMPLE_RATE * TAIL_SILENCE_SECONDS);
  const samples = new Float32Array(leadSamples + symbols.length * samplesPerSymbol + tailSamples);

  symbols.forEach((bit, index) => {
    writeTone(
      samples,
      leadSamples + index * samplesPerSymbol,
      samplesPerSymbol,
      [bit === 0 ? FSK_ZERO_HZ : FSK_ONE_HZ],
      SAMPLE_RATE,
      0.78,
    );
  });

  return {
    mode: "fsk",
    samples,
    sampleRate: SAMPLE_RATE,
    durationSeconds: samples.length / SAMPLE_RATE,
    payloadSymbols: payloadBits.length,
  };
}

function classifyFsk(
  samples: Float32Array,
  start: number,
  zeroBasis: ToneBasis,
  oneBasis: ToneBasis,
): { symbol: number; confidence: number } {
  const trim = Math.max(1, Math.floor(zeroBasis.cos.length * 0.08));
  const zeroEnergy = toneEnergy(samples, start, zeroBasis, trim, trim);
  const oneEnergy = toneEnergy(samples, start, oneBasis, trim, trim);
  const total = zeroEnergy + oneEnergy + 1e-12;
  return {
    symbol: oneEnergy > zeroEnergy ? 1 : 0,
    confidence: Math.abs(oneEnergy - zeroEnergy) / total,
  };
}

function demodulateFsk(samples: Float32Array, sampleRate: number): DemodulatedData {
  const samplesPerSymbol = Math.round(sampleRate / FSK_BAUD);
  const zeroBasis = createBasis(FSK_ZERO_HZ, samplesPerSymbol, sampleRate);
  const oneBasis = createBasis(FSK_ONE_HZ, samplesPerSymbol, sampleRate);
  const trainingLength = FSK_TRAINING.length * samplesPerSymbol;
  const onset = findSignalOnset(samples, sampleRate);
  const minimumStart = Math.max(0, onset - samplesPerSymbol * 2);
  const maximumStart = Math.max(
    minimumStart,
    Math.min(onset + samplesPerSymbol * 2, samples.length - trainingLength - samplesPerSymbol),
  );

  const scoreTraining = (start: number): number => {
    let score = 0;
    for (let index = 0; index < FSK_TRAINING.length; index += 1) {
      const result = classifyFsk(samples, start + index * samplesPerSymbol, zeroBasis, oneBasis);
      score += (result.symbol === FSK_TRAINING[index] ? 1 : -1) * (0.4 + result.confidence);
    }
    return score;
  };

  const best = findBestOffset(
    minimumStart,
    maximumStart,
    Math.max(2, Math.floor(samplesPerSymbol / 10)),
    scoreTraining,
  );
  const payloadStart = best.start + trainingLength;
  const symbolCount = Math.max(0, Math.floor((samples.length - payloadStart) / samplesPerSymbol));
  const bits: number[] = [];
  const symbolConfidences: number[] = [];

  for (let index = 0; index < symbolCount; index += 1) {
    const result = classifyFsk(samples, payloadStart + index * samplesPerSymbol, zeroBasis, oneBasis);
    bits.push(result.symbol);
    symbolConfidences.push(result.confidence);
  }

  return {
    bytes: bitsToBytes(bits),
    confidence:
      symbolCount === 0 ? 0 : symbolConfidences.reduce((total, value) => total + value, 0) / symbolCount,
    symbolConfidences,
    syncScore: best.score / (FSK_TRAINING.length * 1.4),
    symbolsRead: symbolCount,
    startSample: best.start,
  };
}

function nibbleToFrequencies(nibble: number): [number, number] {
  const row = Math.floor(nibble / 4);
  const column = nibble % 4;
  return [DTMF_ROWS[row], DTMF_COLUMNS[column]];
}

function bytesToNibbles(bytes: Uint8Array): number[] {
  const nibbles: number[] = [];
  for (const byte of bytes) {
    nibbles.push(byte >> 4, byte & 0x0f);
  }
  return nibbles;
}

function nibblesToBytes(nibbles: readonly number[]): Uint8Array {
  const bytes = new Uint8Array(Math.floor(nibbles.length / 2));
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = (nibbles[index * 2] << 4) | nibbles[index * 2 + 1];
  }
  return bytes;
}

function modulateDtmf(bytes: Uint8Array): ModulatedSignal {
  const toneSamples = Math.round(SAMPLE_RATE * DTMF_TONE_SECONDS);
  const gapSamples = Math.round(SAMPLE_RATE * DTMF_GAP_SECONDS);
  const slotSamples = toneSamples + gapSamples;
  const payloadNibbles = bytesToNibbles(bytes);
  const symbols = [...DTMF_TRAINING, ...payloadNibbles];
  const leadSamples = Math.round(SAMPLE_RATE * LEAD_SILENCE_SECONDS);
  const tailSamples = Math.round(SAMPLE_RATE * TAIL_SILENCE_SECONDS);
  const samples = new Float32Array(leadSamples + symbols.length * slotSamples + tailSamples);

  symbols.forEach((nibble, index) => {
    writeTone(
      samples,
      leadSamples + index * slotSamples,
      toneSamples,
      nibbleToFrequencies(nibble),
      SAMPLE_RATE,
      0.82,
    );
  });

  return {
    mode: "dtmf",
    samples,
    sampleRate: SAMPLE_RATE,
    durationSeconds: samples.length / SAMPLE_RATE,
    payloadSymbols: payloadNibbles.length,
  };
}

function topTwo(values: readonly number[]): { index: number; confidence: number } {
  let bestIndex = 0;
  let best = Number.NEGATIVE_INFINITY;
  let second = Number.NEGATIVE_INFINITY;

  values.forEach((value, index) => {
    if (value > best) {
      second = best;
      best = value;
      bestIndex = index;
    } else if (value > second) {
      second = value;
    }
  });

  return {
    index: bestIndex,
    confidence: Math.max(0, (best - Math.max(0, second)) / (best + 1e-12)),
  };
}

function classifyDtmf(
  samples: Float32Array,
  start: number,
  rowBases: readonly ToneBasis[],
  columnBases: readonly ToneBasis[],
): { symbol: number; confidence: number } {
  const trim = Math.max(1, Math.floor(rowBases[0].cos.length * 0.06));
  const row = topTwo(rowBases.map((basis) => toneEnergy(samples, start, basis, trim, trim)));
  const column = topTwo(columnBases.map((basis) => toneEnergy(samples, start, basis, trim, trim)));
  return {
    symbol: row.index * 4 + column.index,
    confidence: (row.confidence + column.confidence) / 2,
  };
}

function demodulateDtmf(samples: Float32Array, sampleRate: number): DemodulatedData {
  const toneSamples = Math.round(sampleRate * DTMF_TONE_SECONDS);
  const gapSamples = Math.round(sampleRate * DTMF_GAP_SECONDS);
  const slotSamples = toneSamples + gapSamples;
  const rowBases = DTMF_ROWS.map((frequency) => createBasis(frequency, toneSamples, sampleRate));
  const columnBases = DTMF_COLUMNS.map((frequency) => createBasis(frequency, toneSamples, sampleRate));
  const trainingLength = DTMF_TRAINING.length * slotSamples;
  const onset = findSignalOnset(samples, sampleRate);
  const minimumStart = Math.max(0, onset - slotSamples);
  const maximumStart = Math.max(
    minimumStart,
    Math.min(onset + slotSamples, samples.length - trainingLength - slotSamples),
  );

  const scoreTraining = (start: number): number => {
    let score = 0;
    for (let index = 0; index < DTMF_TRAINING.length; index += 1) {
      const result = classifyDtmf(samples, start + index * slotSamples, rowBases, columnBases);
      score += (result.symbol === DTMF_TRAINING[index] ? 1 : -1) * (0.4 + result.confidence);
    }
    return score;
  };

  const best = findBestOffset(
    minimumStart,
    maximumStart,
    Math.max(8, Math.floor(slotSamples / 16)),
    scoreTraining,
  );
  const payloadStart = best.start + trainingLength;
  const symbolCount = Math.max(0, Math.floor((samples.length - payloadStart) / slotSamples));
  const nibbles: number[] = [];
  const symbolConfidences: number[] = [];

  for (let index = 0; index < symbolCount; index += 1) {
    const result = classifyDtmf(samples, payloadStart + index * slotSamples, rowBases, columnBases);
    nibbles.push(result.symbol);
    symbolConfidences.push(result.confidence);
  }

  return {
    bytes: nibblesToBytes(nibbles),
    confidence:
      symbolCount === 0 ? 0 : symbolConfidences.reduce((total, value) => total + value, 0) / symbolCount,
    symbolConfidences,
    syncScore: best.score / (DTMF_TRAINING.length * 1.4),
    symbolsRead: symbolCount,
    startSample: best.start,
  };
}

export function modulate(bytes: Uint8Array, mode: ModemMode): ModulatedSignal {
  return mode === "fsk" ? modulateFsk(bytes) : modulateDtmf(bytes);
}

export function demodulate(samples: Float32Array, sampleRate: number, mode: ModemMode): DemodulatedData {
  if (samples.length === 0) {
    throw new Error("Audio buffer is empty");
  }
  return mode === "fsk" ? demodulateFsk(samples, sampleRate) : demodulateDtmf(samples, sampleRate);
}

export const modemSpecs = {
  sampleRate: SAMPLE_RATE,
  fsk: {
    baud: FSK_BAUD,
    frequencies: [FSK_ZERO_HZ, FSK_ONE_HZ] as const,
  },
  dtmf: {
    rows: DTMF_ROWS,
    columns: DTMF_COLUMNS,
    toneMilliseconds: DTMF_TONE_SECONDS * 1000,
    gapMilliseconds: DTMF_GAP_SECONDS * 1000,
  },
};
