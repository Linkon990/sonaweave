import type { ModemMode } from "../core/modem";
import type { DecodeReport } from "../core/protocol";

/** Each job owns its worker, so cancel really stops DSP work and frees its buffers. */
export function decodeInWorker(
  samples: Float32Array,
  sampleRate: number,
  options: { mode?: ModemMode; signal: AbortSignal },
): Promise<DecodeReport> {
  return new Promise((resolve, reject) => {
    if (options.signal.aborted) {
      reject(new DOMException("Decode cancelled", "AbortError"));
      return;
    }
    const worker = new Worker(new URL("../workers/decode.worker.ts", import.meta.url), { type: "module" });
    const finish = (error?: Error, report?: DecodeReport) => {
      clearTimeout(timer);
      options.signal.removeEventListener("abort", cancel);
      worker.terminate();
      if (error) reject(error);
      else resolve(report!);
    };
    const cancel = () => finish(new DOMException("Decode cancelled", "AbortError"));
    const timer = setTimeout(() => finish(new Error("Decode timed out")), 45_000);
    options.signal.addEventListener("abort", cancel, { once: true });
    worker.onmessage = (event: MessageEvent<{ report?: DecodeReport; error?: string }>) => {
      finish(event.data.error ? new Error(event.data.error) : undefined, event.data.report);
    };
    worker.onerror = () => finish(new Error("Unable to start audio decoder"));
    // Keep the original buffer for the waveform; only transfer this job's copy.
    const copy = samples.slice();
    try {
      worker.postMessage({ samples: copy, sampleRate, mode: options.mode }, [copy.buffer]);
    } catch (error) {
      finish(error instanceof Error ? error : new Error("Unable to start audio decoder"));
    }
  });
}

export function decodeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (/No audible signal|empty/i.test(message)) return "没有录到有效声音。请确认输入音量条有变化，等到“正在监听声波”后，再让另一台设备播放。";
  if (/truncated|shorter than/i.test(message)) return "录音中的消息不完整。请先开始接收，等待音频播放完，再点击“停止并解码”。";
  if (/CRC|uncorrectable|Payload length|UTF-8|LZW/i.test(message)) return "已收到声波，但数据校验没有通过。请缩短距离、适当调低过大的播放音量，或改用 DTMF 发送短消息重试。";
  if (/training|sync marker|complete SonaWeave|Unsupported SWP/i.test(message)) return "没有找到完整的 SonaWeave 声波消息。请先开始接收，再从头播放；可尝试 DTMF，并让两台设备靠近一些。";
  if (/timed out/i.test(message)) return "这段音频分析用时过长，已停止。请使用更短的录音重试。";
  if (/Unable to start audio decoder/i.test(message)) return "音频分析器未能启动，请重新打开页面或应用后重试。";
  if (/duration|too long|sample rate|invalid samples/i.test(message)) return "音频参数无效或时长超过 120 秒，请导入较短的有效音频。";
  return "无法读取这段音频。请使用有效的 WAV 音频，或重新录音后重试。";
}
