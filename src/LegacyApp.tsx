import {
  Activity,
  AudioLines,
  CheckCircle2,
  CircleAlert,
  Download,
  FileAudio,
  Gauge,
  Info,
  Mic,
  Pause,
  Play,
  Radio,
  RefreshCw,
  Send,
  Share2,
  SlidersHorizontal,
  Square,
  Upload,
} from "lucide-react";
import { Capacitor } from "@capacitor/core";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { ProtocolFlow } from "./components/ProtocolFlow";
import { DetailPanel } from "./components/DetailPanel";
import { DEFAULT_MESSAGE, PageHeader, QuickExamples, type WorkspaceProps, type MobileView } from "./components/Workspace";
import { WaveformCanvas } from "./components/WaveformCanvas";
import { channelPresets, simulateChannel, type ChannelSettings } from "./core/channel";
import { toHex } from "./core/bytes";
import { encodeMessage, type DecodeReport, type Transmission } from "./core/protocol";
import type { ModemMode } from "./core/modem";
import { decodeAudioBlob, encodeWav } from "./core/wav";
import { useRecorder, type PcmRecording } from "./hooks/useRecorder";
import { decodeInWorker, decodeErrorMessage } from "./platform/decodeClient";
import { exportWav } from "./platform/exportWav";
import { microphoneErrorMessage } from "./platform/microphone";

const MAX_CHARACTERS = 160;
const MAX_BYTES = 480;

type ChannelPreset = keyof typeof channelPresets | "custom";
type ReceiveSource = "数字自检" | "音频文件" | "麦克风";

const MOBILE_VIEWS: MobileView[] = ["encode", "signal", "receive", "inspect"];

interface MobileNavTransition {
  sequence: number;
  from: number;
  to: number;
  active: boolean;
}

interface ReceiveState {
  status: "idle" | "working" | "success" | "error";
  report?: DecodeReport;
  error?: string;
  source?: ReceiveSource;
}

