import { concatBytes, readUint16, writeUint16 } from "./bytes";
import { crc16Ccitt } from "./crc16";

const MAGIC = new Uint8Array([0x53, 0x57]);
const VERSION = 1;
const HEADER_LENGTH = 10;

export interface FrameOptions {
  compressed: boolean;
  messageId?: number;
  originalLength: number;
}

export interface ParsedFrame {
  compressed: boolean;
  messageId: number;
  originalLength: number;
  payload: Uint8Array;
  crcExpected: number;
  crcActual: number;
  crcValid: boolean;
  frameLength: number;
}

export function createFrame(payload: Uint8Array, options: FrameOptions): Uint8Array {
  if (payload.length > 0xffff || options.originalLength > 0xffff) {
    throw new Error("Payload exceeds the SWP-1 frame limit");
  }

  const messageId = options.messageId ?? Date.now() & 0xffff;
  const header = concatBytes(
    MAGIC,
    new Uint8Array([VERSION, options.compressed ? 1 : 0]),
    writeUint16(messageId),
    writeUint16(options.originalLength),
    writeUint16(payload.length),
  );
  const body = concatBytes(header, payload);
  return concatBytes(body, writeUint16(crc16Ccitt(body)));
}

export function parseFrame(bytes: Uint8Array): ParsedFrame {
  if (bytes.length < HEADER_LENGTH + 2) {
    throw new Error("Received data is shorter than an SWP-1 frame");
  }
  if (bytes[0] !== MAGIC[0] || bytes[1] !== MAGIC[1]) {
    throw new Error("SWP-1 sync marker was not recovered");
  }
  if (bytes[2] !== VERSION) {
    throw new Error(`Unsupported SWP version: ${bytes[2]}`);
  }

  const payloadLength = readUint16(bytes, 8);
  const frameLength = HEADER_LENGTH + payloadLength + 2;
  if (bytes.length < frameLength) {
    throw new Error(`Frame is truncated: expected ${frameLength} bytes, received ${bytes.length}`);
  }

  const body = bytes.slice(0, frameLength - 2);
  const crcExpected = readUint16(bytes, frameLength - 2);
  const crcActual = crc16Ccitt(body);

  return {
    compressed: (bytes[3] & 1) === 1,
    messageId: readUint16(bytes, 4),
    originalLength: readUint16(bytes, 6),
    payload: bytes.slice(HEADER_LENGTH, HEADER_LENGTH + payloadLength),
    crcExpected,
    crcActual,
    crcValid: crcExpected === crcActual,
    frameLength,
  };
}

export const frameConstants = {
  headerLength: HEADER_LENGTH,
  version: VERSION,
};
