import { useEffect, useRef, useSyncExternalStore } from "react";
import { PcmRecorder } from "../platform/pcmRecorder";

export type { RecorderStatus, PcmRecording, RecorderStartOptions } from "../platform/pcmRecorder";

export function useRecorder() {
  const controllerRef = useRef<PcmRecorder | null>(null);
  if (!controllerRef.current) controllerRef.current = new PcmRecorder();
  const controller = controllerRef.current;
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);

  useEffect(() => () => controller.cancel(), [controller]);

  return {
    ...snapshot,
    start: controller.start,
    stop: controller.stop,
    cancel: controller.cancel,
    reset: controller.reset,
    getLastRecording: controller.getLastRecording,
  };
}
