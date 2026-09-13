import { AudioLines, CheckCircle2, CircleAlert, Download, FileAudio, Gauge, Mic, Pause, Play, RefreshCw, Send, Square, Upload } from "lucide-react";
import { Capacitor } from "@capacitor/core";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { DetailPanel } from "./components/DetailPanel";
import { WaveformCanvas } from "./components/WaveformCanvas";
import { PageHeader, QuickExamples, type WorkspaceProps, type MobileView } from "./components/Workspace";
import { GGWAVE_MAX_BYTES, type GgWaveSpeed, type GgWaveTransmission } from "./acoustic/ggwave";
import { packetPlayback, type AcousticReport } from "./acoustic/messages";
import { decodeAudioBlob, encodeWav } from "./core/wav";
import { useRecorder, type PcmRecording } from "./hooks/useRecorder";
import { buildAcousticMessage, decodeAcousticRecording, startLiveDecoder } from "./platform/acousticClient";
import { analyzeAudio, type AudioDiagnostics } from "./platform/audioDiagnostics";
import { listMicrophoneInputs, microphoneErrorMessage } from "./platform/microphone";
import { exportWav } from "./platform/exportWav";
import { exportDiagnostic } from "./platform/exportDiagnostic";

type Source = "麦克风" | "音频文件" | "数字自检";
type Receive = { status: "idle" | "listening" | "working" | "success" | "error"; source?: Source; report?: AcousticReport; error?: string; engineError?: string };
type Evidence = { audio: PcmRecording; analysis: AudioDiagnostics; at: string; source: Source };
type LiveSession = { decoder?: ReturnType<typeof startLiveDecoder>; finishing: boolean; cancelled: boolean; handlingError?: boolean };
const views: MobileView[] = ["encode", "signal", "receive", "inspect"];
const tabs = [{ view: "encode", label: "发送", Icon: Send }, { view: "signal", label: "载波", Icon: AudioLines }, { view: "receive", label: "接收", Icon: Mic }, { view: "inspect", label: "诊断", Icon: Gauge }] as const;
const speedLabels: Record<GgWaveSpeed, string> = { normal: "较慢", fast: "标准", fastest: "较快" };

function levelHint(analysis: AudioDiagnostics) {
  switch (analysis.status) {
    case "silence": return "录音几乎全是静音。请检查所选输入设备，并观察播放时音量条是否变化。";
    case "low-level": return "录到的声音很小。可将手机靠近电脑麦克风，并适当提高播放音量。";
    case "clipped": return "录音存在削波失真。请降低手机音量或稍微拉远距离。";
    case "invalid": return "录音包含无效采样，请重新开启接收或选择其他输入设备。";
    default: return "已录到声音；音量正常并不代表声波数据完整。可回听原始录音，检查是否录到了整段声波。";
  }
}
function db(value: number) { return value > 0 ? `${(20 * Math.log10(value)).toFixed(1)} dBFS` : "−∞ dBFS"; }
function errorText(error: unknown) { return error instanceof Error ? error.message : "操作未能完成，请重试。"; }

