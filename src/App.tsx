import {
  Activity,
  AudioLines,
  Check,
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
  ShieldCheck,
  SlidersHorizontal,
  Square,
  Upload,
  WifiOff,
} from "lucide-react";
import { Capacitor } from "@capacitor/core";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { ProtocolFlow } from "./components/ProtocolFlow";
import { WaveformCanvas } from "./components/WaveformCanvas";
import { channelPresets, simulateChannel, type ChannelSettings } from "./core/channel";
import { toHex } from "./core/bytes";
import { decodeSamples, encodeMessage, type DecodeReport, type Transmission } from "./core/protocol";
import type { ModemMode } from "./core/modem";
import { decodeAudioBlob, encodeWav } from "./core/wav";
import { useRecorder } from "./hooks/useRecorder";
import { exportWav } from "./platform/exportWav";
import { microphoneErrorMessage } from "./platform/microphone";

const DEFAULT_MESSAGE =
  "NODE-A3|READY|7K2M;NODE-A3|READY|7K2M;NODE-A3|READY|7K2M;NODE-A3|READY|7K2M;NODE-A3|READY|7K2M;NODE-A3|READY|7K2M;ACK=OK-27";
const MAX_CHARACTERS = 160;
const MAX_BYTES = 480;

const MESSAGE_EXAMPLES = [
  { label: "节点心跳", value: DEFAULT_MESSAGE },
  { label: "设备配网", value: "NODE-07 配网参数：SSID=FIELD_KIT；CHANNEL=6；PAIR=7K2M-7K2M。" },
  { label: "应急短讯", value: "位置已确认。主链路中断，切换近场声波通道。补给点坐标 GRID-C4，重复 GRID-C4。" },
];

type ChannelPreset = keyof typeof channelPresets | "custom";
type ReceiveSource = "回环实验" | "音频文件" | "麦克风";
type MobileView = "encode" | "signal" | "receive" | "inspect";

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

