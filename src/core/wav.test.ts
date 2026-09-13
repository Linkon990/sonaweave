import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeAudioBlob, type AudioImportRuntime } from "./wav";

class MetadataAudio extends EventTarget {
  duration = 1;
  preload = "";
  src = "";
  load = vi.fn();
  pause = vi.fn();
  removeAttribute = vi.fn();
}

function fixture(channels = [new Float32Array([0.25, -0.25])]) {
  const audio = new MetadataAudio();
  const audioBuffer = {
    length: channels[0]?.length ?? 0,
    sampleRate: 48_000,
    numberOfChannels: channels.length,
    getChannelData: vi.fn((channel: number) => channels[channel]),
  };
  const context = {
    decodeAudioData: vi.fn().mockResolvedValue(audioBuffer),
    close: vi.fn().mockResolvedValue(undefined),
  };
  const runtime = {
    createAudio: vi.fn(() => audio as unknown as HTMLAudioElement),
    createObjectURL: vi.fn(() => "blob:local-audio-test"),
    revokeObjectURL: vi.fn(),
    createContext: vi.fn(() => context as unknown as AudioContext),
  } satisfies AudioImportRuntime;
  const blob = new Blob(["encoded audio"], { type: "audio/mpeg" });
  const arrayBuffer = vi.spyOn(blob, "arrayBuffer");
  const metadata = (duration = 1) => {
    audio.duration = duration;
    audio.dispatchEvent(new Event("loadedmetadata"));
  };
  const cleanMetadata = () => {
    expect(audio.pause).toHaveBeenCalledOnce();
    expect(audio.removeAttribute).toHaveBeenCalledWith("src");
    expect(runtime.revokeObjectURL).toHaveBeenCalledExactlyOnceWith("blob:local-audio-test");
  };
  return { audio, audioBuffer, context, runtime, blob, arrayBuffer, metadata, cleanMetadata };
}

afterEach(() => vi.useRealTimers());

