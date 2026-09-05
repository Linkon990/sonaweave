export interface FecRecovery {
  data: Uint8Array;
  correctedCodewords: number;
  uncorrectableCodewords: number;
  totalCodewords: number;
}

function encodeNibble(nibble: number): number {
  const bits = new Array<number>(9).fill(0);
  bits[3] = (nibble >> 3) & 1;
  bits[5] = (nibble >> 2) & 1;
  bits[6] = (nibble >> 1) & 1;
  bits[7] = nibble & 1;
  bits[1] = bits[3] ^ bits[5] ^ bits[7];
  bits[2] = bits[3] ^ bits[6] ^ bits[7];
  bits[4] = bits[5] ^ bits[6] ^ bits[7];
  bits[8] = bits.slice(1, 8).reduce((parity, bit) => parity ^ bit, 0);

  let encoded = 0;
  for (let position = 1; position <= 8; position += 1) {
    encoded |= bits[position] << (8 - position);
  }
  return encoded;
}

function decodeCodeword(codeword: number): {
  nibble: number;
  corrected: boolean;
  uncorrectable: boolean;
} {
  const bits = new Array<number>(9).fill(0);
  for (let position = 1; position <= 8; position += 1) {
    bits[position] = (codeword >> (8 - position)) & 1;
  }

  const syndrome =
    (bits[1] ^ bits[3] ^ bits[5] ^ bits[7]) |
    ((bits[2] ^ bits[3] ^ bits[6] ^ bits[7]) << 1) |
    ((bits[4] ^ bits[5] ^ bits[6] ^ bits[7]) << 2);
  const overallParity = bits.slice(1, 9).reduce((parity, bit) => parity ^ bit, 0);
  let corrected = false;
  let uncorrectable = false;

  if (syndrome !== 0 && overallParity === 1) {
    bits[syndrome] ^= 1;
    corrected = true;
  } else if (syndrome === 0 && overallParity === 1) {
    bits[8] ^= 1;
    corrected = true;
  } else if (syndrome !== 0 && overallParity === 0) {
    uncorrectable = true;
  }

  const nibble = (bits[3] << 3) | (bits[5] << 2) | (bits[6] << 1) | bits[7];
  return { nibble, corrected, uncorrectable };
}

export function protectWithHamming(bytes: Uint8Array): Uint8Array {
  const protectedBytes = new Uint8Array(bytes.length * 2);
  for (let index = 0; index < bytes.length; index += 1) {
    protectedBytes[index * 2] = encodeNibble(bytes[index] >> 4);
    protectedBytes[index * 2 + 1] = encodeNibble(bytes[index] & 0x0f);
  }
  return protectedBytes;
}

export function recoverWithHamming(bytes: Uint8Array): FecRecovery {
  const pairCount = Math.floor(bytes.length / 2);
  const data = new Uint8Array(pairCount);
  let correctedCodewords = 0;
  let uncorrectableCodewords = 0;

  for (let index = 0; index < pairCount; index += 1) {
    const high = decodeCodeword(bytes[index * 2]);
    const low = decodeCodeword(bytes[index * 2 + 1]);
    data[index] = (high.nibble << 4) | low.nibble;
    correctedCodewords += Number(high.corrected) + Number(low.corrected);
    uncorrectableCodewords += Number(high.uncorrectable) + Number(low.uncorrectable);
  }

  return {
    data,
    correctedCodewords,
    uncorrectableCodewords,
    totalCodewords: pairCount * 2,
  };
}
