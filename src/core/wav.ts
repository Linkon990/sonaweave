export function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const bytesPerSample = 2;
  const dataLength = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataLength);
  const view = new DataView(buffer);

  const writeString = (offset: number, value: string): void => {
    for (let index = 0; index < value.length; index += 1) {
      view.setUint8(offset + index, value.charCodeAt(index));
    }
  };

  writeString(0, "RIFF");
  view.setUint32(4, 36 + dataLength, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeString(36, "data");
  view.setUint32(40, dataLength, true);

  samples.forEach((sample, index) => {
    const clamped = Math.max(-1, Math.min(1, sample));
    const pcm = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
    view.setInt16(44 + index * bytesPerSample, Math.round(pcm), true);
  });

  return new Blob([buffer], { type: "audio/wav" });
}

const MAX_IMPORT_SECONDS = 120;
const MAX_IMPORT_BYTES = 32 * 1024 * 1024;

export interface AudioImportRuntime {
  createAudio(): HTMLAudioElement;
  createObjectURL(blob: Blob): string;
  revokeObjectURL(url: string): void;
  createContext(): AudioContext;
}

function browserAudioRuntime(): AudioImportRuntime {
  return {
    createAudio: () => new Audio(),
    createObjectURL: (blob) => URL.createObjectURL(blob),
    revokeObjectURL: (url) => URL.revokeObjectURL(url),
    // Avoid expanding every import to a high-rate USB/output device's native
    // rate. Web Audio still handles supported codecs and resampling to 48 kHz.
    createContext: () => new AudioContext({ sampleRate: 48_000 }),
  };
}

function validateDuration(duration: number) {
  if (!Number.isFinite(duration) || duration <= 0 || duration > MAX_IMPORT_SECONDS) {
    throw new Error("Audio duration is invalid or too long (maximum 120 seconds)");
  }
}

async function inspectDuration(blob: Blob, runtime: AudioImportRuntime, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const url = runtime.createObjectURL(blob);
  let audio: HTMLAudioElement | undefined;
  try {
    const element = runtime.createAudio();
    audio = element;
    // Only a local Blob URL is assigned, with no playback. Reading container
    // metadata avoids fully decompressing a long, small compressed recording.
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: unknown) => {
        clearTimeout(timeout);
        element.removeEventListener("loadedmetadata", loaded);
        element.removeEventListener("error", failed);
        signal?.removeEventListener("abort", aborted);
        if (error) reject(error);
        else resolve();
      };
      const loaded = () => {
        try { validateDuration(element.duration); finish(); }
        catch (error) { finish(error); }
      };
      const failed = () => finish(new Error("Audio duration metadata could not be read; try a PCM WAV file"));
      const aborted = () => finish(signal?.reason ?? new DOMException("Audio import cancelled", "AbortError"));
      const timeout = setTimeout(() => finish(new Error("Audio duration metadata timed out; try a PCM WAV file")), 10_000);
      element.addEventListener("loadedmetadata", loaded);
      element.addEventListener("error", failed);
      signal?.addEventListener("abort", aborted, { once: true });
      try {
        signal?.throwIfAborted();
        element.preload = "metadata";
        element.src = url;
        element.load();
      } catch (error) { finish(error); }
    });
  } finally {
    try {
      audio?.pause();
      audio?.removeAttribute("src");
      audio?.load();
    } finally {
      runtime.revokeObjectURL(url);
    }
  }
}

export async function decodeAudioBlob(
  blob: Blob,
  options: { signal?: AbortSignal; runtime?: AudioImportRuntime } = {},
): Promise<{ samples: Float32Array; sampleRate: number }> {
  if (!blob.size || blob.size > MAX_IMPORT_BYTES) throw new Error("Audio file must be between 1 byte and 32 MB");
  const runtime = options.runtime ?? browserAudioRuntime();
  await inspectDuration(blob, runtime, options.signal);
  options.signal?.throwIfAborted();
  const encoded = await blob.arrayBuffer();
  options.signal?.throwIfAborted();
  const context = runtime.createContext();
  try {
    const audioBuffer = await context.decodeAudioData(encoded);
    options.signal?.throwIfAborted();
    // Recheck decoded data too: malformed or inconsistent container metadata
    // must not permit an oversized result into the modem worker.
    validateDuration(audioBuffer.length / audioBuffer.sampleRate);
    if (!Number.isFinite(audioBuffer.sampleRate) || audioBuffer.sampleRate < 8_000 ||
      audioBuffer.sampleRate > 48_000 || audioBuffer.numberOfChannels < 1) {
      throw new Error("Audio sample rate or channel count is invalid");
    }
    let strongestChannel = 0;
    let strongestEnergy = -1;
    for (let channel = 0; channel < audioBuffer.numberOfChannels; channel += 1) {
      let energy = 0;
      for (const sample of audioBuffer.getChannelData(channel)) {
        if (!Number.isFinite(sample)) throw new Error("Audio contains invalid samples");
        energy += sample * sample;
      }
      if (energy > strongestEnergy) { strongestEnergy = energy; strongestChannel = channel; }
    }
    // Preserve one channel instead of averaging: stereo recorders can capture
    // opposite polarities, whose arithmetic mean destroys the entire carrier.
    // Total energy is a heuristic; a louder noise channel can still win.
    return { samples: audioBuffer.getChannelData(strongestChannel).slice(), sampleRate: audioBuffer.sampleRate };
  } finally {
    // Preserve a decoding/cancellation error even if the browser has already
    // closed the context while navigating or releasing an audio device.
    try { await context.close(); } catch { /* Already closed. */ }
  }
}