function buildInitialTransmission(text: string): Transmission {
  const initial = text.length <= MAX_CHARACTERS && new TextEncoder().encode(text).length <= MAX_BYTES && text.length ? text : DEFAULT_MESSAGE;
  return encodeMessage(initial, "fsk", { messageId: 0x2701 });
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(2)} s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${(seconds % 60).toFixed(0)}s`;
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function confidenceTone(confidence: number): "good" | "warn" | "bad" {
  if (confidence >= 0.78) return "good";
  if (confidence >= 0.48) return "warn";
  return "bad";
}

function App({ text, onTextChange: setText, mobileView, onViewChange: setMobileView, onPageChange }: WorkspaceProps) {
  const [mode, setMode] = useState<ModemMode>("fsk");
  const [compressionEnabled, setCompressionEnabled] = useState(true);
  const [builtCompression, setBuiltCompression] = useState(true);
  const [transmission, setTransmission] = useState<Transmission>(() => buildInitialTransmission(text));
  const [channelPreset, setChannelPreset] = useState<ChannelPreset>("street");
  const [channel, setChannel] = useState<ChannelSettings>({ ...channelPresets.street });
  const [channelSamples, setChannelSamples] = useState<Float32Array>();
  const [receive, setReceive] = useState<ReceiveState>({ status: "idle" });
  const [busyLabel, setBusyLabel] = useState<string>();
  const [isPlaying, setIsPlaying] = useState(false);
  const [playProgress, setPlayProgress] = useState(0);
  const [audioUrl, setAudioUrl] = useState<string>();
  const [lastFileName, setLastFileName] = useState<string>();
  const [mobileNavTransition, setMobileNavTransition] = useState<MobileNavTransition>({
    sequence: 0,
    from: MOBILE_VIEWS.indexOf(mobileView),
    to: MOBILE_VIEWS.indexOf(mobileView),
    active: false,
  });
  const audioRef = useRef<HTMLAudioElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const operationRef = useRef<AbortController | null>(null);
  const recorder = useRecorder();
  const isNativeApp = Capacitor.isNativePlatform();
  const captureActive = ["requesting", "recording", "ready", "processing"].includes(recorder.status);
  const controlsLocked = Boolean(busyLabel) || captureActive;

  useEffect(() => () => operationRef.current?.abort(), []);

  useEffect(() => {
    if (recorder.status === "error" && recorder.error) {
      setReceive({ status: "error", source: "麦克风", error: microphoneErrorMessage(recorder.error, isNativeApp) });
    }
  }, [recorder.status, recorder.error, isNativeApp]);

  const isSignalFresh =
    transmission.text === text && transmission.mode === mode && builtCompression === compressionEnabled;
  const activeTransmission = isSignalFresh ? transmission : undefined;
  const waveformSamples = channelSamples ?? activeTransmission?.signal.samples;
  const rawByteLength = new TextEncoder().encode(text).length;
  const compressionDelta = transmission.rawBytes.length
    ? 1 - transmission.payload.length / transmission.rawBytes.length
    : 0;

  const wavBlob = useMemo(() => {
    if (!activeTransmission) return undefined;
    return encodeWav(activeTransmission.signal.samples, activeTransmission.signal.sampleRate);
  }, [activeTransmission]);

  useEffect(() => {
    if (!wavBlob) {
      audioRef.current?.pause();
      setIsPlaying(false);
      setPlayProgress(0);
      setAudioUrl(undefined);
      return;
    }

    const url = URL.createObjectURL(wavBlob);
    setAudioUrl(url);
    const audio = audioRef.current;
    return () => { audio?.pause(); URL.revokeObjectURL(url); };
  }, [wavBlob]);

  const yieldToUi = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

  const buildSignal = async () => {
    if (operationRef.current || captureActive) return;
    const encodedLength = new TextEncoder().encode(text).length;
    if (encodedLength === 0) {
      setReceive({ status: "error", error: "请输入待发送文本。" });
      return;
    }
    if (encodedLength > MAX_BYTES) {
      setReceive({ status: "error", error: `UTF-8 数据为 ${encodedLength} B，当前演示帧上限为 ${MAX_BYTES} B。` });
      return;
    }

    setBusyLabel("正在生成声波");
    setReceive({ status: "idle" });
    setChannelSamples(undefined);
    await yieldToUi();

    try {
      const next = encodeMessage(text, mode, { compression: compressionEnabled });
      setTransmission(next);
      setBuiltCompression(compressionEnabled);
      setPlayProgress(0);
      selectMobileView("signal");
    } catch (error) {
      setReceive({ status: "error", error: error instanceof Error ? error.message : "信号生成失败。" });
    } finally {
      setBusyLabel(undefined);
    }
  };

  const runLoopback = async () => {
    if (!activeTransmission || operationRef.current || captureActive) return;
    const operation = new AbortController();
    operationRef.current = operation;
    selectMobileView("receive");
    setBusyLabel("正在自检");
    setReceive({ status: "working", source: "数字自检" });
    await yieldToUi();

    try {
      const samples = simulateChannel(
        activeTransmission.signal.samples,
        activeTransmission.signal.sampleRate,
        channel,
      );
      setChannelSamples(samples);
      const report = await decodeInWorker(samples, activeTransmission.signal.sampleRate, { mode: activeTransmission.mode, signal: operation.signal });
      if (operation.signal.aborted) return;
      setReceive({ status: "success", report, source: "数字自检" });
    } catch (error) {
      if (operation.signal.aborted) return;
      setReceive({
        status: "error",
        source: "数字自检",
        error: decodeErrorMessage(error),
      });
    } finally {
      if (operationRef.current === operation) {
        operationRef.current = null;
        setBusyLabel(undefined);
      }
    }
  };

  const processAudio = async (input: Blob | PcmRecording, source: ReceiveSource) => {
    if (operationRef.current) return;
    const operation = new AbortController();
    operationRef.current = operation;
    selectMobileView("receive");
    setBusyLabel("正在分析录音");
    setReceive({ status: "working", source });
    await yieldToUi();

    try {
      const audio = input instanceof Blob ? await decodeAudioBlob(input, { signal: operation.signal }) : input;
      if (operation.signal.aborted) return;
      if (audio.samples.length / audio.sampleRate > 120.1) throw new Error("Audio duration is too long");
      setChannelSamples(audio.samples);
      const report = await decodeInWorker(audio.samples, audio.sampleRate, { signal: operation.signal });
      if (operation.signal.aborted) return;
      setReceive({ status: "success", report, source });
    } catch (error) {
      if (operation.signal.aborted) return;
      setReceive({
        status: "error",
        source,
        error: decodeErrorMessage(error),
      });
    } finally {
      if (operationRef.current === operation) {
        operationRef.current = null;
        recorder.reset();
        setBusyLabel(undefined);
      }
    }
  };

  const handleFile = async (file?: File) => {
    if (!file || controlsLocked || operationRef.current) return;
    if (fileInputRef.current) fileInputRef.current.value = "";
    if (file.size > 32 * 1024 * 1024) {
      setReceive({ status: "error", source: "音频文件", error: "音频文件超过 32 MB，请截取 120 秒以内的片段再导入。" });
      return;
    }
    setLastFileName(file.name);
    await processAudio(file, "音频文件");
  };

  const handleRecorder = async () => {
    if (operationRef.current) return;
    if (recorder.status === "idle" || recorder.status === "error") {
      try {
        audioRef.current?.pause();
        setReceive({ status: "idle" });
        await recorder.start();
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "aborted") return;
        setReceive({
          status: "error",
          source: "麦克风",
          error: microphoneErrorMessage(error, isNativeApp),
        });
      }
      return;
    }

    if (recorder.status === "recording" || recorder.status === "ready") {
      try {
        const audio = await recorder.stop();
        await processAudio(audio, "麦克风");
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "aborted") return;
        recorder.reset();
        setReceive({ status: "error", source: "麦克风", error: microphoneErrorMessage(error, isNativeApp) });
      }
    }
  };

  const togglePlayback = async () => {
    if (controlsLocked) return;
    const audio = audioRef.current;
    if (!audio || !audioUrl) return;
    if (isPlaying) {
      audio.pause();
    } else {
      try {
        await audio.play();
      } catch {
        setReceive({ status: "error", error: "声波未能播放，请再点一次播放，或导出 WAV 后播放。" });
      }
    }
  };

  const downloadWav = async () => {
    if (!audioUrl || !wavBlob || !activeTransmission) return;
    const filename = `sonaweave-${activeTransmission.frame[4].toString(16).padStart(2, "0")}${activeTransmission.frame[5]
      .toString(16)
      .padStart(2, "0")}-${activeTransmission.mode}.wav`;
    setBusyLabel("正在导出 WAV");
    try {
      await exportWav(wavBlob, filename, audioUrl);
    } catch (error) {
      setReceive({
        status: "error",
        error: error instanceof Error ? `WAV 导出失败：${error.message}` : "WAV 导出失败。",
      });
    } finally {
      setBusyLabel(undefined);
    }
  };

  const selectPreset = (preset: Exclude<ChannelPreset, "custom">) => {
    if (controlsLocked) return;
    setChannelPreset(preset);
    setChannel({ ...channelPresets[preset] });
    setChannelSamples(undefined);
    setReceive({ status: "idle" });
  };

  const setChannelValue = (field: keyof ChannelSettings, value: number) => {
    if (controlsLocked) return;
    setChannelPreset("custom");
    setChannel((current) => ({ ...current, [field]: value }));
    setChannelSamples(undefined);
    setReceive({ status: "idle" });
  };

  const selectMobileView = (view: MobileView) => {
    if (view !== mobileView) {
      setMobileNavTransition((current) => ({
        sequence: current.sequence + 1,
        from: MOBILE_VIEWS.indexOf(mobileView),
        to: MOBILE_VIEWS.indexOf(view),
        active: true,
      }));
    }
    setMobileView(view);
    window.scrollTo({ top: 0, behavior: "instant" });
  };

  const cancelReceive = () => {
    operationRef.current?.abort();
    operationRef.current = null;
    recorder.cancel();
    setBusyLabel(undefined);
    setReceive({ status: "idle" });
  };

  const mobileNavSelectionStyle = {
    "--nav-from": `${mobileNavTransition.from * 100}%`,
    "--nav-mid": `${((mobileNavTransition.from + mobileNavTransition.to) / 2) * 100}%`,
    "--nav-to": `${mobileNavTransition.to * 100}%`,
  } as CSSProperties;

  return (
    <div className="app-shell" data-mobile-view={mobileView}>
      <PageHeader page="main" disabled={controlsLocked} onPageChange={onPageChange}/>

      <div className="command-bar">
        <div className="mode-group" aria-label="调制模式">
          <span className="command-label">发送模式</span>
          <div className="segmented-control">
            <button
              className={mode === "fsk" ? "active" : ""}
              type="button"
              data-testid="mode-fsk"
              aria-pressed={mode === "fsk"}
              disabled={controlsLocked}
              onClick={() => {
                setMode("fsk");
                setChannelSamples(undefined);
                setReceive({ status: "idle" });
              }}
            >
              <Radio size={15} aria-hidden="true" /> FSK
            </button>
            <button
              className={mode === "dtmf" ? "active" : ""}
              type="button"
              data-testid="mode-dtmf"
              aria-pressed={mode === "dtmf"}
              disabled={controlsLocked}
              onClick={() => {
                setMode("dtmf");
                setChannelSamples(undefined);
                setReceive({ status: "idle" });
              }}
            >
              <Activity size={15} aria-hidden="true" /> DTMF
            </button>
          </div>
        </div>


      </div>

      <main className="main-content">
        <section className="workbench" aria-label="声波传输工作台">
          <article className="work-panel transmit-panel" id="mobile-panel-encode">
            <div className="section-heading">
              <div>
                <h2>发送文字</h2>
              </div>
              <span className={`byte-counter ${rawByteLength > MAX_BYTES ? "over-limit" : ""}`}>
                {rawByteLength} / {MAX_BYTES} B
              </span>
            </div>

            <label className="field-label" htmlFor="message-input">
              待发送文本
            </label>
            <textarea
              id="message-input"
              data-testid="message-input"
              maxLength={MAX_CHARACTERS}
              disabled={controlsLocked}
              value={text}
              onChange={(event) => {
                setText(event.target.value);
                setChannelSamples(undefined);
                setReceive({ status: "idle" });
              }}
              spellCheck={false}
            />

            <QuickExamples disabled={controlsLocked} onSelect={value => { setText(value); setChannelSamples(undefined); setReceive({ status: "idle" }); }}/>

            <button
              type="button"
              className="primary-action"
              data-testid="build-signal"
              onClick={buildSignal}
              disabled={controlsLocked || rawByteLength === 0 || rawByteLength > MAX_BYTES || text.length > MAX_CHARACTERS}
            >
              {busyLabel === "正在生成声波" ? <RefreshCw className="spin" size={18} /> : <Send size={18} />}
              {busyLabel === "正在生成声波" ? "正在生成" : "生成声波"}
            </button>
            <DetailPanel title="发送设置" className="help-details encoding-details">
              <label className="switch-control">
                <span>
                  <strong>压缩文本</strong>
                </span>
                <input
                  type="checkbox"
                  checked={compressionEnabled}
                  disabled={controlsLocked}
                  onChange={(event) => {
                    setCompressionEnabled(event.target.checked);
                    setChannelSamples(undefined);
                    setReceive({ status: "idle" });
                  }}
                />
                <span className="switch-track" aria-hidden="true">
                  <span />
                </span>
              </label>
            <div className="pipeline-wrap">
              <div className="mini-heading">
                <span>处理链</span>
                {!isSignalFresh && <span className="stale-label">参数待应用</span>}
              </div>
              <ProtocolFlow transmission={activeTransmission} mode={mode} />
            </div>
            </DetailPanel>
          </article>

          <article className="work-panel signal-panel" id="mobile-panel-signal">
            <div className="section-heading">
              <div>
                <h2>声波预览</h2>
              </div>
              <span className={`signal-state ${activeTransmission ? "ready" : ""}`}>
                {activeTransmission ? "载波就绪" : "等待生成"}
              </span>
            </div>

            <div className="waveform-shell">
              <WaveformCanvas
                samples={waveformSamples}
                mode={mode}
                progress={playProgress}
                channelActive={Boolean(channelSamples)}
              />
              <div className="waveform-overlay">
                <span>{channelSamples ? "模拟信道" : "原始声波"}</span>
                <span>{activeTransmission ? formatDuration(activeTransmission.signal.durationSeconds) : "--"}</span>
              </div>
            </div>

            <audio
              ref={audioRef}
              src={audioUrl}
              onPlay={() => setIsPlaying(true)}
              onPause={() => setIsPlaying(false)}
              onEnded={() => {
                setIsPlaying(false);
                setPlayProgress(0);
              }}
              onTimeUpdate={(event) => {
                const element = event.currentTarget;
                setPlayProgress(element.duration ? element.currentTime / element.duration : 0);
              }}
            />

            <div className="audio-toolbar">
              <button
                className={`icon-button prominent ${isPlaying ? "is-playing" : ""}`}
                type="button"
                onClick={togglePlayback}
                disabled={!audioUrl || controlsLocked}
                title={isPlaying ? "暂停" : "播放声波"}
                aria-label={isPlaying ? "暂停" : "播放声波"}
              >
                {isPlaying ? <Pause size={19} /> : <Play size={19} />}
              </button>
              <div className="audio-summary">
                <strong>{activeTransmission ? `${activeTransmission.mode.toUpperCase()} / PCM 16-bit` : "尚无音频"}</strong>
                <span>{activeTransmission ? `${activeTransmission.signal.sampleRate / 1000} kHz · 单声道` : "生成后可播放或导出"}</span>
              </div>
              <button
                className="icon-button"
                type="button"
                onClick={() => void downloadWav()}
                disabled={!audioUrl || controlsLocked}
                title={isNativeApp ? "分享 WAV" : "下载 WAV"}
                aria-label={isNativeApp ? "分享 WAV" : "下载 WAV"}
              >
                {isNativeApp ? <Share2 size={18} /> : <Download size={18} />}
              </button>
            </div>

            <DetailPanel title="信道设置" className="channel-lab help-details">
              <div className="mini-heading">
                <span>
                  <SlidersHorizontal size={15} aria-hidden="true" /> 弱信道模拟
                </span>
                <strong>{channelPreset === "custom" ? "自定义" : channelPreset === "clear" ? "安静室内" : channelPreset === "street" ? "街道近场" : "劣化链路"}</strong>
              </div>

              <div className="preset-control" aria-label="信道预设">
                <button type="button" disabled={controlsLocked} className={channelPreset === "clear" ? "active" : ""} onClick={() => selectPreset("clear")}>清晰</button>
                <button type="button" disabled={controlsLocked} className={channelPreset === "street" ? "active" : ""} onClick={() => selectPreset("street")}>街道</button>
                <button type="button" disabled={controlsLocked} className={channelPreset === "degraded" ? "active" : ""} onClick={() => selectPreset("degraded")}>劣化</button>
              </div>

              <div className="slider-grid">
                <label>
                  <span>信噪比 <strong>{channel.snrDb.toFixed(0)} dB</strong></span>
                  <input
                    type="range"
                    min="6"
                    max="42"
                    step="1"
                    value={channel.snrDb}
                    disabled={controlsLocked}
                    onChange={(event) => setChannelValue("snrDb", Number(event.target.value))}
                  />
                </label>
                <label>
                  <span>突发衰落 <strong>{channel.dropoutPercent.toFixed(1)}%</strong></span>
                  <input
                    type="range"
                    min="0"
                    max="12"
                    step="0.5"
                    value={channel.dropoutPercent}
                    disabled={controlsLocked}
                    onChange={(event) => setChannelValue("dropoutPercent", Number(event.target.value))}
                  />
                </label>
                <label>
                  <span>回声混合 <strong>{channel.echoPercent.toFixed(0)}%</strong></span>
                  <input
                    type="range"
                    min="0"
                    max="24"
                    step="1"
                    value={channel.echoPercent}
                    disabled={controlsLocked}
                    onChange={(event) => setChannelValue("echoPercent", Number(event.target.value))}
                  />
                </label>
              </div>

            </DetailPanel>
              <button
                type="button"
                className="secondary-action"
                data-testid="loopback-button"
                onClick={runLoopback}
                disabled={!activeTransmission || controlsLocked}
              >
                <RefreshCw className={busyLabel === "正在自检" ? "spin" : ""} size={17} />
                数字自检
              </button>

          </article>
        </section>

        <section className="receiver-section" id="mobile-panel-receive" aria-label="接收与解码">
          <div className="receiver-heading">
            <div>
              <h2>接收文字</h2>
            </div>
            <div className="receive-actions">
              <input
                ref={fileInputRef}
                className="visually-hidden"
                type="file"
                accept="audio/*,.wav,.mp3,.m4a,.ogg,.webm"
                onChange={(event) => void handleFile(event.target.files?.[0])}
              />
              <button type="button" className="tool-button" onClick={() => fileInputRef.current?.click()} disabled={controlsLocked}>
                <Upload size={16} /> 导入音频
              </button>
              <button
                type="button"
                className={`tool-button ${recorder.status === "recording" ? "recording" : ""}`}
                data-testid="record-button"
                onClick={() => void handleRecorder()}
                disabled={recorder.status === "requesting" || recorder.status === "processing" || Boolean(busyLabel)}
              >
                {recorder.status === "recording" ? (
                  <Square size={15} fill="currentColor" />
                ) : recorder.status === "requesting" ? (
                  <RefreshCw className="spin" size={16} />
                ) : (
                  <Mic size={16} />
                )}
                {recorder.status === "recording"
                  ? "停止并分析"
                  : recorder.status === "requesting"
                    ? "正在启动"
                    : recorder.status === "ready"
                      ? "解码录音"
                      : "开始接收"}
              </button>
              {(captureActive || Boolean(operationRef.current)) && (
                <button type="button" className="tool-button" onClick={cancelReceive}>取消接收</button>
              )}
            </div>
          </div>

          <DetailPanel title="使用说明" className="help-details"><p>先开启接收，等麦克风就绪后播放。声音结束再停止解码；自动识别 FSK / DTMF。</p></DetailPanel>

          {(recorder.status === "recording" || recorder.status === "ready") && (
            <div className="recording-meter" data-testid="recording-meter">
              <div className="meter-heading">
                <strong>{recorder.status === "ready" ? "已达到录音上限，可以解码" : "麦克风已就绪，现在可以播放"}</strong>
                <span>{Math.floor(recorder.elapsedSeconds)} / {recorder.maxDurationSeconds} 秒</span>
              </div>
              <meter min="0" max="1" value={recorder.level} aria-label="麦克风输入音量" />
              <p>{recorder.status === "ready" ? "录音已保留，点击“解码录音”继续。" : recorder.rms < 0.002
                ? "声音较小，请观察音量条。"
                : recorder.rms > 0.45
                  ? "音量偏大，请降低播放音量。"
                  : "播放结束后停止分析。"}</p>
              {recorder.warning && <p>{recorder.warning}</p>}
            </div>
          )}

          <div className="receiver-grid">
            <div className={`decoded-output ${receive.status}`}>
              <div className="decode-status-row" data-testid="receive-status" aria-live="polite">
                <span className="decode-icon" aria-hidden="true">
                  {receive.status === "success" ? (
                    <CheckCircle2 size={20} />
                  ) : receive.status === "error" ? (
                    <CircleAlert size={20} />
                  ) : recorder.status === "requesting" || receive.status === "working" || busyLabel ? (
                    <RefreshCw className="spin" size={20} />
                  ) : (
                    <FileAudio size={20} />
                  )}
                </span>
                <div>
                  <strong>
                    {recorder.status === "requesting"
                      ? "正在启动麦克风"
                      : recorder.status === "recording"
                      ? "正在监听声波"
                      : recorder.status === "ready"
                        ? "录音已就绪"
                      : receive.status === "success"
                        ? "已收到消息"
                        : receive.status === "error"
                          ? "未能完成接收"
                          : receive.status === "working" || busyLabel
                            ? busyLabel ?? "处理中"
                            : "等待接收"}
                  </strong>
                  <span>
                    {recorder.status === "requesting"
                      ? "请允许麦克风访问"
                      : recorder.status === "recording"
                      ? `${recorder.deviceLabel ?? "系统默认麦克风"}`
                      : receive.source
                        ? `来源：${receive.source}${receive.report ? ` · ${receive.report.mode.toUpperCase()}` : ""}${lastFileName && receive.source === "音频文件" ? ` / ${lastFileName}` : ""}`
                        : "FSK / DTMF"}
                  </span>
                </div>
              </div>

              <div className="decoded-message" data-testid="decoded-text">
                {receive.status === "success" ? (
                  <p>{receive.report?.text}</p>
                ) : receive.status === "error" ? (
                  <p className="error-copy">{receive.error}</p>
                ) : (
                  <p className="placeholder-copy">收到的文字会显示在这里。</p>
                )}
              </div>
            </div>

            <div className="telemetry" aria-label="接收信息">
              <div className="telemetry-title">
                <Gauge size={17} aria-hidden="true" />
                <strong>接收信息</strong>
              </div>
              <dl>
                <div>
                  <dt>CRC16</dt>
                  <dd data-testid="crc-status" className={receive.report?.frame.crcValid ? "positive" : ""}>
                    {receive.report ? (receive.report.frame.crcValid ? "PASS" : "FAIL") : "--"}
                  </dd>
                </div>
                <div>
                  <dt>纠正码字</dt>
                  <dd>{receive.report ? receive.report.fec.correctedCodewords : "--"}</dd>
                </div>
                <div>
                  <dt>不可纠正</dt>
                  <dd>{receive.report ? receive.report.fec.uncorrectableCodewords : "--"}</dd>
                </div>
                <div>
                  <dt>解调置信度</dt>
                  <dd className={receive.report ? confidenceTone(receive.report.modem.confidence) : ""}>
                    {receive.report ? formatPercent(receive.report.modem.confidence) : "--"}
                  </dd>
                </div>
              </dl>
            </div>
          </div>
        </section>

        <section className="diagnostics-section" id="mobile-panel-inspect" aria-label="指标与协议诊断">
          <div className="section-heading"><div><h2>编码诊断</h2></div></div>
          <div className="metrics-band" aria-label="编码指标">
            <div className="metric-item">
              <span>原始文本</span>
              <strong>{activeTransmission ? activeTransmission.rawBytes.length : rawByteLength} B</strong>
              <small>UTF-8</small>
            </div>
            <div className="metric-item">
              <span>压缩载荷</span>
              <strong>{activeTransmission ? activeTransmission.payload.length : "--"} B</strong>
              <small>
                {activeTransmission
                  ? activeTransmission.compressed
                    ? `节省 ${formatPercent(Math.max(0, compressionDelta))}`
                    : compressionEnabled
                      ? "自适应直通"
                      : "已关闭"
                  : "等待生成"}
              </small>
            </div>
            <div className="metric-item accent-coral">
              <span>协议帧</span>
              <strong>{activeTransmission ? activeTransmission.frame.length : "--"} B</strong>
              <small>帧头 + CRC16</small>
            </div>
            <div className="metric-item accent-yellow">
              <span>纠错后</span>
              <strong>{activeTransmission ? activeTransmission.protectedBytes.length : "--"} B</strong>
              <small>Hamming SECDED</small>
            </div>
            <div className="metric-item accent-blue">
              <span>空口时长</span>
              <strong>{activeTransmission ? formatDuration(activeTransmission.signal.durationSeconds) : "--"}</strong>
              <small>{mode === "fsk" ? "600 baud FSK" : "16-symbol DTMF"}</small>
            </div>
          </div>

          <DetailPanel title="协议详情" className="protocol-inspector">
            <div className="inspector-content">
              <div className="frame-map" aria-label="SWP-1 帧结构">
                <div className="frame-cell sync"><strong>53 57</strong><span>同步字</span><small>2 B</small></div>
                <div className="frame-cell"><strong>01</strong><span>版本</span><small>1 B</small></div>
                <div className="frame-cell"><strong>FLAGS</strong><span>压缩标志</span><small>1 B</small></div>
                <div className="frame-cell"><strong>ID</strong><span>消息号</span><small>2 B</small></div>
                <div className="frame-cell"><strong>LEN</strong><span>双长度</span><small>4 B</small></div>
                <div className="frame-cell payload"><strong>PAYLOAD</strong><span>文本载荷</span><small>N B</small></div>
                <div className="frame-cell crc"><strong>CRC16</strong><span>完整性</span><small>2 B</small></div>
              </div>

              <div className="hex-grid">
                <div>
                  <span className="code-label">SWP-1 FRAME</span>
                  <code>{activeTransmission ? toHex(activeTransmission.frame, 96) : "--"}</code>
                </div>
                <div>
                  <span className="code-label">HAMMING ENCODED</span>
                  <code>{activeTransmission ? toHex(activeTransmission.protectedBytes, 96) : "--"}</code>
                </div>
              </div>

              <div className="inspector-note">
                <Info size={17} aria-hidden="true" />
                <p>
                  每 4 位数据扩展为 8 位 SECDED 码字，可纠正单比特错误并检测双比特错误；帧尾 CRC16-CCITT
                  负责整帧最终验真。
                </p>
              </div>
            </div>
          </DetailPanel>
        </section>
      </main>

      <nav
        className="mobile-tab-bar"
        data-motion={mobileNavTransition.active ? "moving" : "idle"}
        aria-label="主要工作区"
      >
        <span
          key={mobileNavTransition.sequence}
          className={`mobile-tab-selection at-${mobileView}`}
          style={mobileNavSelectionStyle}
          aria-hidden="true"
          onAnimationEnd={(event) => {
            if (event.animationName !== "liquid-nav-slide") return;
            const completedSequence = mobileNavTransition.sequence;
            setMobileNavTransition((current) =>
              current.sequence === completedSequence ? { ...current, active: false } : current,
            );
          }}
        />
        <button
          type="button"
          className={mobileView === "encode" ? "active" : ""}
          aria-current={mobileView === "encode" ? "page" : undefined}
          aria-controls="mobile-panel-encode"
          onClick={() => selectMobileView("encode")}
        >
          <Send size={20} aria-hidden="true" />
          <span>发送</span>
        </button>
        <button
          type="button"
          className={mobileView === "signal" ? "active" : ""}
          aria-current={mobileView === "signal" ? "page" : undefined}
          aria-controls="mobile-panel-signal"
          onClick={() => selectMobileView("signal")}
        >
          <AudioLines size={20} aria-hidden="true" />
          <span>载波</span>
          {activeTransmission && <i className="tab-state ready" aria-label="载波就绪" />}
        </button>
        <button
          type="button"
          className={mobileView === "receive" ? "active" : ""}
          aria-current={mobileView === "receive" ? "page" : undefined}
          aria-controls="mobile-panel-receive"
          onClick={() => selectMobileView("receive")}
        >
          <Mic size={20} aria-hidden="true" />
          <span>接收</span>
          {receive.status !== "idle" && <i className={`tab-state ${receive.status}`} aria-label={`接收状态：${receive.status}`} />}
        </button>
        <button
          type="button"
          className={mobileView === "inspect" ? "active" : ""}
          aria-current={mobileView === "inspect" ? "page" : undefined}
          aria-controls="mobile-panel-inspect"
          onClick={() => selectMobileView("inspect")}
        >
          <Gauge size={20} aria-hidden="true" />
          <span>诊断</span>
        </button>
      </nav>

      <footer className="app-footer"><span>SonaWeave 0.2.3</span></footer>
    </div>
  );
}

export default App;
