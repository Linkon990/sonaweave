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

export function modulate(bytes: Uint8Array, mode: ModemMode): ModulatedSignal {
  return mode === "fsk" ? modulateFsk(bytes) : modulateDtmf(bytes);
}

interface SymbolReading {
  symbol: number;
  confidence: number;
}

interface Receiver {
  period: number;
  hop: number;
  training: readonly number[];
  classify: (start: number) => SymbolReading;
  classifyExact: (start: number) => SymbolReading;
}

export class TrainingNotFoundError extends Error {
  constructor() {
    super("No SonaWeave training sequence was found; listen before playback and record the complete signal");
    this.name = "TrainingNotFoundError";
  }
}

// Sliding quadrature sums are O(recording length), with only one short ring
// buffer per frequency. Retain energies at a sparse time grid, not PCM-sized
// complex arrays or an FFT for every possible training offset.
function energyTrack(
  samples: Float32Array,
  frequency: number,
  sampleRate: number,
  window: number,
  hop: number,
): Float32Array {
  const output = new Float32Array(Math.max(0, Math.floor((samples.length - window) / hop) + 1));
  const realRing = new Float64Array(window);
  const imaginaryRing = new Float64Array(window);
  const step = (2 * Math.PI * frequency) / sampleRate;
  const rotationCos = Math.cos(step);
  const rotationSin = Math.sin(step);
  let cos = 1;
  let sin = 0;
  let real = 0;
  let imaginary = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const ringIndex = index % window;
    const nextReal = samples[index] * cos;
    const nextImaginary = samples[index] * sin;
    real += nextReal - realRing[ringIndex];
    imaginary += nextImaginary - imaginaryRing[ringIndex];
    realRing[ringIndex] = nextReal;
    imaginaryRing[ringIndex] = nextImaginary;
    const start = index - window + 1;
    if (start >= 0 && start % hop === 0) {
      output[start / hop] = (real * real + imaginary * imaginary) / (window * window);
    }
    const nextCos = cos * rotationCos - sin * rotationSin;
    sin = sin * rotationCos + cos * rotationSin;
    cos = nextCos;
  }
  return output;
}

function createReceiver(samples: Float32Array, sampleRate: number, mode: ModemMode): Receiver {
  // Keep fractional periods. Rounding 44,100/600 to 74 would lose half a
  // sample every symbol and eventually turn a clean recording into bad bits.
  const period = mode === "fsk" ? sampleRate / FSK_BAUD : sampleRate * (DTMF_TONE_SECONDS + DTMF_GAP_SECONDS);
  const toneLength = mode === "fsk" ? period : sampleRate * DTMF_TONE_SECONDS;
  const trim = Math.floor(toneLength * (mode === "fsk" ? 0.08 : 0.06));
  const window = Math.max(4, Math.round(toneLength) - trim * 2);
  const hop = Math.max(1, Math.floor(period / (mode === "fsk" ? 12 : 32)));
  const frequencies = mode === "fsk" ? [FSK_ZERO_HZ, FSK_ONE_HZ] : [...DTMF_ROWS, ...DTMF_COLUMNS];
  const tracks = frequencies.map((frequency) => energyTrack(samples, frequency, sampleRate, window, hop));
  const bases = frequencies.map((frequency) => createBasis(frequency, Math.round(toneLength), sampleRate));
  return {
    period,
    hop,
    training: mode === "fsk" ? FSK_TRAINING : DTMF_TRAINING,
    classify: (start) => {
      const index = Math.round((start + trim) / hop);
      if (mode === "fsk") {
        const zero = tracks[0][index] ?? 0;
        const one = tracks[1][index] ?? 0;
        return { symbol: one > zero ? 1 : 0, confidence: Math.abs(one - zero) / (one + zero + 1e-12) };
      }
      const row = topTwo(tracks.slice(0, 4).map((track) => track[index] ?? 0));
      const column = topTwo(tracks.slice(4).map((track) => track[index] ?? 0));
      return { symbol: row.index * 4 + column.index, confidence: Math.min(row.confidence, column.confidence) };
    },
    classifyExact: (start) => mode === "fsk"
      ? classifyFsk(samples, Math.round(start), bases[0], bases[1])
      : classifyDtmf(samples, Math.round(start), bases.slice(0, 4), bases.slice(4)),
  };
}

function trainingScore(receiver: Receiver, start: number, exact = false): number {
  let score = 0;
  let mismatches = 0;
  const maximumMismatches = receiver.training.length === FSK_TRAINING.length ? 6 : 1;
  for (let index = 0; index < receiver.training.length; index += 1) {
    const result = (exact ? receiver.classifyExact : receiver.classify)(start + index * receiver.period);
    if (result.confidence < 0.12 || result.symbol !== receiver.training[index]) {
      mismatches += 1;
      if (mismatches > maximumMismatches) return -1;
    }
    score += (result.symbol === receiver.training[index] ? 1 : -1) * result.confidence;
  }
  return score / receiver.training.length;
}

function findTrainingCandidates(receiver: Receiver, sampleCount: number): { start: number; score: number }[] {
  const candidates: { start: number; score: number }[] = [];
  const end = sampleCount - (receiver.training.length + 1) * receiver.period;
  const threshold = receiver.training.length === FSK_TRAINING.length ? 0.65 : 0.55;
  for (let start = 0; start <= end; start += receiver.hop) {
    const score = trainingScore(receiver, start);
    if (score < threshold) continue;
    const previous = candidates[candidates.length - 1];
    if (previous && start - previous.start < receiver.period * 2) {
      if (score > previous.score) candidates[candidates.length - 1] = { start, score };
    } else {
      candidates.push({ start, score });
    }
  }
  // Temporal order makes repeated recordings predictable; CRC rejection of one
  // candidate must not suppress a later valid frame. No global onset gate.
  return candidates.map((candidate) => {
    let best = { start: candidate.start, score: trainingScore(receiver, candidate.start, true) };
    for (let start = Math.max(0, candidate.start - receiver.hop); start <= candidate.start + receiver.hop; start += 1) {
      const score = trainingScore(receiver, start, true);
      if (score > best.score) best = { start, score };
    }
    return best;
  });
}