function buildInitialTransmission(): Transmission {
  return encodeMessage(DEFAULT_MESSAGE, "fsk", { messageId: 0x2701 });
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

function App() {
  const [text, setText] = useState(DEFAULT_MESSAGE);
  const [mode, setMode] = useState<ModemMode>("fsk");
  const [compressionEnabled, setCompressionEnabled] = useState(true);
  const [builtCompression, setBuiltCompression] = useState(true);
  const [transmission, setTransmission] = useState<Transmission>(buildInitialTransmission);
  const [channelPreset, setChannelPreset] = useState<ChannelPreset>("street");
  const [channel, setChannel] = useState<ChannelSettings>({ ...channelPresets.street });
  const [channelSamples, setChannelSamples] = useState<Float32Array>();
  const [receive, setReceive] = useState<ReceiveState>({ status: "idle" });
  const [busyLabel, setBusyLabel] = useState<string>();
  const [isPlaying, setIsPlaying] = useState(false);
  const [playProgress, setPlayProgress] = useState(0);
  const [audioUrl, setAudioUrl] = useState<string>();
  const [lastFileName, setLastFileName] = useState<string>();
  const [mobileView, setMobileView] = useState<MobileView>("encode");
  const [mobileNavTransition, setMobileNavTransition] = useState<MobileNavTransition>({
    sequence: 0,
    from: 0,
    to: 0,
    active: false,
  });
  const audioRef = useRef<HTMLAudioElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const recorder = useRecorder();
  const isNativeApp = Capacitor.isNativePlatform();

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
    return () => URL.revokeObjectURL(url);
  }, [wavBlob]);

  const yieldToUi = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

  const buildSignal = async () => {
    const encodedLength = new TextEncoder().encode(text).length;
    if (encodedLength === 0) {
      setReceive({ status: "error", error: "请输入待发送文本。" });
      return;
    }
    if (encodedLength > MAX_BYTES) {
      setReceive({ status: "error", error: `UTF-8 数据为 ${encodedLength} B，当前演示帧上限为 ${MAX_BYTES} B。` });
      return;
    }

    setBusyLabel("正在编织声波");
    setReceive({ status: "idle" });
    setChannelSamples(undefined);
    await yieldToUi();

    try {
      const next = encodeMessage(text, mode, { compression: compressionEnabled });
      setTransmission(next);
      setBuiltCompression(compressionEnabled);
      setPlayProgress(0);
    } catch (error) {
      setReceive({ status: "error", error: error instanceof Error ? error.message : "信号生成失败。" });
    } finally {
      setBusyLabel(undefined);
    }
  };

  const runLoopback = async () => {
    if (!activeTransmission) return;
    setBusyLabel("正在穿过模拟信道");
    setReceive({ status: "working", source: "回环实验" });
    await yieldToUi();

    try {
      const samples = simulateChannel(
        activeTransmission.signal.samples,
        activeTransmission.signal.sampleRate,
        channel,
      );
      setChannelSamples(samples);
      const report = decodeSamples(samples, activeTransmission.signal.sampleRate, activeTransmission.mode);
      setReceive({ status: "success", report, source: "回环实验" });
    } catch (error) {
      setReceive({
        status: "error",
        source: "回环实验",
        error: error instanceof Error ? error.message : "回环解码失败。",
      });
    } finally {
      setBusyLabel(undefined);
    }
  };

  const processAudio = async (blob: Blob, source: ReceiveSource) => {
    setBusyLabel("正在分析录音");
    setReceive({ status: "working", source });
    await yieldToUi();

    try {
      const audio = await decodeAudioBlob(blob);
      setChannelSamples(audio.samples);
      const report = decodeSamples(audio.samples, audio.sampleRate, mode);
      setReceive({ status: "success", report, source });
    } catch (error) {
      setReceive({
        status: "error",
        source,
        error: error instanceof Error ? error.message : "音频解码失败。",
      });
    } finally {
      recorder.reset();
      setBusyLabel(undefined);
    }
  };

  const handleFile = async (file?: File) => {
    if (!file) return;
    setLastFileName(file.name);
    await processAudio(file, "音频文件");
  };

  const handleRecorder = async () => {
    if (recorder.status === "idle") {
      try {
        setReceive({ status: "idle" });
        await recorder.start();
      } catch (error) {
        setReceive({
          status: "error",
          source: "麦克风",
          error: microphoneErrorMessage(error, isNativeApp),
        });
      }
      return;
    }

    if (recorder.status === "recording") {
      try {
        const blob = await recorder.stop();
        await processAudio(blob, "麦克风");
      } catch (error) {
        recorder.reset();
        setReceive({ status: "error", source: "麦克风", error: microphoneErrorMessage(error, isNativeApp) });
      }
    }
  };

  const togglePlayback = async () => {
    const audio = audioRef.current;
    if (!audio || !audioUrl) return;
    if (isPlaying) {
      audio.pause();
    } else {
      await audio.play();
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
    setChannelPreset(preset);
    setChannel({ ...channelPresets[preset] });
    setChannelSamples(undefined);
    setReceive({ status: "idle" });
  };

  const setChannelValue = (field: keyof ChannelSettings, value: number) => {
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
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const mobileNavSelectionStyle = {
    "--nav-from": `${mobileNavTransition.from * 100}%`,
    "--nav-mid": `${((mobileNavTransition.from + mobileNavTransition.to) / 2) * 100}%`,
    "--nav-to": `${mobileNavTransition.to * 100}%`,
  } as CSSProperties;

  return (
    <div className="app-shell" data-mobile-view={mobileView}>
      <header className="app-header">
        <div className="brand-block">
          <span className="brand-mark" aria-hidden="true">
            <AudioLines size={25} />
          </span>
          <div>
            <h1>SonaWeave</h1>
            <p>声织 · 近场声波链路台</p>
          </div>
        </div>

        <div className="header-status" aria-label="运行状态">
          <span className="status-item">
            <span className="live-dot" /> 本地计算
          </span>
          <span className="status-item muted-on-mobile">
            <WifiOff size={15} aria-hidden="true" /> 无需网络
          </span>
          <span className="protocol-version">SWP-1</span>
        </div>
      </header>

      <div className="command-bar">
        <div className="mode-group" aria-label="调制模式">
          <span className="command-label">调制</span>
          <div className="segmented-control">
            <button
              className={mode === "fsk" ? "active" : ""}
              type="button"
              data-testid="mode-fsk"
              aria-pressed={mode === "fsk"}
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

        <div className="mode-description">
          <strong>{mode === "fsk" ? "600 baud · 1.8 / 3.0 kHz" : "16 键双音 · 36 ms/符号"}</strong>
          <span>{mode === "fsk" ? "速度优先，适合机器互传" : "辨识度优先，适合扬声器近场"}</span>
        </div>
      </div>

      <main className="main-content">
        <section className="workbench" aria-label="声波传输工作台">
          <article className="work-panel transmit-panel" id="mobile-panel-encode">
            <div className="section-heading">
              <div>
                <span className="section-index">TX / 01</span>
                <h2>消息编码</h2>
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
              value={text}
              onChange={(event) => {
                setText(event.target.value);
                setChannelSamples(undefined);
                setReceive({ status: "idle" });
              }}
              spellCheck={false}
            />

            <div className="compose-options">
              <label className="select-field">
                <span>快速样例</span>
                <select
                  value=""
                  onChange={(event) => {
                    const example = MESSAGE_EXAMPLES.find((item) => item.label === event.target.value);
                    if (example) {
                      setText(example.value);
                      setChannelSamples(undefined);
                      setReceive({ status: "idle" });
                    }
                  }}
                >
                  <option value="" disabled>
                    选择消息
                  </option>
                  {MESSAGE_EXAMPLES.map((example) => (
                    <option key={example.label} value={example.label}>
                      {example.label}
                    </option>
                  ))}
                </select>
              </label>

              <label className="switch-control">
                <span>
                  <strong>自适应 LZW12</strong>
                  <small>仅在体积更小时启用</small>
                </span>
                <input
                  type="checkbox"
                  checked={compressionEnabled}
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
            </div>

            <div className="pipeline-wrap">
              <div className="mini-heading">
                <span>处理链</span>
                {!isSignalFresh && <span className="stale-label">参数待应用</span>}
              </div>
              <ProtocolFlow transmission={activeTransmission} mode={mode} />
            </div>

            <button
              type="button"
              className="primary-action"
              data-testid="build-signal"
              onClick={buildSignal}
              disabled={Boolean(busyLabel)}
            >
              {busyLabel === "正在编织声波" ? <RefreshCw className="spin" size={18} /> : <Send size={18} />}
              {busyLabel === "正在编织声波" ? "正在生成" : "编织声波"}
            </button>
          </article>

          <article className="work-panel signal-panel" id="mobile-panel-signal">
            <div className="section-heading">
              <div>
                <span className="section-index">LINK / 02</span>
                <h2>音频载波</h2>
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
                <span>{channelSamples ? "CHANNEL OUTPUT" : "CLEAN CARRIER"}</span>
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
                disabled={!audioUrl}
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
                disabled={!audioUrl || Boolean(busyLabel)}
                title={isNativeApp ? "分享 WAV" : "下载 WAV"}
                aria-label={isNativeApp ? "分享 WAV" : "下载 WAV"}
              >
                {isNativeApp ? <Share2 size={18} /> : <Download size={18} />}
              </button>
            </div>

            <div className="channel-lab">
              <div className="mini-heading">
                <span>
                  <SlidersHorizontal size={15} aria-hidden="true" /> 弱信道模拟
                </span>
                <strong>{channelPreset === "custom" ? "自定义" : channelPreset === "clear" ? "安静室内" : channelPreset === "street" ? "街道近场" : "劣化链路"}</strong>
              </div>

              <div className="preset-control" aria-label="信道预设">
                <button type="button" className={channelPreset === "clear" ? "active" : ""} onClick={() => selectPreset("clear")}>清晰</button>
                <button type="button" className={channelPreset === "street" ? "active" : ""} onClick={() => selectPreset("street")}>街道</button>
                <button type="button" className={channelPreset === "degraded" ? "active" : ""} onClick={() => selectPreset("degraded")}>劣化</button>
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
                    onChange={(event) => setChannelValue("echoPercent", Number(event.target.value))}
                  />
                </label>
              </div>

              <button
                type="button"
                className="secondary-action"
                data-testid="loopback-button"
                onClick={runLoopback}
                disabled={!activeTransmission || Boolean(busyLabel)}
              >
                <RefreshCw className={busyLabel === "正在穿过模拟信道" ? "spin" : ""} size={17} />
                运行回环解码
              </button>
            </div>
          </article>
        </section>

        <section className="receiver-section" id="mobile-panel-receive" aria-label="接收与解码">
          <div className="receiver-heading">
            <div>
              <span className="section-index">RX / 03</span>
              <h2>接收还原</h2>
            </div>
            <div className="receive-actions">
              <input
                ref={fileInputRef}
                className="visually-hidden"
                type="file"
                accept="audio/*,.wav,.mp3,.m4a,.ogg,.webm"
                onChange={(event) => void handleFile(event.target.files?.[0])}
              />
              <button type="button" className="tool-button" onClick={() => fileInputRef.current?.click()} disabled={Boolean(busyLabel)}>
                <Upload size={16} /> 导入音频
              </button>
              <button
                type="button"
                className={`tool-button ${recorder.status === "recording" ? "recording" : ""}`}
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
                  ? "停止并解码"
                  : recorder.status === "requesting"
                    ? "等待授权"
                    : "麦克风接收"}
              </button>
            </div>
          </div>

          <div className="receiver-grid">
            <div className={`decoded-output ${receive.status}`}>
              <div className="decode-status-row" aria-live="polite">
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
                      ? "正在请求麦克风权限"
                      : recorder.status === "recording"
                      ? "正在监听声波"
                      : receive.status === "success"
                        ? "消息完整还原"
                        : receive.status === "error"
                          ? "本次解码未通过"
                          : receive.status === "working" || busyLabel
                            ? busyLabel ?? "处理中"
                            : "等待回环、音频文件或麦克风输入"}
                  </strong>
                  <span>
                    {recorder.status === "requesting"
                      ? "等待浏览器或系统返回授权结果"
                      : recorder.status === "recording"
                      ? `${recorder.deviceLabel ?? "系统默认麦克风"} · 请在另一台设备播放 SonaWeave 音频`
                      : receive.source
                        ? `来源：${receive.source}${lastFileName && receive.source === "音频文件" ? ` / ${lastFileName}` : ""}`
                        : `当前按 ${mode.toUpperCase()} 参数监听`}
                  </span>
                </div>
              </div>

              <div className="decoded-message" data-testid="decoded-text">
                {receive.status === "success" ? (
                  <p>{receive.report?.text}</p>
                ) : receive.status === "error" ? (
                  <p className="error-copy">{receive.error}</p>
                ) : (
                  <p className="placeholder-copy">解码后的 UTF-8 文本会出现在这里。</p>
                )}
              </div>
            </div>

            <div className="telemetry" aria-label="链路遥测">
              <div className="telemetry-title">
                <Gauge size={17} aria-hidden="true" />
                <strong>链路遥测</strong>
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

          <details className="protocol-inspector">
            <summary>
              <span>
                <ShieldCheck size={17} aria-hidden="true" /> 协议透视
              </span>
              <small>查看 SWP-1 帧与编码字节</small>
            </summary>
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
          </details>
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
          <span>编码</span>
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

      <footer className="app-footer">
        <span>SonaWeave / SWP-1 acoustic data link</span>
        <span>
          <Check size={14} aria-hidden="true" /> 处理过程仅在本机完成
        </span>
      </footer>
    </div>
  );
}

export default App;
