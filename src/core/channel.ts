export interface ChannelSettings {
  snrDb: number;
  dropoutPercent: number;
  echoPercent: number;
}

function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function gaussian(random: () => number): number {
  const first = Math.max(Number.EPSILON, random());
  const second = random();
  return Math.sqrt(-2 * Math.log(first)) * Math.cos(2 * Math.PI * second);
}

export function simulateChannel(
  input: Float32Array,
  sampleRate: number,
  settings: ChannelSettings,
  seed = 0x534f4e41,
): Float32Array {
  const output = new Float32Array(input);
  const random = createRandom(seed);
  let signalPower = 0;

  for (const sample of input) {
    signalPower += sample * sample;
  }
  signalPower /= Math.max(1, input.length);

  const echoMix = Math.max(0, Math.min(0.35, settings.echoPercent / 100));
  if (echoMix > 0) {
    const delay = Math.max(1, Math.round(sampleRate * 0.007));
    for (let index = delay; index < output.length; index += 1) {
      output[index] += input[index - delay] * echoMix;
    }
  }

  const dropoutProbability = Math.max(0, Math.min(0.35, settings.dropoutPercent / 100));
  const blockLength = Math.max(1, Math.round(sampleRate * 0.012));
  const fadeLength = Math.max(1, Math.floor(blockLength * 0.15));
  for (let start = 0; start < output.length; start += blockLength) {
    if (random() >= dropoutProbability) {
      continue;
    }
    const end = Math.min(output.length, start + blockLength);
    for (let index = start; index < end; index += 1) {
      const edge = Math.min(index - start, end - 1 - index);
      const fade = Math.min(1, edge / fadeLength);
      output[index] *= 1 - 0.94 * fade;
    }
  }

  const snrDb = Math.max(0, Math.min(60, settings.snrDb));
  const noiseRms = Math.sqrt(signalPower) / 10 ** (snrDb / 20);
  for (let index = 0; index < output.length; index += 1) {
    output[index] = Math.max(-1, Math.min(1, output[index] + gaussian(random) * noiseRms));
  }

  return output;
}

export const channelPresets = {
  clear: { snrDb: 38, dropoutPercent: 0, echoPercent: 2 },
  street: { snrDb: 21, dropoutPercent: 1.5, echoPercent: 7 },
  degraded: { snrDb: 14, dropoutPercent: 3.5, echoPercent: 12 },
} satisfies Record<string, ChannelSettings>;
