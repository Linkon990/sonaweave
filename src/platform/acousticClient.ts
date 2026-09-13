import type { AcousticCommand, AcousticReport, AcousticResponse } from "../acoustic/messages";
import type { GgWaveSpeed, GgWaveTransmission } from "../acoustic/ggwave";

function worker() { return new Worker(new URL("../workers/acoustic.worker.ts", import.meta.url), { type: "module" }); }

function asError(error: unknown): Error { return error instanceof Error ? error : new Error(String(error)); }
function isResponse(value: unknown): value is AcousticResponse {
  if (!value || typeof value !== "object" || !("type" in value)) return false;
  if (value.type === "ready" || value.type === "finished") return true;
  if (value.type === "error") return "error" in value && typeof value.error === "string";
  if (value.type === "decoded") return "report" in value && Boolean(value.report) && typeof value.report === "object";
  return value.type === "encoded" && "transmission" in value && Boolean(value.transmission) && typeof value.transmission === "object";
}

function releaseWorker(job: Worker) {
  job.onmessage = null; job.onerror = null; job.onmessageerror = null;
  job.terminate();
}

function run<T>(command: AcousticCommand, signal: AbortSignal, transfer: Transferable[] = []): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new DOMException("Cancelled", "AbortError")); return; }
    const job = worker();
    let settled = false;
    const finish = (error?: Error, value?: T) => {
      if (settled) return; settled = true;
      clearTimeout(timer); signal.removeEventListener("abort", cancel); releaseWorker(job);
      if (error) reject(error); else resolve(value!);
    };
    const cancel = () => finish(new DOMException("Cancelled", "AbortError"));
    const timer = setTimeout(() => finish(new Error("Audio operation timed out")), 45_000);
    signal.addEventListener("abort", cancel, { once: true });
    job.onerror = () => finish(new Error("Audio engine failed to load"));
    job.onmessageerror = () => finish(new Error("Audio engine returned invalid data"));
    job.onmessage = ({ data }) => {
      if (!isResponse(data)) { finish(new Error("Audio engine returned invalid data")); return; }
      if (data.type === "error") finish(new Error(data.error));
      else if (data.type === "encoded" && command.type === "encode") finish(undefined, data.transmission as T);
      else if (data.type === "decoded" && command.type === "decode") finish(undefined, data.report as T);
      else finish(new Error("Audio engine returned an unexpected response"));
    };
    try { job.postMessage(command, transfer); } catch (error) { finish(asError(error)); }
  });
}

export function buildAcousticMessage(text: string, speed: GgWaveSpeed, signal: AbortSignal) {
  return run<GgWaveTransmission>({ type: "encode", text, speed }, signal);
}

export function decodeAcousticRecording(samples: Float32Array, sampleRate: number, signal: AbortSignal) {
  if (signal.aborted) return Promise.reject(new DOMException("Cancelled", "AbortError"));
  const copy = samples.slice();
  return run<AcousticReport>({ type: "decode", samples: copy, sampleRate }, signal, [copy.buffer]);
}

/** WASM lives outside the UI. PCM can queue during initialization without losing the head. */
export function startLiveDecoder(onReport: (report: AcousticReport) => void, onError: (error: Error) => void) {
  let job: Worker | undefined;
  let closed = false;
  let ready = false;
  let finishing = false;
  let delivered = false;
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  const initialized = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  // Some callers only observe onError. Keep cancellation from becoming an
  // unhandled rejection while preserving the original promise for awaiters.
  void initialized.catch(() => {});
  const fail = (error: Error) => {
    if (closed) return;
    rejectReady(error); shutdown();
    try { onError(error); } catch { /* The caller cannot interrupt resource cleanup. */ }
  };
  let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => fail(new Error("Audio engine initialization timed out")), 15_000);
  function shutdown() {
    if (closed) return; closed = true;
    clearTimeout(timer);
    if (job) releaseWorker(job);
  }
  function close() {
    if (closed) return;
    if (!ready) rejectReady(new DOMException("Cancelled", "AbortError"));
    shutdown();
  }
  function send(command: AcousticCommand, transfer: Transferable[] = []) {
    if (closed || !job) return;
    try { job.postMessage(command, transfer); } catch (error) { fail(asError(error)); }
  }
  try {
    job = worker();
    job.onerror = () => fail(new Error("Audio engine failed to load"));
    job.onmessageerror = () => fail(new Error("Audio engine returned invalid data"));
    job.onmessage = ({ data }) => {
      if (closed) return;
      if (!isResponse(data)) { fail(new Error("Audio engine returned invalid data")); return; }
      if (data.type === "ready") {
        ready = true;
        if (!finishing) clearTimeout(timer);
        resolveReady();
      } else if (data.type === "decoded" && !delivered) {
        delivered = true;
        // First complete packet ends this receive operation; release before
        // callbacks can start another operation or throw.
        if (!ready) { ready = true; resolveReady(); }
        shutdown();
        try { onReport(data.report); } catch { /* Report consumer owns its errors. */ }
      } else if (data.type === "finished") {
        if (!ready) { ready = true; resolveReady(); }
        shutdown();
      } else if (data.type === "error") fail(new Error(data.error));
      else fail(new Error("Audio engine returned an unexpected response"));
    };
    // Queue initialization before any caller can push PCM, but report a posting
    // failure asynchronously so the returned controller can first be installed.
    try { job.postMessage({ type: "prepare" } satisfies AcousticCommand); }
    catch (error) { queueMicrotask(() => fail(asError(error))); }
  } catch (error) {
    // Allow the caller to install its returned controller before onError runs.
    queueMicrotask(() => fail(asError(error)));
  }
  return {
    initialized, close,
    finish() {
      if (closed || finishing) return;
      finishing = true;
      clearTimeout(timer);
      timer = setTimeout(() => fail(new Error("Audio engine finish timed out")), 15_000);
      send({ type: "finish" });
    },
    push(samples: Float32Array, sampleRate: number) {
      if (closed || finishing) return;
      // onSamples supplies a disposable copy; retain the recorder's original PCM.
      send({ type: "chunk", samples, sampleRate }, [samples.buffer as ArrayBuffer]);
    },
  };
}
