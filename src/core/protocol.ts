import { simulateChannel, type ChannelSettings } from "./channel";
import { createFrame, frameConstants, parseFrame, type ParsedFrame } from "./frame";
import { protectWithHamming, recoverWithHamming, type FecRecovery } from "./hamming";
import { compressLzw, decompressLzw } from "./lzw";
import { demodulateCandidates, modulate, TrainingNotFoundError, type DemodulatedData, type ModemMode, type ModulatedSignal } from "./modem";
import { readUint16 } from "./bytes";

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
  mode: ModemMode;
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
  let failure: unknown;
  let failureStage = -1;
  for (const candidate of demodulateCandidates(samples, sampleRate, mode)) {
    let stage = 0;
    try {
      const headerFec = recoverWithHamming(candidate.read(frameConstants.headerLength * 2).bytes);
      const header = headerFec.data;
      if (header.length < frameConstants.headerLength) throw new Error("Received data is shorter than an SWP-1 header");
      if (header[0] !== 0x53 || header[1] !== 0x57) throw new Error("SWP-1 sync marker was not recovered");
      if (header[2] !== frameConstants.version) throw new Error(`Unsupported SWP version: ${header[2]}`);
      if ((header[3] & ~1) !== 0) throw new Error("Unsupported SWP-1 frame flags");
      stage = 1;
      if (headerFec.uncorrectableCodewords > 0) throw new Error("SWP-1 header has uncorrectable FEC errors");
      const frameLength = frameConstants.headerLength + readUint16(header, 8) + 2;
      return decodeCandidate(candidate.read(frameLength * 2), mode);
    } catch (error) {
      // Try the alternate timing reading or a later training match only after
      // this reading fails full validation. A weaker candidate must not replace
      // a useful CRC/payload error from one with a valid SWP-1 header.
      if (stage > failureStage) {
        failure = error;
        failureStage = stage;
      }
    }
  }
  throw failure ?? new Error("No complete SonaWeave frame was recovered");
}

/** Try the selected mode first, then the other; return only fully validated text. */
export function decodeSamplesAuto(samples: Float32Array, sampleRate: number, preferred: ModemMode = "fsk"): DecodeReport {
  let preferredFailure: unknown;
  try {
    return decodeSamples(samples, sampleRate, preferred);
  } catch (error) {
    preferredFailure = error;
  }
  try {
    return decodeSamples(samples, sampleRate, preferred === "fsk" ? "dtmf" : "fsk");
  } catch (otherFailure) {
    // If the other mode recovered training, preserve its CRC/truncation error
    // instead of describing the recording as an absent signal.
    throw otherFailure instanceof TrainingNotFoundError ? preferredFailure : otherFailure;
  }
}

function decodeCandidate(demodulated: DemodulatedData, mode: ModemMode): DecodeReport {
  const initialFec = recoverWithHamming(demodulated.bytes);
  const initialFrame = parseFrame(initialFec.data);
  const protectedFrameLength = initialFrame.frameLength * 2;
  const fec = recoverWithHamming(demodulated.bytes.slice(0, protectedFrameLength));
  if (fec.uncorrectableCodewords > 0) {
    throw new Error(`Frame has ${fec.uncorrectableCodewords} uncorrectable FEC codewords`);
  }
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

  const decodedBytes = frame.compressed ? decompressLzw(frame.payload, frame.originalLength) : frame.payload;
  if (decodedBytes.length !== frame.originalLength) {
    throw new Error(
      `Payload length mismatch (expected ${frame.originalLength} bytes, decoded ${decodedBytes.length})`,
    );
  }

  return {
    mode,
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
