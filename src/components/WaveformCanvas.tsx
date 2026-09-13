import { useEffect, useRef } from "react";
import type { ModemMode } from "../core/modem";

interface WaveformCanvasProps {
  samples?: Float32Array;
  mode: ModemMode | "ggwave";
  progress?: number;
  channelActive?: boolean;
}

export function WaveformCanvas({
  samples,
  mode,
  progress = 0,
  channelActive = false,
}: WaveformCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const progressRef = useRef(progress);
  const paintProgressRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // Render PCM only when the signal or size changes. Playback updates simply
    // copy this bitmap, leaving the main thread free for recording and controls.
    const waveform = document.createElement("canvas");
    const paintProgress = () => {
      const context = canvas.getContext("2d");
      if (!context || !waveform.width || !waveform.height) return;
      const { width, height } = canvas;
      context.clearRect(0, 0, width, height);
      context.drawImage(waveform, 0, 0);
      const progressX = Math.max(0, Math.min(width, width * progressRef.current));
      if (progressX > 0) {
        context.fillStyle = "rgba(255,255,255,0.11)";
        context.fillRect(0, 0, progressX, height);
        context.strokeStyle = "rgba(255,255,255,0.9)";
        context.lineWidth = Math.min(window.devicePixelRatio || 1, 2);
        context.beginPath();
        context.moveTo(progressX, 0);
        context.lineTo(progressX, height);
        context.stroke();
      }
    };
    paintProgressRef.current = paintProgress;

    const draw = () => {
      const bounds = canvas.getBoundingClientRect();
      if (bounds.width <= 0 || bounds.height <= 0) return;
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      const width = Math.max(1, Math.round(bounds.width * ratio));
      const height = Math.max(1, Math.round(bounds.height * ratio));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      waveform.width = width;
      waveform.height = height;

      const context = waveform.getContext("2d");
      if (!context) return;

      context.clearRect(0, 0, width, height);
      context.fillStyle = "#111716";
      context.fillRect(0, 0, width, height);

      context.strokeStyle = "rgba(255,255,255,0.08)";
      context.lineWidth = ratio;
      for (let row = 1; row < 4; row += 1) {
        const y = (height * row) / 4;
        context.beginPath();
        context.moveTo(0, y);
        context.lineTo(width, y);
        context.stroke();
      }
      for (let column = 1; column < 8; column += 1) {
        const x = (width * column) / 8;
        context.beginPath();
        context.moveTo(x, 0);
        context.lineTo(x, height);
        context.stroke();
      }

      if (!samples || samples.length === 0) {
        context.strokeStyle = "rgba(255,255,255,0.35)";
        context.beginPath();
        context.moveTo(0, height / 2);
        context.lineTo(width, height / 2);
        context.stroke();
        paintProgress();
        return;
      }

      const center = height / 2;
      const amplitude = height * 0.39;
      const samplesPerPixel = samples.length / width;
      const color = channelActive ? "#f5d547" : mode === "fsk" ? "#55e39a" : "#ff7659";
      const envelope = new Float32Array(width);

      context.fillStyle = color;
      context.globalAlpha = 0.2;
      context.beginPath();
      for (let x = 0; x < width; x += 1) {
        const from = Math.floor(x * samplesPerPixel);
        const to = Math.max(from + 1, Math.floor((x + 1) * samplesPerPixel));
        let power = 0;

        for (let index = from; index < to && index < samples.length; index += 1) {
          power += samples[index] * samples[index];
        }
        const rms = Math.min(1, Math.sqrt(power / Math.max(1, to - from)) * 1.35);
        envelope[x] = rms;
        const y = center - rms * amplitude;
        if (x === 0) context.moveTo(x, y);
        else context.lineTo(x, y);
      }
      for (let x = width - 1; x >= 0; x -= 1) {
        context.lineTo(x, center + envelope[x] * amplitude);
      }
      context.closePath();
      context.fill();

      context.globalAlpha = 0.95;
      context.strokeStyle = color;
      context.lineWidth = Math.max(1, ratio * 0.85);
      context.beginPath();
      for (let x = 0; x < width; x += 1) {
        const sampleIndex = Math.min(samples.length - 1, Math.floor((x / Math.max(1, width - 1)) * samples.length));
        const y = center - samples[sampleIndex] * amplitude;
        if (x === 0) context.moveTo(x, y);
        else context.lineTo(x, y);
      }
      context.stroke();
      context.globalAlpha = 1;
      paintProgress();
    };

    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(canvas);
    return () => {
      observer.disconnect();
      paintProgressRef.current = null;
    };
  }, [samples, mode, channelActive]);

  useEffect(() => {
    progressRef.current = progress;
    paintProgressRef.current?.();
  }, [progress]);

  return <canvas ref={canvasRef} className="waveform-canvas" role="img" aria-label="声波波形预览" />;
}
