import { useCallback, useEffect, useRef, useState } from "react";
import {
  MicrophoneError,
  normalizeMicrophoneError,
  preferredRecorderMimeType,
  requestMicrophoneStream,
} from "../platform/microphone";

export type RecorderStatus = "idle" | "requesting" | "recording" | "processing";

export function useRecorder() {
  const [status, setStatus] = useState<RecorderStatus>("idle");
  const [deviceLabel, setDeviceLabel] = useState<string>();
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const startInFlightRef = useRef(false);
  const chunksRef = useRef<Blob[]>([]);
  const resolveRef = useRef<((blob: Blob) => void) | null>(null);
  const rejectRef = useRef<((error: Error) => void) | null>(null);

  const start = useCallback(async () => {
    if (startInFlightRef.current || recorderRef.current) {
      throw new MicrophoneError("recording-failed", "A microphone recording is already active");
    }

    if (typeof MediaRecorder === "undefined") {
      throw new MicrophoneError("unsupported", "MediaRecorder is unavailable in this browser");
    }

    startInFlightRef.current = true;
    setStatus("requesting");

    let stream: MediaStream | undefined;
    try {
      const activeStream = await requestMicrophoneStream();
      stream = activeStream;
      streamRef.current = activeStream;

      const mimeType = preferredRecorderMimeType();
      const recorder = new MediaRecorder(activeStream, mimeType ? { mimeType } : undefined);
      chunksRef.current = [];
      recorderRef.current = recorder;
      setDeviceLabel(activeStream.getAudioTracks()[0]?.label || "系统默认麦克风");

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" });
        activeStream.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
        recorderRef.current = null;
        setStatus("processing");
        resolveRef.current?.(blob);
        resolveRef.current = null;
        rejectRef.current = null;
      };
      recorder.onerror = (event) => {
        const recorderError = "error" in event ? event.error : undefined;
        const error = new MicrophoneError("recording-failed", "Microphone recording failed", {
          cause: recorderError,
        });
        activeStream.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
        recorderRef.current = null;
        setStatus("idle");
        rejectRef.current?.(error);
        resolveRef.current = null;
        rejectRef.current = null;
      };

      recorder.start(200);
      setStatus("recording");
    } catch (error) {
      stream?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      recorderRef.current = null;
      setStatus("idle");
      throw normalizeMicrophoneError(error);
    } finally {
      startInFlightRef.current = false;
    }
  }, []);

  const stop = useCallback(() => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state !== "recording") {
      return Promise.reject(new Error("No microphone recording is active"));
    }

    return new Promise<Blob>((resolve, reject) => {
      resolveRef.current = resolve;
      rejectRef.current = reject;
      recorder.stop();
    });
  }, []);

  const reset = useCallback(() => setStatus("idle"), []);

  useEffect(
    () => () => {
      const recorder = recorderRef.current;
      recorderRef.current = null;
      if (recorder && recorder.state !== "inactive") {
        recorder.onstop = null;
        recorder.onerror = null;
        recorder.stop();
      }
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    },
    [],
  );

  return { status, deviceLabel, start, stop, reset };
}
