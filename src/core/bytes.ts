export function concatBytes(...chunks: Uint8Array[]): Uint8Array {
  const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const output = new Uint8Array(length);
  let offset = 0;

  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }

  return output;
}

export function bytesToBits(bytes: Uint8Array): number[] {
  const bits: number[] = [];
  for (const byte of bytes) {
    for (let shift = 7; shift >= 0; shift -= 1) {
      bits.push((byte >> shift) & 1);
    }
  }
  return bits;
}

export function bitsToBytes(bits: readonly number[]): Uint8Array {
  const bytes = new Uint8Array(Math.floor(bits.length / 8));
  for (let index = 0; index < bytes.length; index += 1) {
    let value = 0;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value << 1) | (bits[index * 8 + bit] & 1);
    }
    bytes[index] = value;
  }
  return bytes;
}

export function toHex(bytes: Uint8Array, maxBytes = bytes.length): string {
  const visible = bytes.slice(0, maxBytes);
  const value = Array.from(visible, (byte) => byte.toString(16).padStart(2, "0")).join(" ");
  return bytes.length > maxBytes ? `${value} ...` : value;
}

export function readUint16(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] << 8) | bytes[offset + 1];
}

export function writeUint16(value: number): Uint8Array {
  return new Uint8Array([(value >> 8) & 0xff, value & 0xff]);
}
