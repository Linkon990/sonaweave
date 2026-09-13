import { MicrophoneError, normalizeMicrophoneError, requestMicrophoneStream } from "./microphone";
import { analyzeAudio, captureTrackSettings, chooseInputChannel, type AudioDiagnostics,
  type CaptureTrackSettings } from "./audioDiagnostics";

export type RecorderStatus = "idle" | "requesting" | "recording" | "ready" | "processing" | "error";
export type RecorderBackend = "AudioWorklet" | "ScriptProcessor";
export type RecorderStartOptions = {
  deviceId?: string;
  /** Runs asynchronously on a separate copy. Keep this callback short (e.g. worker.postMessage). */
  onSamples?: (samples: Float32Array, sampleRate: number) => void | Promise<void>;
};
export type RecordingDiagnostics = AudioDiagnostics & {
  schemaVersion: 1;
  startedAt: string;
  startupMs: number;
  wallDurationMs: number;
  requestedDevice: "default" | "selected";
  trackSettings: CaptureTrackSettings;
  deviceLabel: string;
  backend?: RecorderBackend;
  observedChannels: number;
  /** Zero-based source channel; it is never an average of channels. */
  selectedChannel: number;
  blockCount: number;
  longestDeliveryGapMs: number;
  completion: "stopped" | "limit" | "error";
  errorCode?: MicrophoneError["code"];
};
// Imports and generated signals may have no capture metadata.
export type PcmRecording = { samples: Float32Array; sampleRate: number; diagnostics?: RecordingDiagnostics };
export type RecorderSnapshot = {
  status: RecorderStatus;
  deviceLabel?: string;
  backend?: RecorderBackend;
  error: MicrophoneError | null;
  warning: string | null;
  rms: number;
  level: number;
  elapsedSeconds: number;
  maxDurationSeconds: number;
};

export interface RecorderRuntime {
  requestStream(options?: Pick<RecorderStartOptions, "deviceId">): Promise<MediaStream>;
  createContext(): AudioContext;
  createWorklet(context: AudioContext): AudioWorkletNode;
  requestWakeLock?(): Promise<{ release(): Promise<void> }>;
  page?: Pick<Document, "hidden" | "addEventListener" | "removeEventListener">;
}

function browserRuntime(): RecorderRuntime {
  return {
    requestStream: (options) => requestMicrophoneStream(undefined, options),
    createContext: () => {
      if (typeof AudioContext === "undefined") {
        throw new MicrophoneError("unsupported", "PCM audio capture is unavailable");
      }
      // Use the device's actual sample rate; the decoder accepts it directly.
      return new AudioContext({ latencyHint: "interactive" });
    },
    createWorklet: (context) => new AudioWorkletNode(context, "sonaweave-pcm", {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
      // Preserve stereo/array inputs. A mono downmix can cancel opposite polarities.
      channelCountMode: "max",
    }),
    requestWakeLock: typeof navigator !== "undefined" && navigator.wakeLock?.request
      ? () => navigator.wakeLock.request("screen") : undefined,
    page: typeof document === "undefined" ? undefined : document,
  };
}

type Session = {
  context?: AudioContext;
  stream?: MediaStream;
  source?: MediaStreamAudioSourceNode;
  worklet?: AudioWorkletNode;
  processor?: ScriptProcessorNode;
  sink?: GainNode;
  chunks: Float32Array[];
  length: number;
  lastSampleAt: number;
  lastMeterAt: number;
  started: boolean;
  stopping: boolean;
  wakeLockRequested: boolean;
  options: RecorderStartOptions;
  requestedAt: number;
  firstSampleAt: number;
  blockCount: number;
  longestDeliveryGapMs: number;
  trackSettings: CaptureTrackSettings;
  deviceLabel: string;
  backend?: RecorderBackend;
  observedChannels: number;
  selectedChannel: number | null;
  scriptSelectedChannel: number | null;
  cancelled: boolean;
  cleanups: (() => void)[];
  resolveStart(): void;
  rejectStart(error: Error): void;
  resolveStop?: (recording: PcmRecording) => void;
  rejectStop?: (error: Error) => void;
};