describe("bounded audio file import", () => {
  it("reads local metadata before creating a decoder or reading the entire file", async () => {
    const f = fixture();
    const result = decodeAudioBlob(f.blob, { runtime: f.runtime });
    expect(f.audio.preload).toBe("metadata");
    expect(f.audio.src).toBe("blob:local-audio-test");
    expect(f.runtime.createContext).not.toHaveBeenCalled();
    expect(f.arrayBuffer).not.toHaveBeenCalled();
    f.metadata();
    await expect(result).resolves.toEqual({ samples: new Float32Array([0.25, -0.25]), sampleRate: 48_000 });
    f.cleanMetadata();
    expect(f.context.close).toHaveBeenCalledOnce();
  });

  it.each([0, -1, NaN, Infinity, 120.1, 3_600])("refuses duration %s before allocating full decoded PCM", async (duration) => {
    const f = fixture();
    const result = decodeAudioBlob(f.blob, { runtime: f.runtime });
    f.metadata(duration);
    await expect(result).rejects.toThrow(/duration/);
    expect(f.runtime.createContext).not.toHaveBeenCalled();
    expect(f.arrayBuffer).not.toHaveBeenCalled();
    f.cleanMetadata();
  });

  it("accepts the 120-second metadata boundary", async () => {
    const f = fixture();
    const result = decodeAudioBlob(f.blob, { runtime: f.runtime });
    f.metadata(120);
    await expect(result).resolves.toHaveProperty("sampleRate", 48_000);
  });

  it("rejects empty or oversized files before creating any browser resources", async () => {
    const f = fixture();
    for (const size of [0, 32 * 1024 * 1024 + 1]) {
      await expect(decodeAudioBlob({ size } as Blob, { runtime: f.runtime })).rejects.toThrow(/32 MB/);
    }
    expect(f.runtime.createAudio).not.toHaveBeenCalled();
    expect(f.runtime.createObjectURL).not.toHaveBeenCalled();
    expect(f.runtime.createContext).not.toHaveBeenCalled();
  });

  it.each(["error", "timeout", "cancel"])("releases metadata resources after %s without starting a decoder", async (event) => {
    vi.useFakeTimers();
    const f = fixture();
    const controller = new AbortController();
    const result = decodeAudioBlob(f.blob, { runtime: f.runtime, signal: controller.signal });
    const rejected = expect(result).rejects.toBeInstanceOf(Error);
    if (event === "error") f.audio.dispatchEvent(new Event("error"));
    else if (event === "timeout") await vi.advanceTimersByTimeAsync(10_000);
    else controller.abort();
    await rejected;
    f.cleanMetadata();
    expect(f.runtime.createContext).not.toHaveBeenCalled();
    expect(f.arrayBuffer).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not create a Blob URL when import is already cancelled", async () => {
    const f = fixture();
    const controller = new AbortController();
    controller.abort();
    await expect(decodeAudioBlob(f.blob, { runtime: f.runtime, signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(f.runtime.createObjectURL).not.toHaveBeenCalled();
  });

  it("revokes the Blob URL even if constructing the metadata element fails", async () => {
    const f = fixture();
    f.runtime.createAudio.mockImplementation(() => { throw new Error("Element unavailable"); });
    await expect(decodeAudioBlob(f.blob, { runtime: f.runtime })).rejects.toThrow("Element unavailable");
    expect(f.runtime.revokeObjectURL).toHaveBeenCalledExactlyOnceWith("blob:local-audio-test");
    expect(f.runtime.createContext).not.toHaveBeenCalled();
  });

  it("checks actual decoded duration when container metadata was inconsistent", async () => {
    const f = fixture();
    f.audioBuffer.length = 121 * 48_000;
    const result = decodeAudioBlob(f.blob, { runtime: f.runtime });
    f.metadata(1);
    await expect(result).rejects.toThrow(/duration/);
    expect(f.audioBuffer.getChannelData).not.toHaveBeenCalled();
    expect(f.context.close).toHaveBeenCalledOnce();
  });

  it("preserves decoder errors and still closes the AudioContext", async () => {
    const f = fixture();
    f.context.decodeAudioData.mockRejectedValue(new Error("Invalid encoded data"));
    f.context.close.mockRejectedValue(new Error("Context already closed"));
    const result = decodeAudioBlob(f.blob, { runtime: f.runtime });
    f.metadata();
    await expect(result).rejects.toThrow("Invalid encoded data");
    expect(f.context.close).toHaveBeenCalledOnce();
    f.cleanMetadata();
  });

  it("discards a decode result arriving after cancellation and closes the context", async () => {
    const f = fixture();
    const controller = new AbortController();
    f.context.decodeAudioData.mockImplementation(async () => {
      controller.abort();
      return f.audioBuffer;
    });
    const result = decodeAudioBlob(f.blob, { runtime: f.runtime, signal: controller.signal });
    f.metadata();
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(f.context.close).toHaveBeenCalledOnce();
  });
});

describe("stereo carrier preservation", () => {
  it("preserves opposite-polarity stereo instead of cancelling the carrier by averaging", async () => {
    const f = fixture([new Float32Array([0.5, -0.5]), new Float32Array([-0.5, 0.5])]);
    const result = decodeAudioBlob(f.blob, { runtime: f.runtime });
    f.metadata();
    expect([...(await result).samples]).toEqual([0.5, -0.5]);
  });

  it("selects the stronger input when one channel is quiet and returns independent PCM", async () => {
    const f = fixture([new Float32Array([0.01, -0.01]), new Float32Array([0.5, -0.5])]);
    const result = decodeAudioBlob(f.blob, { runtime: f.runtime });
    f.metadata();
    const { samples } = await result;
    expect([...samples]).toEqual([0.5, -0.5]);
    samples.fill(0);
    expect([...f.audioBuffer.getChannelData(1)]).toEqual([0.5, -0.5]);
  });

  it("rejects non-finite decoded samples before passing them to the modem", async () => {
    const f = fixture([new Float32Array([NaN, 0.5])]);
    const result = decodeAudioBlob(f.blob, { runtime: f.runtime });
    f.metadata();
    await expect(result).rejects.toThrow(/invalid samples/);
    expect(f.context.close).toHaveBeenCalledOnce();
  });
});
