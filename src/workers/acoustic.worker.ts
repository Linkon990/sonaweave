import { createGgWaveReceiver, decodeGgWave, encodeGgWaveMessage } from "../acoustic/ggwave";
import type { AcousticCommand } from "../acoustic/messages";
import { decodeSamplesAuto } from "../core/protocol";

let receiver: Awaited<ReturnType<typeof createGgWaveReceiver>> | undefined;
let inputRate = 0;
let terminal = false;
let receivedSeconds = 0;

function validate(samples: Float32Array, rate: number) {
  if (!Number.isFinite(rate) || rate < 8_000 || rate > 96_000) {
    throw new Error("ggwave 接收需要 8–96 kHz 的音频采样率，请切换输入设备或导入 48 kHz WAV。");
  }
  if (!(samples instanceof Float32Array) || samples.length / rate > 120) throw new Error("录音格式无效或超过 120 秒。");
  for (const sample of samples) if (!Number.isFinite(sample)) throw new Error("录音中包含无效的音频采样。");
}

async function handle(command: AcousticCommand) {
  if (terminal) return;
  try {
    if (command.type === "encode") {
      const transmission = await encodeGgWaveMessage(command.text, command.speed);
      terminal = true;
      self.postMessage({ type: "encoded", transmission }, { transfer: [transmission.signal.samples.buffer as ArrayBuffer] });
    } else if (command.type === "decode") {
      validate(command.samples, command.sampleRate);
      try {
        const report = await decodeGgWave(command.samples, command.sampleRate);
        terminal = true;
        self.postMessage({ type: "decoded", report });
      } catch (ggwaveError) {
        try {
          const report = decodeSamplesAuto(command.samples, command.sampleRate);
          terminal = true;
          self.postMessage({ type: "decoded", report });
        } catch (legacyError) {
          throw new Error(`ggwave：${ggwaveError instanceof Error ? ggwaveError.message : "解码失败"}；` +
            `兼容 FSK/DTMF：${legacyError instanceof Error ? legacyError.message : "解码失败"}`);
        }
      }
    } else if (command.type === "prepare") {
      receiver?.close();
      receiver = await createGgWaveReceiver(48_000);
      inputRate = 48_000;
      self.postMessage({ type: "ready" });
    } else if (command.type === "finish") {
      const report = receiver?.finish();
      receiver?.close(); receiver = undefined;
      terminal = true;
      self.postMessage(report ? { type: "decoded", report } : { type: "finished" });
    } else if (command.type === "chunk") {
      validate(command.samples, command.sampleRate);
      if (receivedSeconds > 0 && inputRate !== command.sampleRate) throw new Error("录音采样率发生变化，请重新开启接收。");
      receivedSeconds += command.samples.length / command.sampleRate;
      if (receivedSeconds > 120 + 1e-6) throw new Error("接收已达到 120 秒上限，请重新开启接收。");
      if (!receiver || inputRate !== command.sampleRate) {
        receiver?.close();
        receiver = await createGgWaveReceiver(command.sampleRate);
        inputRate = command.sampleRate;
      }
      const report = receiver.push(command.samples);
      if (report) {
        terminal = true;
        receiver.close(); receiver = undefined;
        self.postMessage({ type: "decoded", report });
      }
    } else throw new Error("Unsupported acoustic worker command");
  } catch (error) {
    terminal = true;
    receiver?.close(); receiver = undefined;
    self.postMessage({ type: "error", error: error instanceof Error ? error.message : "Acoustic decoder failed" });
  }
}

// Audio messages may arrive while WASM is initializing. Preserve PCM order.
let queue = Promise.resolve();
self.onmessage = (event: MessageEvent<AcousticCommand>) => {
  queue = queue.then(() => handle(event.data));
};