/** Owns the entire permission/PCM lifecycle independently of React rendering. */
export class PcmRecorder {
  private snapshot: RecorderSnapshot;
  private listeners = new Set<() => void>();
  private session: Session | null = null;
  private completed: PcmRecording | null = null;
  private lastRecording: PcmRecording | null = null;
  private stopPromise: Promise<PcmRecording> | null = null;

  constructor(private runtime: RecorderRuntime = browserRuntime(), maxDurationSeconds = 120) {
    this.snapshot = {
      status: "idle", error: null, warning: null, rms: 0, level: 0,
      elapsedSeconds: 0, maxDurationSeconds,
    };
  }

  getSnapshot = () => this.snapshot;
  getLastRecording = () => this.lastRecording;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private update(patch: Partial<RecorderSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    this.listeners.forEach((listener) => listener());
  }

  start = (options: RecorderStartOptions = {}): Promise<void> => {
    if (this.session || !["idle", "error"].includes(this.snapshot.status)) {
      return Promise.reject(new MicrophoneError("recording-failed", "A recording is already active"));
    }
    this.completed = null;
    this.lastRecording = null;
    this.stopPromise = null;
    let resolveStart!: () => void;
    let rejectStart!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => { resolveStart = resolve; rejectStart = reject; });
    const session: Session = {
      chunks: [], length: 0, lastSampleAt: 0, lastMeterAt: 0,
      started: false, stopping: false, wakeLockRequested: false, cleanups: [], resolveStart, rejectStart,
      options: { ...options }, requestedAt: Date.now(), firstSampleAt: 0,
      blockCount: 0, longestDeliveryGapMs: 0, trackSettings: {}, deviceLabel: "系统默认麦克风",
      observedChannels: 0, selectedChannel: null, scriptSelectedChannel: null, cancelled: false,
    };
    this.session = session;
    this.update({ status: "requesting", error: null, warning: null, deviceLabel: undefined,
      backend: undefined, rms: 0, level: 0, elapsedSeconds: 0 });
    // setup creates/resumes AudioContext synchronously within the user's gesture.
    void this.setup(session).catch((error) => this.fail(session, normalizeMicrophoneError(error)));
    return ready;
  };

  private async setup(session: Session) {
    const context = this.runtime.createContext();
    session.context = context;
    const resumed = context.resume().catch((error) => {
      this.fail(session, normalizeMicrophoneError(error));
    });
    const page = this.runtime.page;
    const visibilityChanged = () => {
      // Native permission sheets can temporarily hide a WebView during start.
      if (page?.hidden && session.started) {
        this.fail(session, new MicrophoneError("interrupted", "Recording page was backgrounded"));
      } else if (!page?.hidden && session.started) {
        void this.keepScreenAwake(session);
      }
    };
    page?.addEventListener("visibilitychange", visibilityChanged);
    session.cleanups.push(() => page?.removeEventListener("visibilitychange", visibilityChanged));

    const stream = await this.runtime.requestStream({ deviceId: session.options.deviceId });
    // Permission prompts cannot be aborted. A cancelled/unmounted request must
    // immediately release a stream that the browser grants later.
    if (this.session !== session) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    session.stream = stream;
    const track = stream.getAudioTracks()[0];
    if (!track || track.readyState === "ended") {
      throw new MicrophoneError("device-not-found", "No live audio track was returned");
    }
    const settings = track.getSettings();
    session.trackSettings = captureTrackSettings(settings);
    session.deviceLabel = track.label || "系统默认麦克风";
    const processing = settings.autoGainControl || settings.echoCancellation || settings.noiseSuppression;
    this.update({ deviceLabel: session.deviceLabel, warning: processing
      ? "设备仍启用了语音增强，可能影响声波识别；可在系统中关闭降噪或更换输入设备。" : null });
    const interrupted = () => this.fail(session, new MicrophoneError("interrupted", "Audio input ended or was muted"));
    let muteTimer: ReturnType<typeof setTimeout> | undefined;
    const muted = () => {
      // Some Android audio routes begin muted while the microphone warms up.
      // The first-frame timeout handles that case; a running stream gets a
      // short grace period for a transient device route change.
      if (session.started) {
        clearTimeout(muteTimer);
        muteTimer = setTimeout(interrupted, 1_500);
      }
    };
    const unmuted = () => clearTimeout(muteTimer);
    track.addEventListener("ended", interrupted);
    track.addEventListener("mute", muted);
    track.addEventListener("unmute", unmuted);
    session.cleanups.push(() => {
      track.removeEventListener("ended", interrupted);
      track.removeEventListener("mute", muted);
      track.removeEventListener("unmute", unmuted);
      clearTimeout(muteTimer);
    });
    const startupTimer = setTimeout(() => {
      if (!session.started) this.fail(session, new MicrophoneError("no-audio", "No PCM frames arrived"));
    }, 8_000);
    session.cleanups.push(() => clearTimeout(startupTimer));
    await resumed;
    if (this.session !== session) return;
    if (context.state !== "running") throw new MicrophoneError("no-audio", "AudioContext did not start");

    if (context.audioWorklet) {
      try {
        await context.audioWorklet.addModule(new URL("../worklets/pcm-recorder.js?no-inline", import.meta.url).href);
        if (this.session !== session) return;
        const worklet = this.runtime.createWorklet(context);
        session.worklet = worklet;
        worklet.port.onmessage = (event: MessageEvent) => {
          if (event.data?.samples instanceof Float32Array) {
            this.acceptSamples(session, event.data.samples, event.data);
          }
          if (event.data?.type === "flushed" && session.stopping) this.finish(session, "processing");
        };
        worklet.onprocessorerror = () => this.fail(session,
          new MicrophoneError("recording-failed", "PCM audio processor failed"));
        session.backend = "AudioWorklet";
        this.update({ backend: session.backend });
      } catch {
        if (this.session !== session) return;
        // Older WebViews may lack AudioWorklet/module support. Capture PCM on
        // their main thread as well, never silently substitute Opus/AAC.
      }
    }
    if (!session.worklet) {
      if (typeof context.createScriptProcessor !== "function") {
        throw new MicrophoneError("unsupported", "No raw PCM capture API is available");
      }
      // With unknown settings, request two inputs so a stereo route is preserved.
      // A genuine mono source may be duplicated by Web Audio, but not averaged away.
      const inputChannels = Math.max(1, Math.min(32, Math.floor(settings.channelCount || 2)));
      session.processor = context.createScriptProcessor(2048, inputChannels, 1);
      session.processor.onaudioprocess = (event) => {
        try {
          const count = event.inputBuffer.numberOfChannels || 1;
          const channels = Array.from({ length: count }, (_, index) => event.inputBuffer.getChannelData(index));
          session.scriptSelectedChannel = chooseInputChannel(channels, session.scriptSelectedChannel);
          this.acceptSamples(session, channels[session.scriptSelectedChannel ?? 0].slice(), {
            observedChannels: count, selectedChannel: session.scriptSelectedChannel ?? 0,
          });
          // ScriptProcessor has no flush API. Keep its input alive until this
          // next callback delivers the block that was partial at stop time.
          if (session.stopping) this.finish(session, "processing");
        } catch (error) {
          this.fail(session, new MicrophoneError("recording-failed", "PCM capture callback failed", { cause: error }));
        }
      };
      session.backend = "ScriptProcessor";
      this.update({ backend: session.backend });
    }
    const node = session.worklet ?? session.processor!;
    session.source = context.createMediaStreamSource(stream);
    session.sink = context.createGain();
    session.sink.gain.value = 0;
    session.source.connect(node);
    node.connect(session.sink);
    session.sink.connect(context.destination);
    context.onstatechange = () => {
      if (context.state !== "running") this.fail(session,
        new MicrophoneError("interrupted", "AudioContext was suspended"));
    };
    const watchdog = setInterval(() => {
      if (session.started && Date.now() - session.lastSampleAt > 3_000) {
        this.fail(session, new MicrophoneError("interrupted", "PCM input stopped delivering frames"));
      }
    }, 500);
    session.cleanups.push(() => clearInterval(watchdog));
  }

  private acceptSamples(session: Session, samples: Float32Array,
    metadata: { observedChannels?: number; selectedChannel?: number } = {}) {
    if (this.session !== session || samples.length === 0 || !session.context) return;
    const sampleRate = session.context.sampleRate;
    const remaining = Math.floor(this.snapshot.maxDurationSeconds * sampleRate) - session.length;
    const chunk = samples.length <= remaining ? samples : samples.slice(0, remaining);
    session.chunks.push(chunk);
    session.length += chunk.length;
    const arrivedAt = Date.now();
    if (session.started) session.longestDeliveryGapMs = Math.max(session.longestDeliveryGapMs, arrivedAt - session.lastSampleAt);
    session.lastSampleAt = arrivedAt;
    session.blockCount += 1;
    session.observedChannels = Math.max(session.observedChannels, metadata.observedChannels ?? 1);
    if (metadata.selectedChannel !== undefined) session.selectedChannel = metadata.selectedChannel;
    const subscriber = session.options.onSamples;
    if (subscriber) {
      const copy = chunk.slice();
      // Subscribers cannot detach or modify the archival PCM, and exceptions
      // never terminate microphone capture. Queued final blocks survive stop.
      queueMicrotask(() => {
        if (session.cancelled) return;
        try { Promise.resolve(subscriber(copy, sampleRate)).catch(() => {}); }
        catch { /* A streaming decoder failure must not discard the recording. */ }
      });
    }
    if (!session.started) {
      session.started = true;
      session.firstSampleAt = arrivedAt;
      void this.keepScreenAwake(session);
      this.update({ status: "recording" });
      session.resolveStart();
    }
    if (!session.lastMeterAt || session.lastSampleAt - session.lastMeterAt >= 100) {
      let energy = 0;
      for (const sample of chunk) energy += sample * sample;
      const rms = Math.sqrt(energy / Math.max(1, chunk.length));
      // A logarithmic meter is useful for quiet physical microphones as well.
      const level = Math.min(1, Math.max(0, (20 * Math.log10(Math.max(rms, 1e-6)) + 60) / 60));
      this.update({ rms, level, elapsedSeconds: session.length / sampleRate });
      session.lastMeterAt = session.lastSampleAt;
    }
    if (session.length >= Math.floor(this.snapshot.maxDurationSeconds * sampleRate)) {
      this.finish(session, session.stopping ? "processing" : "ready");
    }
  }

  stop = (): Promise<PcmRecording> => {
    if (this.stopPromise) return this.stopPromise;
    if (this.completed) {
      this.update({ status: "processing" });
      this.stopPromise = Promise.resolve(this.completed);
      return this.stopPromise;
    }
    const session = this.session;
    if (!session?.started) return Promise.reject(new MicrophoneError("recording-failed", "No PCM recording is ready"));
    session.stopping = true;
    this.update({ status: "processing" });
    this.stopPromise = new Promise<PcmRecording>((resolve, reject) => {
      session.resolveStop = resolve;
      session.rejectStop = reject;
    });
    const flushTimer = setTimeout(() => this.fail(session,
      new MicrophoneError("interrupted", "PCM capture did not deliver its final block")), 1_000);
    session.cleanups.push(() => clearTimeout(flushTimer));
    if (session.worklet) {
      // Flush the partial final block before closing; silently dropping it can
      // truncate the CRC of a transmission stopped immediately after its tone.
      try {
        session.source?.disconnect();
        session.worklet.port.postMessage({ type: "flush" });
      } catch (error) { this.fail(session, normalizeMicrophoneError(error)); }
    }
    return this.stopPromise;
  };

  private async keepScreenAwake(session: Session) {
    if (this.session !== session || session.stopping || session.wakeLockRequested ||
      this.runtime.page?.hidden || !this.runtime.requestWakeLock) return;
    session.wakeLockRequested = true;
    try {
      const lock = await this.runtime.requestWakeLock();
      const release = () => {
        try { void lock.release().catch(() => {}); } catch { /* Best effort if the browser already released it. */ }
      };
      // A delayed Wake Lock grant must never survive cancellation, completion
      // or leaving the foreground. No extra permission is needed by the app.
      if (this.session !== session || session.stopping || this.runtime.page?.hidden) release();
      else session.cleanups.push(release);
    } catch {
      // Battery saver, browser policy or unsupported WebViews may deny this.
      // It is a convenience and must never prevent microphone reception.
    }
  }

  private collectRecording(session: Session, completion: RecordingDiagnostics["completion"],
    errorCode?: MicrophoneError["code"]): PcmRecording | null {
    if (!session.context || session.length === 0) return null;
    const samples = new Float32Array(session.length);
    let offset = 0;
    for (const chunk of session.chunks) { samples.set(chunk, offset); offset += chunk.length; }
    const sampleRate = session.context.sampleRate;
    return {
      samples, sampleRate,
      diagnostics: {
        ...analyzeAudio(samples, sampleRate), schemaVersion: 1,
        startedAt: new Date(session.requestedAt).toISOString(),
        startupMs: session.firstSampleAt - session.requestedAt,
        wallDurationMs: Date.now() - session.firstSampleAt,
        requestedDevice: session.options.deviceId && session.options.deviceId !== "default" ? "selected" : "default",
        trackSettings: session.trackSettings, deviceLabel: session.deviceLabel, backend: session.backend,
        observedChannels: session.observedChannels, selectedChannel: session.selectedChannel ?? 0,
        blockCount: session.blockCount, longestDeliveryGapMs: session.longestDeliveryGapMs,
        completion, ...(errorCode ? { errorCode } : {}),
      },
    };
  }

  private finish(session: Session, status: "ready" | "processing") {
    if (this.session !== session || !session.context) return;
    const recording = this.collectRecording(session, status === "ready" ? "limit" : "stopped");
    if (!recording) return;
    this.completed = recording;
    this.lastRecording = recording;
    this.session = null;
    this.release(session);
    this.update({ status, elapsedSeconds: recording.samples.length / recording.sampleRate, rms: 0, level: 0 });
    session.resolveStop?.(recording);
  }

  private fail(session: Session, error: MicrophoneError) {
    if (this.session !== session) return;
    this.lastRecording = this.collectRecording(session, "error", error.code);
    this.session = null;
    this.release(session);
    this.update({ status: "error", error, rms: 0, level: 0 });
    session.rejectStart(error);
    session.rejectStop?.(error);
  }

  private release(session: Session) {
    session.cleanups.forEach((cleanup) => cleanup());
    if (session.context) session.context.onstatechange = null;
    if (session.processor) session.processor.onaudioprocess = null;
    if (session.worklet) {
      session.worklet.onprocessorerror = null;
      session.worklet.port.onmessage = null;
      session.worklet.port.close();
    }
    for (const node of [session.source, session.worklet, session.processor, session.sink]) {
      try { node?.disconnect(); } catch { /* The browser may have already torn down the graph. */ }
    }
    session.stream?.getTracks().forEach((track) => track.stop());
    if (session.context && session.context.state !== "closed") void session.context.close().catch(() => {});
    session.chunks = [];
  }

  cancel = () => {
    const session = this.session;
    this.session = null;
    if (session) {
      session.cancelled = true;
      this.release(session);
      const error = new MicrophoneError("aborted", "Recording cancelled");
      session.rejectStart(error);
      session.rejectStop?.(error);
    }
    this.completed = null;
    this.lastRecording = null;
    this.stopPromise = null;
    this.update({ status: "idle", error: null, warning: null, rms: 0, level: 0, elapsedSeconds: 0 });
  };

  reset = this.cancel;
}
