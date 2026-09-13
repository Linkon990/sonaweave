import type { GgWaveModule } from "ggwave";
import createGgWave from "ggwave-balanced";

/** ggwave 0.4.0 silently truncates longer variable-length payloads. */
export const GGWAVE_MAX_BYTES = 140;
export const GGWAVE_SAMPLE_RATE = 48_000;
const INPUT_BLOCK_SAMPLES = 4096;

export type GgWaveSpeed = "normal" | "fast" | "fastest";

export interface GgWaveTransmission {
  mode: "ggwave";
  text: string;
  rawBytes: Uint8Array;
  speed: GgWaveSpeed;
  signal: {
    mode: "ggwave";
    samples: Float32Array;
    sampleRate: number;
    durationSeconds: number;
  };
}

export interface GgWaveReport {
  mode: "ggwave";
  text: string;
  decodedBytes: Uint8Array;
  verification: "reed-solomon";
}

export interface GgWaveReceiver {
  /** Returns the first complete UTF-8 message recovered from this chunk. */
  push(samples: Float32Array): GgWaveReport | null;
  /** Flushes the final partial block and allows the end marker to complete. */
  finish(): GgWaveReport | null;
  close(): void;
}

let modulePromise: Promise<GgWaveModule> | undefined;

function getModule(): Promise<GgWaveModule> {
  modulePromise ??= createGgWave({ print: () => {}, printErr: () => {} }).then((module) => {
    module.disableLog();
    // These toggles are module globals: configure them once before any instance.
    // Keep the upstream 9/6/3 protocols for old recordings and add 5/4 for TX.
    module.configureBalancedProtocols();
    for (const [name, protocol] of Object.entries(module.ProtocolId)) {
      if (name.startsWith("GGWAVE_PROTOCOL_")) {
        const enabled = name.startsWith("GGWAVE_PROTOCOL_AUDIBLE_")
          || name === "GGWAVE_PROTOCOL_CUSTOM_0" || name === "GGWAVE_PROTOCOL_CUSTOM_1";
        module.rxToggleProtocol(protocol, enabled ? 1 : 0);
      }
    }
    return module;
  }).catch((error) => {
    modulePromise = undefined;
    throw error;
  });
  return modulePromise;
}

function initInstance(module: GgWaveModule, sampleRate: number, direction: "rx" | "tx", markerThreshold = 3): number {
  const parameters = module.getDefaultParameters();
  parameters.sampleRateInp = sampleRate;
  parameters.sampleRateOut = GGWAVE_SAMPLE_RATE;
  parameters.sampleFormatInp = module.SampleFormat.GGWAVE_SAMPLE_FORMAT_F32;
  parameters.sampleFormatOut = module.SampleFormat.GGWAVE_SAMPLE_FORMAT_F32;
  parameters.operatingMode = direction === "rx" ? module.GGWAVE_OPERATING_MODE_RX : module.GGWAVE_OPERATING_MODE_TX;
  parameters.soundMarkerThreshold = markerThreshold;
  const instance = module.init(parameters);
  if (instance < 0) throw new Error("声学引擎初始化失败，请重新开启接收。");
  return instance;
}

export async function encodeGgWaveMessage(text: string, speed: GgWaveSpeed = "fast"): Promise<GgWaveTransmission> {
  const rawBytes = new TextEncoder().encode(text);
  if (rawBytes.length === 0) throw new Error("请先输入要发送的文字。");
  if (rawBytes.length > GGWAVE_MAX_BYTES) {
    throw new Error(`ggwave 每次最多发送 ${GGWAVE_MAX_BYTES} 个 UTF-8 字节，请缩短消息。`);
  }
  if (speed !== "normal" && speed !== "fast" && speed !== "fastest") throw new Error("不支持的 ggwave 发送速度。");
  const module = await getModule();
  const instance = initInstance(module, GGWAVE_SAMPLE_RATE, "tx");
  try {
    const protocol = {
      normal: module.ProtocolId.GGWAVE_PROTOCOL_CUSTOM_0,
      fast: module.ProtocolId.GGWAVE_PROTOCOL_CUSTOM_1,
      fastest: module.ProtocolId.GGWAVE_PROTOCOL_AUDIBLE_FASTEST,
    }[speed];
    // Returned data is a borrowed WASM view. Own a copy before free or any
    // subsequent encode; byte reinterpretation preserves float32 PCM.
    const bytes = Uint8Array.from(module.encode(instance, rawBytes, protocol, 30));
    if (bytes.byteLength === 0 || bytes.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0) {
      throw new Error("声波生成失败，请重试。");
    }
    const samples = new Float32Array(bytes.buffer);
    return {
      mode: "ggwave", text, rawBytes, speed,
      signal: { mode: "ggwave", samples, sampleRate: GGWAVE_SAMPLE_RATE, durationSeconds: samples.length / GGWAVE_SAMPLE_RATE },
    };
  } finally {
    module.free(instance);
  }
}

