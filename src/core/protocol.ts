import { simulateChannel, type ChannelSettings } from "./channel";
import { createFrame, parseFrame, type ParsedFrame } from "./frame";
import { protectWithHamming, recoverWithHamming, type FecRecovery } from "./hamming";
import { compressLzw, decompressLzw } from "./lzw";
import { demodulate, modulate, type DemodulatedData, type ModemMode, type ModulatedSignal } from "./modem";

export interface Transmission {
  text: string;
  mode: ModemMode;
  rawBytes: Uint8Array;
  compressionCandidate: Uint8Array;
  payload: Uint8Array;
  compressed: boolean;
  frame: Uint8Array;
  protectedBytes: Uint8Array;
  signal: ModulatedSignal;
}

export interface DecodeReport {
  text: string;
  modem: DemodulatedData;
  fec: FecRecovery;
  frame: ParsedFrame;
  decodedBytes: Uint8Array;
}

export interface EncodeOptions {
  compression?: boolean;
  messageId?: number;
}

export function encodeMessage(text: string, mode: ModemMode, options: EncodeOptions = {}): Transmission {
  const rawBytes = new TextEncoder().encode(text);
  if (rawBytes.length === 0) {
    throw new Error("Enter a message before building the signal");
  }

  const compressionCandidate = compressLzw(rawBytes);
  const compressed = options.compression !== false && compressionCandidate.length < rawBytes.length;
  const payload = compressed ? compressionCandidate : rawBytes;
  const frame = createFrame(payload, {
    compressed,
    messageId: options.messageId,
    originalLength: rawBytes.length,
  });
  const protectedBytes = protectWithHamming(frame);
  const signal = modulate(protectedBytes, mode);

  return {
    text,
    mode,
    rawBytes,
    compressionCandidate,
    payload,
    compressed,
    frame,
    protectedBytes,
    signal,
  };
}

export function decodeSamples(samples: Float32Array, sampleRate: number, mode: ModemMode): DecodeReport {
  const demodulated = demodulate(samples, sampleRate, mode);
  const initialFec = recoverWithHamming(demodulated.bytes);
  const initialFrame = parseFrame(initialFec.data);
  const protectedFrameLength = initialFrame.frameLength * 2;
  const fec = recoverWithHamming(demodulated.bytes.slice(0, protectedFrameLength));
  const frame = parseFrame(fec.data);
  const expectedSymbols = protectedFrameLength * (mode === "fsk" ? 8 : 2);
  const usefulConfidences = demodulated.symbolConfidences.slice(0, expectedSymbols);
  const modem: DemodulatedData = {
    ...demodulated,
    confidence:
      usefulConfidences.length === 0
        ? 0
        : usefulConfidences.reduce((total, value) => total + value, 0) / usefulConfidences.length,
    symbolsRead: usefulConfidences.length,
  };

  if (!frame.crcValid) {
    throw new Error(
      `CRC mismatch (received ${frame.crcExpected.toString(16).padStart(4, "0")}, calculated ${frame.crcActual
        .toString(16)
        .padStart(4, "0")})`,
    );
  }

  const decodedBytes = frame.compressed ? decompressLzw(frame.payload) : frame.payload;
  if (decodedBytes.length !== frame.originalLength) {
    throw new Error(
      `Payload length mismatch (expected ${frame.originalLength} bytes, decoded ${decodedBytes.length})`,
    );
  }

  return {
    text: new TextDecoder("utf-8", { fatal: true }).decode(decodedBytes),
    modem,
    fec,
    frame,
    decodedBytes,
  };
}

export function runChannelLoopback(
  transmission: Transmission,
  settings: ChannelSettings,
  seed?: number,
): { samples: Float32Array; report: DecodeReport } {
  const samples = simulateChannel(
    transmission.signal.samples,
    transmission.signal.sampleRate,
    settings,
    seed,
  );
  return {
    samples,
    report: decodeSamples(samples, transmission.signal.sampleRate, transmission.mode),
  };
}