export default function GgWaveApp({ text, onTextChange, mobileView, onViewChange, onPageChange }: WorkspaceProps) {
  const [speed, setSpeed] = useState<GgWaveSpeed>("fast");
  const [transmission, setTransmission] = useState<GgWaveTransmission>();
  const [receive, setReceive] = useState<Receive>({ status: "idle" });
  const [evidence, setEvidence] = useState<Evidence>();
  const [busy, setBusy] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [listenReady, setListenReady] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [deviceId, setDeviceId] = useState("");
  const [devices, setDevices] = useState<{ deviceId: string; label: string }[]>([]);
  const [motion, setMotion] = useState({ sequence: 0, from: 0, to: 0, active: false });
  const audioRef = useRef<HTMLAudioElement>(null);
  const recordedAudioRef = useRef<HTMLAudioElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const operationRef = useRef<AbortController | null>(null);
  const liveRef = useRef<LiveSession | null>(null);
  const recorder = useRecorder();
  const captureActive = ["requesting", "recording", "ready", "processing"].includes(recorder.status);
  const locked = Boolean(busy) || captureActive || receive.status === "listening";
  const rawBytes = new TextEncoder().encode(text).length;
  const active = transmission?.text === text && transmission.speed === speed ? transmission : undefined;
  const playable = useMemo(() => active ? packetPlayback(active.signal.samples, active.signal.sampleRate, 1) : undefined, [active]);
  const txBlob = useMemo(() => playable && active ? encodeWav(playable, active.signal.sampleRate) : undefined, [playable, active]);
  const recordingBlob = useMemo(() => evidence ? encodeWav(evidence.audio.samples, evidence.audio.sampleRate) : undefined, [evidence]);
  const [txUrl, setTxUrl] = useState<string>();
  const [recordingUrl, setRecordingUrl] = useState<string>();

  useEffect(() => {
    audioRef.current?.pause(); setProgress(0); setIsPlaying(false);
    if (!txBlob) { setTxUrl(undefined); return; }
    const url = URL.createObjectURL(txBlob); setTxUrl(url);
    const audio = audioRef.current;
    return () => { audio?.pause(); URL.revokeObjectURL(url); };
  }, [txBlob]);
  useEffect(() => {
    if (!recordingBlob) { setRecordingUrl(undefined); return; }
    const url = URL.createObjectURL(recordingBlob); setRecordingUrl(url);
    const audio = recordedAudioRef.current;
    return () => { audio?.pause(); URL.revokeObjectURL(url); };
  }, [recordingBlob]);
  useEffect(() => () => {
    operationRef.current?.abort();
    if (liveRef.current) { liveRef.current.cancelled = true; liveRef.current.decoder?.close(); }
  }, []);

  const selectView = (view: MobileView) => {
    if (view !== mobileView) {
      setMotion(current => ({ sequence: current.sequence + 1, from: views.indexOf(mobileView), to: views.indexOf(view), active: true }));
    }
    onViewChange(view);
    if (window.matchMedia("(max-width: 760px), (max-width: 1100px) and (max-height: 550px)").matches) {
      window.scrollTo({ top: 0, behavior: "instant" });
    }
  };
  const refreshDevices = async () => {
    try { setDevices(await listMicrophoneInputs()); }
    catch { setNotice("暂时无法列出设备。可先使用系统默认麦克风，授权后再刷新。"); }
  };
  useEffect(() => { void refreshDevices(); }, []);

  const retain = (audio: PcmRecording, source: Source): Evidence => {
    const next = { audio, source, analysis: analyzeAudio(audio.samples, audio.sampleRate), at: new Date().toISOString() };
    setEvidence(next); return next;
  };
  const processInput = async (input: Blob | PcmRecording, source: Source, knownReport?: AcousticReport) => {
    if (operationRef.current) return;
    const operation = new AbortController(); operationRef.current = operation;
    setBusy("正在分析录音"); setReceive({ status: "working", source }); selectView("receive");
    let current: Evidence | undefined;
    try {
      const audio = input instanceof Blob ? await decodeAudioBlob(input, { signal: operation.signal }) : input;
      if (operation.signal.aborted) return;
      current = retain(audio, source);
      const report = knownReport ?? await decodeAcousticRecording(audio.samples, audio.sampleRate, operation.signal);
      if (!operation.signal.aborted) setReceive({ status: "success", source, report });
    } catch (error) {
      if (!operation.signal.aborted) setReceive({ status: "error", source, engineError: errorText(error), error: current
        ? `${levelHint(current.analysis)} 本次未识别到完整消息。确认两端使用新版，先开启接收，再从头播放。`
        : errorText(error) });
    } finally {
      if (operationRef.current === operation) { operationRef.current = null; setBusy(undefined); recorder.reset(); }
    }
  };
  const captureFailed = async (session: LiveSession, error: unknown) => {
    if (session.cancelled || session.handlingError || liveRef.current !== session) return;
    session.handlingError = true; session.finishing = true; session.decoder?.close();
    setListenReady(false); setBusy("正在保存诊断录音");
    // A decoder can fail while the recorder is still healthy. Flush that
    // recording before cancel clears it; a recorder failure already archives PCM.
    let partial = recorder.getLastRecording();
    if (!partial) {
      try { partial = await recorder.stop(); }
      catch { partial = recorder.getLastRecording(); }
    }
    if (session.cancelled || liveRef.current !== session) return;
    if (partial?.samples.length) retain(partial, "麦克风");
    liveRef.current = null; recorder.cancel(); setBusy(undefined);
    const message = error && typeof error === "object" && "code" in error
      ? microphoneErrorMessage(error, Capacitor.isNativePlatform()) : errorText(error);
    setReceive({ status: "error", source: "麦克风", error: message, engineError: errorText(error) });
  };
  const finishCapture = async (session: LiveSession, report?: AcousticReport) => {
    if (session.cancelled || session.finishing || liveRef.current !== session) return;
    session.finishing = true; setListenReady(false); setBusy("正在保存录音");
    try {
      const audio = await recorder.stop();
      if (session.cancelled || liveRef.current !== session) return;
      session.decoder?.close(); liveRef.current = null;
      await processInput(audio, "麦克风", report);
    } catch (error) { captureFailed(session, error); }
  };
  const startCapture = async () => {
    if (locked || operationRef.current || liveRef.current) return;
    audioRef.current?.pause(); recordedAudioRef.current?.pause();
    setEvidence(undefined); setNotice(undefined); setListenReady(false);
    setReceive({ status: "listening", source: "麦克风" });
    const session: LiveSession = { finishing: false, cancelled: false }; liveRef.current = session;
    try {
      session.decoder = startLiveDecoder(report => { void finishCapture(session, report); }, error => captureFailed(session, error));
      // Start in the click gesture, in parallel with WASM initialization.
      const capture = recorder.start({ deviceId: deviceId || undefined, onSamples: (samples, rate) => {
        if (!session.cancelled && !session.finishing) session.decoder?.push(samples, rate);
      } });
      await Promise.all([session.decoder.initialized, capture]);
      if (!session.cancelled && !session.finishing && liveRef.current === session) { setListenReady(true); void refreshDevices(); }
    } catch (error) { captureFailed(session, error); }
  };
  useEffect(() => {
    const session = liveRef.current;
    if (!session) return;
    if (recorder.status === "error") captureFailed(session, recorder.error);
    else if (recorder.status === "ready") void finishCapture(session);
  }, [recorder.status, recorder.error]);

  const cancel = () => {
    if (liveRef.current) { liveRef.current.cancelled = true; liveRef.current.decoder?.close(); liveRef.current = null; }
    operationRef.current?.abort(); operationRef.current = null;
    recorder.cancel(); setListenReady(false); setBusy(undefined); setReceive({ status: "idle" });
  };
  const build = async () => {
    if (locked || operationRef.current) return;
    const operation = new AbortController(); operationRef.current = operation;
    setBusy("正在生成声波"); setNotice(undefined);
    try {
      const next = await buildAcousticMessage(text, speed, operation.signal);
      if (!operation.signal.aborted) { setTransmission(next); selectView("signal"); }
    } catch (error) { if (!operation.signal.aborted) setNotice(errorText(error)); }
    finally { if (operationRef.current === operation) { operationRef.current = null; setBusy(undefined); } }
  };
  const doExport = async (action: () => Promise<void>) => {
    if (locked) return;
    setBusy("正在导出"); setNotice(undefined);
    try { await action(); } catch (error) { setNotice(`导出未完成：${errorText(error)}`); }
    finally { setBusy(undefined); }
  };
  const saveDiagnostic = () => evidence && doExport(() => exportDiagnostic({
    app: "SonaWeave", version: "0.2.3", capturedAt: evidence.at, source: evidence.source,
    capture: evidence.audio.diagnostics, audio: evidence.analysis,
    result: { status: receive.status, mode: receive.report?.mode, decodedByteCount: receive.report
      ? new TextEncoder().encode(receive.report.text).length : undefined, error: receive.error, engineError: receive.engineError },
  }, `sonaweave-diagnostic-${Date.now()}.json`));
  const navStyle = { "--nav-from": `${motion.from * 100}%`, "--nav-mid": `${(motion.from + motion.to) * 50}%`, "--nav-to": `${motion.to * 100}%` } as CSSProperties;
  const resultTitle = receive.status === "listening" ? (listenReady ? "麦克风已就绪，现在可以播放" : "正在准备接收")
    : receive.status === "success" ? "已收到消息" : receive.status === "error" ? "未能完成接收" : busy ?? "等待声音或音频文件";

  return <div className="app-shell ggwave-app" data-mobile-view={mobileView}>
    <PageHeader page="ggwave" disabled={locked} onPageChange={onPageChange}/>
    <div className="command-bar">
      <div className="mode-group" aria-label="发送速度"><span className="command-label">发送速度</span><div className="segmented-control">
        <button type="button" data-testid="speed-normal" className={speed === "normal" ? "active" : ""} aria-pressed={speed === "normal"} disabled={locked} onClick={() => setSpeed("normal")}>较慢</button>
        <button type="button" data-testid="speed-fast" className={speed === "fast" ? "active" : ""} aria-pressed={speed === "fast"} disabled={locked} onClick={() => setSpeed("fast")}>标准</button>
        <button type="button" data-testid="speed-fastest" className={speed === "fastest" ? "active" : ""} aria-pressed={speed === "fastest"} disabled={locked} onClick={() => setSpeed("fastest")}>较快</button>
      </div></div>
    </div>
    {notice && <div className="operation-notice" role="status"><span>{notice}</span><button type="button" className="tool-button" aria-label="关闭提示" onClick={() => setNotice(undefined)}>关闭</button></div>}
    <main className="main-content">
      <section className="workbench" aria-label="声波传输工作台">
        <article className="work-panel transmit-panel" id="mobile-panel-encode">
          <div className="section-heading"><div><h2>发送文字</h2></div><span className={`byte-counter ${rawBytes > GGWAVE_MAX_BYTES ? "over-limit" : ""}`}>{rawBytes} / {GGWAVE_MAX_BYTES} B</span></div>
          <label className="field-label" htmlFor="message">待发送文本</label>
          <textarea id="message" data-testid="message-input" value={text} disabled={locked} onChange={event => onTextChange(event.target.value)} spellCheck={false}/>
          <QuickExamples disabled={locked} onSelect={onTextChange}/>
          <button type="button" className="primary-action" data-testid="build-signal" disabled={locked || !rawBytes || rawBytes > GGWAVE_MAX_BYTES} onClick={() => void build()}><Send size={18}/>{busy === "正在生成声波" ? busy : "生成声波"}</button>
        </article>
        <article className="work-panel signal-panel" id="mobile-panel-signal">
          <div className="section-heading"><div><h2>声波预览</h2></div><span className={`signal-state ${active ? "ready" : ""}`}>{active ? "载波就绪" : "请先生成"}</span></div>
          <div className="waveform-shell"><WaveformCanvas samples={playable} mode="ggwave" progress={progress}/><div className="waveform-overlay"><span>ggwave · {speedLabels[speed]}</span><span>{playable && active ? `${(playable.length / active.signal.sampleRate).toFixed(2)} s` : "--"}</span></div></div>
          <audio ref={audioRef} src={txUrl} onPlay={() => setIsPlaying(true)} onPause={() => setIsPlaying(false)} onEnded={() => { setIsPlaying(false); setProgress(0); }} onTimeUpdate={event => setProgress(event.currentTarget.duration ? event.currentTarget.currentTime / event.currentTarget.duration : 0)}/>
          <div className="audio-toolbar">
            <button type="button" className="icon-button prominent" disabled={!txUrl || locked} aria-label={isPlaying ? "暂停" : "播放声波"} onClick={() => { if (isPlaying) audioRef.current?.pause(); else { recordedAudioRef.current?.pause(); void audioRef.current?.play().catch(() => setNotice("播放未启动，请再点一次播放。")); } }}>{isPlaying ? <Pause size={19}/> : <Play size={19}/>}</button>
            <div className="audio-summary"><strong>{active ? `ggwave · ${speedLabels[speed]}` : "尚无音频"}</strong></div>
          </div>
          <div className="receive-actions">
            <button type="button" className="tool-button" disabled={!txBlob || locked} onClick={() => txBlob && void doExport(() => exportWav(txBlob, `sonaweave-ggwave-${speed}.wav`, txUrl))}><Download size={16}/>导出发送 WAV</button>
            <button type="button" className="tool-button" data-testid="loopback-button" disabled={!playable || locked} onClick={() => { audioRef.current?.pause(); if (playable && active) void processInput({ samples: playable, sampleRate: active.signal.sampleRate }, "数字自检"); }}><CheckCircle2 size={16}/>数字自检</button>
          </div>
          <DetailPanel title="使用说明"><p>先在另一台设备开启接收，再播放声波。数字自检只验证本机编解码。</p><p>与其他 ggwave 工具互传时，请选择“较快”。</p></DetailPanel>
        </article>
      </section>
      <section className="receiver-section" id="mobile-panel-receive" aria-label="接收解码">
        <div className="section-heading receiver-heading"><div><h2>接收文字</h2></div><div className="receive-actions">
          <input ref={fileRef} type="file" accept="audio/*,.wav" hidden data-testid="audio-file" onChange={event => { const file = event.target.files?.[0]; event.target.value = ""; if (!file || locked) return; audioRef.current?.pause(); recordedAudioRef.current?.pause(); setEvidence(undefined); void processInput(file, "音频文件"); }}/>
          <button type="button" className="tool-button" disabled={locked} onClick={() => fileRef.current?.click()}><Upload size={16}/>导入音频</button>
          <button type="button" className="tool-button primary" data-testid="record-button" disabled={Boolean(busy) || (receive.status === "listening" && !listenReady)} onClick={() => { if (liveRef.current) void finishCapture(liveRef.current); else void startCapture(); }}>{receive.status === "listening" ? <Square size={16}/> : <Mic size={16}/>} {receive.status === "listening" ? listenReady ? "停止并分析" : "正在准备" : "开始接收"}</button>
          {(liveRef.current || operationRef.current) && <button type="button" className="tool-button" onClick={cancel}>取消接收</button>}
        </div></div>
        <div className="receive-options"><DetailPanel title="收音设备" mobileOnly><div className="input-selector"><label htmlFor="input-device">收音设备</label><select id="input-device" value={deviceId} disabled={locked} onChange={event => setDeviceId(event.target.value)}><option value="">系统默认麦克风</option>{devices.map(device => <option key={device.deviceId} value={device.deviceId}>{device.label}</option>)}</select><button type="button" className="tool-button" disabled={locked} onClick={() => void refreshDevices()}><RefreshCw size={15}/>刷新</button></div></DetailPanel>
        <DetailPanel title="使用说明"><p>等待“麦克风已就绪”后，让另一台设备从头播放，并保持接收页面在前台。收到 ggwave 消息会自动停止收音。</p><p>FSK / DTMF 请在播放结束后点击“停止并分析”。</p></DetailPanel></div>
        {receive.status === "listening" && <div className="recording-meter" data-testid="recording-meter"><div className="meter-heading"><strong>{listenReady ? "麦克风已就绪，现在可以播放" : "正在启动麦克风和解码器"}</strong><span>{Math.floor(recorder.elapsedSeconds)} / {recorder.maxDurationSeconds} 秒</span></div><meter min="0" max="1" value={recorder.level} aria-label="麦克风输入音量"/><p>{listenReady ? recorder.rms < 0.002 ? "目前声音很小，播放时请观察音量条是否变化。" : "正在收音并实时识别。音量条仅代表声音大小。" : "首次使用请允许麦克风访问，收到音频后才会提示就绪。"}</p>{recorder.warning && <p>{recorder.warning}</p>}</div>}
        <div className="receiver-grid"><div className={`decoded-output ${receive.status}`}><div className="decode-status-row" data-testid="receive-status" aria-live="polite"><span className="decode-icon" aria-hidden="true">{receive.status === "success" ? <CheckCircle2 size={20}/> : receive.status === "error" ? <CircleAlert size={20}/> : busy ? <RefreshCw className="spin" size={20}/> : <FileAudio size={20}/>}</span><div><strong>{resultTitle}</strong><span>{receive.source ? `来源：${receive.source}` : "尚无接收记录"}</span></div></div><div className="decoded-message" data-testid="decoded-text"><p className={receive.status === "error" ? "error-copy" : receive.report ? "" : "placeholder-copy"}>{receive.report?.text ?? receive.error ?? "接收的文字会显示在这里。"}</p></div></div>
          <div className="telemetry"><div className="telemetry-title"><Gauge size={17}/><strong>本次接收</strong></div><dl><div><dt>协议</dt><dd>{receive.report?.mode.toUpperCase() ?? "--"}</dd></div><div><dt>解码依据</dt><dd data-testid="verification-status">{receive.report ? receive.report.mode === "ggwave" ? "Reed-Solomon" : "SWP-1 CRC16" : "--"}</dd></div><div><dt>录音时长</dt><dd>{evidence ? `${evidence.analysis.durationSeconds.toFixed(2)} s` : "--"}</dd></div><div><dt>平均音量</dt><dd>{evidence ? db(evidence.analysis.rms) : "--"}</dd></div></dl></div></div>
        {evidence && <DetailPanel title="本次录音 · 回听与导出" mobileOnly><div className="recording-evidence"><div><strong>本次原始录音已保留</strong><span>{evidence.audio.sampleRate / 1000} kHz · {evidence.analysis.durationSeconds.toFixed(2)} 秒</span></div><p>{levelHint(evidence.analysis)}</p><audio ref={recordedAudioRef} controls src={recordingUrl} aria-label="回听本次录音" onPlay={() => { audioRef.current?.pause(); }}/><div className="receive-actions"><button type="button" className="tool-button" data-testid="export-recording" disabled={locked || !recordingBlob} onClick={() => recordingBlob && void doExport(() => exportWav(recordingBlob, `sonaweave-recording-${Date.now()}.wav`, recordingUrl))}><Download size={16}/>导出原始录音 WAV</button><button type="button" className="tool-button" data-testid="export-diagnostic" disabled={locked} onClick={() => void saveDiagnostic()}><Download size={16}/>导出诊断 JSON</button></div><small>离开页面或开始下一次接收后，录音会清除。</small></div></DetailPanel>}
      </section>
      <section className="diagnostics-section" id="mobile-panel-inspect" aria-label="指标与协议诊断">
        <div className="section-heading"><div><h2>收音诊断</h2></div></div>
        <div className="diagnostic-cards"><div className="telemetry"><dl><div><dt>实际麦克风</dt><dd>{evidence?.audio.diagnostics?.deviceLabel ?? recorder.deviceLabel ?? "开始接收后显示"}</dd></div><div><dt>采集方式</dt><dd>{evidence?.audio.diagnostics?.backend ?? "--"}</dd></div><div><dt>启动耗时</dt><dd>{evidence?.audio.diagnostics ? `${Math.round(evidence.audio.diagnostics.startupMs)} ms` : "--"}</dd></div><div><dt>峰值</dt><dd>{evidence ? db(evidence.analysis.peak) : "--"}</dd></div><div><dt>削波比例</dt><dd>{evidence ? `${(evidence.analysis.clippedFraction * 100).toFixed(2)}%` : "--"}</dd></div></dl></div><DetailPanel title="使用说明"><p>音量条只表示声音大小。收不到文字时，可回听录音，检查声波是否完整，并导出录音与诊断文件。</p><p>ggwave 使用 Reed-Solomon 纠错；FSK / DTMF 使用 SWP-1 CRC16 校验。</p></DetailPanel></div>
      </section>
    </main>
    <nav className="mobile-tab-bar" data-motion={motion.active ? "moving" : "idle"} aria-label="主要工作区"><span key={motion.sequence} className={`mobile-tab-selection at-${mobileView}`} style={navStyle} aria-hidden="true" onAnimationEnd={event => { if (event.animationName !== "liquid-nav-slide") return; const sequence = motion.sequence; setMotion(current => current.sequence === sequence ? { ...current, active: false } : current); }}/>{tabs.map(({ view, label, Icon }) => <button key={view} type="button" className={mobileView === view ? "active" : ""} aria-current={mobileView === view ? "page" : undefined} aria-controls={`mobile-panel-${view}`} onClick={() => selectView(view)}><Icon size={20} aria-hidden="true"/><span>{label}</span></button>)}</nav>
    <footer className="app-footer"><span>SonaWeave 0.2.3</span></footer>
  </div>;
}
