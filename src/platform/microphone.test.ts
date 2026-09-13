import { describe, expect, it, vi } from "vitest";
import {
  MicrophoneError,
  microphoneErrorMessage,
  normalizeMicrophoneError,
  requestMicrophoneStream,
  listMicrophoneInputs,
  type MicrophoneRuntime,
} from "./microphone";

function browserError(name: string, message = name): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

const rawAudio = {
  autoGainControl: { ideal: false },
  echoCancellation: { ideal: false },
  noiseSuppression: { ideal: false },
};

describe("microphone access", () => {
  it("preserves a selected endpoint through relaxed constraints and never enumerates alternatives", async () => {
    const getUserMedia = vi.fn()
      .mockRejectedValueOnce(browserError("OverconstrainedError"))
      .mockResolvedValueOnce({});
    const enumerateDevices = vi.fn();
    await requestMicrophoneStream({ secureContext: true, mediaDevices: { getUserMedia, enumerateDevices } }, { deviceId: "mic-2" });
    expect(getUserMedia).toHaveBeenNthCalledWith(1, {
      audio: { ...rawAudio, sampleRate: { ideal: 48_000 }, deviceId: { exact: "mic-2" } }, video: false,
    });
    expect(getUserMedia).toHaveBeenNthCalledWith(2, {
      audio: { ...rawAudio, deviceId: { exact: "mic-2" } }, video: false,
    });
    expect(enumerateDevices).not.toHaveBeenCalled();
  });

  it.each(["NotFoundError", "NotReadableError", "OverconstrainedError"])(
    "does not silently change an explicitly selected microphone after %s", async (name) => {
      const getUserMedia = vi.fn().mockRejectedValue(browserError(name));
      const enumerateDevices = vi.fn().mockResolvedValue([{ kind: "audioinput", deviceId: "another-mic" }]);
      await expect(requestMicrophoneStream({ secureContext: true, mediaDevices: { getUserMedia, enumerateDevices } },
        { deviceId: "selected-mic" })).rejects.toBeInstanceOf(MicrophoneError);
      expect(enumerateDevices).not.toHaveBeenCalled();
      for (const [constraints] of getUserMedia.mock.calls) {
        expect(constraints.audio.deviceId).toEqual({ exact: "selected-mic" });
      }
    },
  );

  it("lists distinct input choices without opening a device and tolerates permission-hidden labels", async () => {
    const getUserMedia = vi.fn();
    const enumerateDevices = vi.fn().mockResolvedValue([
      { kind: "audioinput", deviceId: "default", label: "Default" },
      { kind: "audiooutput", deviceId: "speaker", label: "Speaker" },
      { kind: "audioinput", deviceId: "mic", label: "" },
      { kind: "audioinput", deviceId: "mic", label: "" },
      { kind: "audioinput", deviceId: "usb", label: "USB microphone" },
    ]);
    const result = await listMicrophoneInputs({ secureContext: true, mediaDevices: { getUserMedia, enumerateDevices } });
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ deviceId: "mic", label: expect.stringContaining("麦克风") });
    expect(result[1]).toEqual({ deviceId: "usb", label: "USB microphone" });
    expect(getUserMedia).not.toHaveBeenCalled();
    enumerateDevices.mockRejectedValue(new Error("Permission policy"));
    await expect(listMicrophoneInputs({ secureContext: true, mediaDevices: { getUserMedia, enumerateDevices } })).resolves.toEqual([]);
  });

  it("rejects insecure pages before asking the browser for a device", async () => {
    const getUserMedia = vi.fn();
    const runtime = {
      secureContext: false,
      mediaDevices: { getUserMedia },
    } as unknown as MicrophoneRuntime;

    await expect(requestMicrophoneStream(runtime)).rejects.toMatchObject({ code: "insecure-context" });
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it("relaxes rate and channels without re-enabling voice processing", async () => {
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
    expect(getUserMedia).toHaveBeenNthCalledWith(2, { audio: rawAudio, video: false });
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
    expect(getUserMedia).toHaveBeenNthCalledWith(2, { audio: rawAudio, video: false });
    expect(getUserMedia).toHaveBeenNthCalledWith(3, {
      audio: { ...rawAudio, deviceId: { exact: "mic-1" } },
      video: false,
    });
  });

  it("relaxes capture preferences when a browser reports NotFound for preferred settings", async () => {
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
    expect(getUserMedia).toHaveBeenNthCalledWith(2, { audio: rawAudio, video: false });
  });

  it("tries the next distinct input when the first enumerated endpoint is unavailable", async () => {
    const stream = {} as MediaStream;
    const getUserMedia = vi.fn()
      .mockRejectedValueOnce(browserError("OverconstrainedError"))
      .mockRejectedValueOnce(browserError("NotFoundError"))
      .mockRejectedValueOnce(browserError("NotReadableError"))
      .mockResolvedValueOnce(stream);
    const enumerateDevices = vi.fn().mockResolvedValue([
      { kind: "audioinput", deviceId: "default" },
      { kind: "audioinput", deviceId: "mic-1" },
      { kind: "audioinput", deviceId: "mic-1" },
      { kind: "audioinput", deviceId: "mic-2" },
    ]);
    await expect(requestMicrophoneStream({ secureContext: true, mediaDevices: { getUserMedia, enumerateDevices } }))
      .resolves.toBe(stream);
    expect(getUserMedia).toHaveBeenCalledTimes(4);
    expect(getUserMedia).toHaveBeenLastCalledWith({
      audio: { ...rawAudio, deviceId: { exact: "mic-2" } }, video: false,
    });
  });

  it("never retries or enumerates devices after permission is denied", async () => {
    const getUserMedia = vi.fn().mockRejectedValue(browserError("NotAllowedError"));
    const enumerateDevices = vi.fn();
    await expect(requestMicrophoneStream({ secureContext: true, mediaDevices: { getUserMedia, enumerateDevices } }))
      .rejects.toMatchObject({ code: "permission-denied" });
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(enumerateDevices).not.toHaveBeenCalled();
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