function powerIntegral(samples: Float32Array): Float64Array {
  const integral = new Float64Array(samples.length + 1);
  for (let index = 0; index < samples.length; index += 1) {
    integral[index + 1] = integral[index] + samples[index] * samples[index];
  }
  return integral;
}

// Both SWP-1 waveforms have an envelope minimum at symbol boundaries (a short
// fade for FSK; an explicit gap for DTMF). Follow that minimum locally so small
// independent playback/capture clock errors cannot accumulate over a message.
function trackBoundary(integral: Float64Array, predicted: number, period: number, mode: ModemMode): number {
  const phase = mode === "fsk" ? 0 : -period * DTMF_GAP_SECONDS / (DTMF_TONE_SECONDS + DTMF_GAP_SECONDS) / 2;
  const radius = period * (mode === "fsk" ? 0.09 : 0.025);
  const energy = (center: number, halfWidth: number) => {
    const left = Math.max(0, Math.round(center - halfWidth));
    const right = Math.min(integral.length - 1, Math.round(center + halfWidth));
    return right <= left ? 0 : (integral[right] - integral[left]) / (right - left);
  };
  const reference = energy(predicted + period / 2, period / 2);
  if (reference < 1e-10) return predicted;
  let best = predicted;
  let bestEnergy = energy(predicted + phase, radius);
  const search = period * 0.16;
  const step = Math.max(1, Math.floor(period / 100));
  for (let offset = -search; offset <= search; offset += step) {
    const level = energy(predicted + offset + phase, radius);
    if (level < bestEnergy) {
      best = predicted + offset;
      bestEnergy = level;
    }
  }
  if (bestEnergy > reference * 0.75) return predicted;
  return predicted + Math.max(-period * 0.08, Math.min(period * 0.08, (best - predicted) * 0.8));
}

function readCandidate(
  samples: Float32Array,
  receiver: Receiver,
  integral: Float64Array,
  mode: ModemMode,
  candidate: { start: number; score: number },
  maximumBytes: number,
  trackEnvelope: boolean,
): DemodulatedData {
  let position = candidate.start;
  const symbols: number[] = [];
  const symbolConfidences: number[] = [];
  let symbolIndex = 0;
  const maximumSymbols = maximumBytes * (mode === "fsk" ? 8 : 2);
  while (position + receiver.period <= samples.length && symbols.length < maximumSymbols) {
    if (trackEnvelope) position = trackBoundary(integral, position, receiver.period, mode);
    if (symbolIndex >= receiver.training.length) {
      const result = receiver.classifyExact(position);
      symbols.push(result.symbol);
      symbolConfidences.push(result.confidence);
    }
    symbolIndex += 1;
    position = trackEnvelope ? position + receiver.period : candidate.start + symbolIndex * receiver.period;
  }
  return {
    bytes: mode === "fsk" ? bitsToBytes(symbols) : nibblesToBytes(symbols),
    confidence: symbolConfidences.reduce((total, value) => total + value, 0) / Math.max(1, symbols.length),
    symbolConfidences,
    syncScore: candidate.score,
    symbolsRead: symbols.length,
    startSample: Math.round(candidate.start),
  };
}

export interface DemodulationCandidate {
  read: (maximumBytes?: number) => DemodulatedData;
}

/** Search once; let the protocol layer probe each header before reading its payload. */
export function* demodulateCandidates(
  samples: Float32Array,
  sampleRate: number,
  mode: ModemMode,
): Generator<DemodulationCandidate> {
  if (!Number.isFinite(sampleRate) || sampleRate < 8_000 || sampleRate > 192_000) {
    throw new Error("Unsupported audio sample rate (expected 8000–192000 Hz)");
  }
  if (samples.length === 0) throw new Error("Audio buffer is empty");
  let peak = 0;
  for (const sample of samples) {
    if (!Number.isFinite(sample)) throw new Error("Audio contains invalid samples");
    peak = Math.max(peak, Math.abs(sample));
  }
  if (peak < 1e-5) throw new Error("No audible signal was recorded");
  const receiver = createReceiver(samples, sampleRate, mode);
  const candidates = findTrainingCandidates(receiver, samples.length);
  if (candidates.length === 0) throw new TrainingNotFoundError();
  const integral = powerIntegral(samples);
  for (const candidate of candidates) {
    // Keep envelope recovery first for independent sample clocks and long
    // frames. Filtering/reflections can move the waveform's energy minima, so
    // a failed frame also gets a fixed fractional-period reading of this same
    // training start. The protocol must validate its complete FEC and CRC before
    // accepting it; preserve temporal order before advancing to a later frame.
    yield { read: (maximumBytes = Infinity) => readCandidate(samples, receiver, integral, mode, candidate, maximumBytes, true) };
    yield { read: (maximumBytes = Infinity) => readCandidate(samples, receiver, integral, mode, candidate, maximumBytes, false) };
  }
}

export function demodulate(samples: Float32Array, sampleRate: number, mode: ModemMode): DemodulatedData {
  const candidate = demodulateCandidates(samples, sampleRate, mode).next();
  if (candidate.done) throw new TrainingNotFoundError();
  return candidate.value.read();
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
