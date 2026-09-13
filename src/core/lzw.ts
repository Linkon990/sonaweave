import { concatBytes, readUint16, writeUint16 } from "./bytes";

const MAX_CODE = 0xfff;

function packCodes(codes: readonly number[]): Uint8Array {
  const output: number[] = [];
  let buffer = 0;
  let bitCount = 0;

  for (const code of codes) {
    buffer = (buffer << 12) | code;
    bitCount += 12;

    while (bitCount >= 8) {
      const shift = bitCount - 8;
      output.push((buffer >> shift) & 0xff);
      bitCount -= 8;
      buffer &= bitCount === 0 ? 0 : (1 << bitCount) - 1;
    }
  }

  if (bitCount > 0) {
    output.push((buffer << (8 - bitCount)) & 0xff);
  }

  return new Uint8Array(output);
}

function unpackCodes(bytes: Uint8Array, count: number): number[] {
  const codes: number[] = [];
  let buffer = 0;
  let bitCount = 0;

  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bitCount += 8;

    while (bitCount >= 12 && codes.length < count) {
      const shift = bitCount - 12;
      codes.push((buffer >> shift) & MAX_CODE);
      bitCount -= 12;
      buffer &= bitCount === 0 ? 0 : (1 << bitCount) - 1;
    }
  }

  if (codes.length !== count) {
    throw new Error("LZW code stream is truncated");
  }

  return codes;
}

export function compressLzw(input: Uint8Array): Uint8Array {
  if (input.length === 0) {
    return writeUint16(0);
  }

  const dictionary = new Map<string, number>();
  for (let value = 0; value < 256; value += 1) {
    dictionary.set(String.fromCharCode(value), value);
  }

  const codes: number[] = [];
  let nextCode = 256;
  let phrase = String.fromCharCode(input[0]);

  for (let index = 1; index < input.length; index += 1) {
    const symbol = String.fromCharCode(input[index]);
    const candidate = phrase + symbol;

    if (dictionary.has(candidate)) {
      phrase = candidate;
      continue;
    }

    codes.push(dictionary.get(phrase)!);
    if (nextCode <= MAX_CODE) {
      dictionary.set(candidate, nextCode);
      nextCode += 1;
    }
    phrase = symbol;
  }

  codes.push(dictionary.get(phrase)!);
  if (codes.length > 0xffff) {
    throw new Error("Message is too large for the LZW12 frame");
  }

  return concatBytes(writeUint16(codes.length), packCodes(codes));
}

export function decompressLzw(input: Uint8Array, maximumOutputLength = 0xffff): Uint8Array {
  if (!Number.isSafeInteger(maximumOutputLength) || maximumOutputLength < 0 || maximumOutputLength > 0xffff) {
    throw new Error("Invalid LZW output length limit");
  }
  if (input.length < 2) {
    throw new Error("LZW payload is missing its code count");
  }

  const codeCount = readUint16(input, 0);
  if (codeCount === 0) {
    return new Uint8Array();
  }

  const codes = unpackCodes(input.slice(2), codeCount);
  const dictionary: number[][] = Array.from({ length: 256 }, (_, value) => [value]);
  let nextCode = 256;
  let previous = dictionary[codes[0]];

  if (!previous) {
    throw new Error("LZW payload starts with an invalid code");
  }

  if (previous.length > maximumOutputLength) {
    throw new Error(`LZW output exceeds declared length (${maximumOutputLength} bytes)`);
  }

  const output = [...previous];

  for (let index = 1; index < codes.length; index += 1) {
    const code = codes[index];
    let entry: number[];

    if (dictionary[code]) {
      entry = dictionary[code];
    } else if (code === nextCode) {
      entry = [...previous, previous[0]];
    } else {
      throw new Error("LZW payload contains an invalid dictionary reference");
    }

    // Check before output/dictionary allocation. A CRC-valid compressed frame
    // can still be malformed and expand far beyond its declared byte length.
    if (entry.length > maximumOutputLength - output.length) {
      throw new Error(`LZW output exceeds declared length (${maximumOutputLength} bytes)`);
    }
    output.push(...entry);
    if (nextCode <= MAX_CODE) {
      dictionary[nextCode] = [...previous, entry[0]];
      nextCode += 1;
    }
    previous = entry;
  }

  return new Uint8Array(output);
}
