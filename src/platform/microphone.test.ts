import { describe, expect, it, vi } from "vitest";
import {
  MicrophoneError,
  microphoneErrorMessage,
  normalizeMicrophoneError,
  requestMicrophoneStream,
  type MicrophoneRuntime,
} from "./microphone";

function browserError(name: string, message = name): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

describe("microphone access", () => {
  it("rejects insecure pages before asking the browser for a device", async () => {
    const getUserMedia = vi.fn();
    const runtime = {
      secureContext: false,
      mediaDevices: { getUserMedia },
    } as unknown as MicrophoneRuntime;

    await expect(requestMicrophoneStream(runtime)).rejects.toMatchObject({ code: "insecure-context" });
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it("falls back to basic audio when preferred constraints are unsupported", async () => {
    const stream = {} as MediaStream;
    const getUserMedia = vi
      .fn()
      .mockRejectedValueOnce(browserError("OverconstrainedError"))
      .mockResolvedValueOnce(stream);
    const runtime = {
      secureContext: true,
      mediaDevices: { getUserMedia },
    } as unknown as MicrophoneRuntime;

    await expect(requestMicrophoneStream(runtime)).resolves.toBe(stream);
    expect(getUserMedia).toHaveBeenNthCalledWith(2, { audio: true, video: false });
  });

  it("retries an enumerated input when the default device is missing", async () => {
    const stream = {} as MediaStream;
    const getUserMedia = vi
      .fn()
      .mockRejectedValueOnce(browserError("NotFoundError"))
      .mockRejectedValueOnce(browserError("NotFoundError"))
      .mockResolvedValueOnce(stream);
    const enumerateDevices = vi.fn().mockResolvedValue([
      { kind: "audiooutput", deviceId: "speaker-1" },
      { kind: "audioinput", deviceId: "mic-1" },
    ]);
    const runtime = {
      secureContext: true,
      mediaDevices: { getUserMedia, enumerateDevices },
    } as unknown as MicrophoneRuntime;

    await expect(requestMicrophoneStream(runtime)).resolves.toBe(stream);
    expect(getUserMedia).toHaveBeenNthCalledWith(2, { audio: true, video: false });
    expect(getUserMedia).toHaveBeenNthCalledWith(3, {
      audio: { deviceId: { exact: "mic-1" } },
      video: false,
    });
  });

  it("uses unconstrained audio when a browser reports NotFound for preferred settings", async () => {
    const stream = {} as MediaStream;
    const getUserMedia = vi
      .fn()
      .mockRejectedValueOnce(browserError("NotFoundError"))
      .mockResolvedValueOnce(stream);
    const runtime = {
      secureContext: true,
      mediaDevices: { getUserMedia },
    } as unknown as MicrophoneRuntime;

    await expect(requestMicrophoneStream(runtime)).resolves.toBe(stream);
    expect(getUserMedia).toHaveBeenNthCalledWith(2, { audio: true, video: false });
  });

  it.each([
    ["NotAllowedError", "permission-denied", "权限被拒绝"],
    ["NotFoundError", "device-not-found", "未检测到"],
    ["NotReadableError", "device-busy", "其他程序独占"],
  ])("maps %s to an actionable error", (name, code, copy) => {
    const normalized = normalizeMicrophoneError(browserError(name));
    expect(normalized).toBeInstanceOf(MicrophoneError);
    expect(normalized.code).toBe(code);
    expect(microphoneErrorMessage(normalized)).toContain(copy);
  });
});
