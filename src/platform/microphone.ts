export type MicrophoneErrorCode =
  | "insecure-context"
  | "unsupported"
  | "permission-denied"
  | "device-not-found"
  | "device-busy"
  | "constraints"
  | "aborted"
  | "recording-failed"
  | "unknown";

export class MicrophoneError extends Error {
  readonly code: MicrophoneErrorCode;
  readonly originalName?: string;

  constructor(
    code: MicrophoneErrorCode,
    message: string,
    options: { cause?: unknown; originalName?: string } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "MicrophoneError";
    this.code = code;
    this.originalName = options.originalName;
  }
}

interface MediaDevicesLike {
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>;
  enumerateDevices?(): Promise<MediaDeviceInfo[]>;
}

export interface MicrophoneRuntime {
  secureContext: boolean;
  mediaDevices?: MediaDevicesLike;
}

const PREFERRED_AUDIO_CONSTRAINTS: MediaTrackConstraints = {
  autoGainControl: { ideal: false },
  channelCount: { ideal: 1 },
  echoCancellation: { ideal: false },
  noiseSuppression: { ideal: false },
  sampleRate: { ideal: 48_000 },
};

function currentRuntime(): MicrophoneRuntime {
  return {
    secureContext: typeof window !== "undefined" && window.isSecureContext,
    mediaDevices: typeof navigator !== "undefined" ? navigator.mediaDevices : undefined,
  };
}

function errorName(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("name" in error)) return undefined;
  return typeof error.name === "string" ? error.name : undefined;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "Microphone access failed";
}

export function normalizeMicrophoneError(error: unknown): MicrophoneError {
  if (error instanceof MicrophoneError) return error;

  const originalName = errorName(error);
  let code: MicrophoneErrorCode;

  switch (originalName) {
    case "NotAllowedError":
    case "PermissionDeniedError":
    case "SecurityError":
      code = "permission-denied";
      break;
    case "NotFoundError":
    case "DevicesNotFoundError":
      code = "device-not-found";
      break;
    case "NotReadableError":
    case "TrackStartError":
      code = "device-busy";
      break;
    case "OverconstrainedError":
    case "ConstraintNotSatisfiedError":
      code = "constraints";
      break;
    case "AbortError":
      code = "aborted";
      break;
    case "NotSupportedError":
      code = "unsupported";
      break;
    default:
      code = "unknown";
  }

  return new MicrophoneError(code, errorMessage(error), { cause: error, originalName });
}

async function retrySpecificInput(mediaDevices: MediaDevicesLike): Promise<MediaStream | undefined> {
  if (!mediaDevices.enumerateDevices) return undefined;

  let inputs: MediaDeviceInfo[];
  try {
    inputs = (await mediaDevices.enumerateDevices()).filter(
      (device) => device.kind === "audioinput" && Boolean(device.deviceId) && device.deviceId !== "default",
    );
  } catch {
    return undefined;
  }

  if (inputs.length === 0) return undefined;

  return mediaDevices.getUserMedia({
    audio: { deviceId: { exact: inputs[0].deviceId } },
    video: false,
  });
}

export async function requestMicrophoneStream(runtime: MicrophoneRuntime = currentRuntime()): Promise<MediaStream> {
  if (!runtime.secureContext) {
    throw new MicrophoneError("insecure-context", "Microphone access requires a secure context");
  }

  const mediaDevices = runtime.mediaDevices;
  if (!mediaDevices?.getUserMedia) {
    throw new MicrophoneError("unsupported", "getUserMedia is unavailable in this browser");
  }

  try {
    return await mediaDevices.getUserMedia({
      audio: PREFERRED_AUDIO_CONSTRAINTS,
      video: false,
    });
  } catch (error) {
    const normalized = normalizeMicrophoneError(error);

    if (normalized.code === "constraints" || normalized.code === "device-not-found") {
      try {
        return await mediaDevices.getUserMedia({ audio: true, video: false });
      } catch (fallbackError) {
        const fallback = normalizeMicrophoneError(fallbackError);
        if (fallback.code !== "device-not-found") throw fallback;
      }
    }

    if (normalized.code === "device-not-found") {
      try {
        const stream = await retrySpecificInput(mediaDevices);
        if (stream) return stream;
      } catch (fallbackError) {
        throw normalizeMicrophoneError(fallbackError);
      }
    }

    throw normalized;
  }
}

export function microphoneErrorMessage(error: unknown, nativeApp = false): string {
  const normalized = normalizeMicrophoneError(error);

  switch (normalized.code) {
    case "insecure-context":
      return "当前页面不是安全上下文。请通过 HTTPS 打开，或在本机使用 localhost。";
    case "permission-denied":
      return nativeApp
        ? "麦克风权限被拒绝。请在系统设置中允许 SonaWeave 使用麦克风后重试。"
        : "麦克风权限被拒绝。请在浏览器的站点权限中允许麦克风后重试。";
    case "device-not-found":
      return "未检测到可用的录音设备。请连接或启用麦克风，并确认系统已选择输入设备。";
    case "device-busy":
      return "麦克风无法读取，可能正被其他程序独占。请关闭占用录音设备的程序后重试。";
    case "constraints":
      return "麦克风不支持当前录音参数。请切换输入设备后重试。";
    case "aborted":
      return "麦克风启动被系统中断，请重试。";
    case "unsupported":
      return "当前浏览器不支持所需的麦克风录音 API。请改用最新版 Chrome、Edge 或 Safari。";
    case "recording-failed":
      return "录音过程中发生错误，请确认麦克风仍处于连接状态后重试。";
    default:
      return `无法启动麦克风：${normalized.message}`;
  }
}

export function preferredRecorderMimeType(): string | undefined {
  if (typeof MediaRecorder === "undefined" || typeof MediaRecorder.isTypeSupported !== "function") {
    return undefined;
  }

  return ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find((type) =>
    MediaRecorder.isTypeSupported(type),
  );
}