export async function createGgWaveReceiver(sampleRate: number): Promise<GgWaveReceiver> {
  if (!Number.isFinite(sampleRate) || sampleRate < 8000 || sampleRate > 96_000) {
    throw new Error("ggwave 接收需要 8–96 kHz 的音频采样率。");
  }
  const module = await getModule();
  const instances = [initInstance(module, sampleRate, "rx")];
  try {
    // With the default threshold, some ordinary payloads (e.g. "first") are
    // mistaken for an end marker even on a perfect digital loopback. A second
    // stricter detector avoids that false marker while the default still
    // handles weaker signals. Neither changes the transmitted protocol.
    instances.push(initInstance(module, sampleRate, "rx", 6));
  } catch (error) {
    module.free(instances[0]);
    throw error;
  }
  const block = new Float32Array(INPUT_BLOCK_SAMPLES);
  let buffered = 0;
  let closed = false;
  let finished = false;

  function decodeBlock(): GgWaveReport | null {
    let first: GgWaveReport | null = null;
    for (const instance of instances) {
      const output = module.decode(instance, new Int8Array(block.buffer));
      if (output.length === 0) continue;
      const decodedBytes = Uint8Array.from(output);
      try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(decodedBytes);
        first ??= { mode: "ggwave", text, decodedBytes, verification: "reed-solomon" };
      } catch {
        // Another application may carry binary data: continue listening until
        // a valid UTF-8 packet arrives instead of displaying mojibake.
      }
    }
    return first;
  }

  function push(samples: Float32Array): GgWaveReport | null {
    if (closed || finished) throw new Error("接收会话已结束，请重新开启接收。");
    let first: GgWaveReport | null = null;
    let offset = 0;
    while (offset < samples.length) {
      const count = Math.min(block.length - buffered, samples.length - offset);
      const slice = samples.subarray(offset, offset + count);
      for (const sample of slice) {
        if (!Number.isFinite(sample)) throw new Error("录音中包含无效的音频采样。");
      }
      block.set(slice, buffered);
      buffered += count;
      offset += count;
      if (buffered === block.length) {
        // ggwave 0.4.0 loses timing on 128-sample worklet blocks, and at 44.1k
        // with 1024-sample chunks. 4096 passes both streaming regressions.
        const report = decodeBlock();
        first ??= report;
        buffered = 0;
      }
    }
    return first;
  }

  return {
    push,
    finish() {
      if (closed || finished) return null;
      // Preserve the partial block. A short zero tail also lets the library
      // inspect a complete end marker when an imported WAV ends immediately.
      const report = push(new Float32Array(Math.ceil(sampleRate * 0.3) + INPUT_BLOCK_SAMPLES));
      finished = true;
      return report;
    },
    close() {
      if (closed) return;
      closed = true;
      for (const instance of instances) module.free(instance);
    },
  };
}

export async function decodeGgWave(samples: Float32Array, sampleRate: number): Promise<GgWaveReport> {
  if (samples.length === 0) throw new Error("录音为空，请先录下完整声波。");
  if (samples.length > sampleRate * 120) throw new Error("请导入 120 秒以内的录音。");
  const receiver = await createGgWaveReceiver(sampleRate);
  try {
    const report = receiver.push(samples) ?? receiver.finish();
    if (!report) throw new Error("尚未收到完整的 ggwave 文字包。请先开启接收，再播放完整声波。");
    return report;
  } finally {
    receiver.close();
  }
}
