import { expect, it } from "vitest";
import { packetPlayback } from "./messages";

it("preserves every packet sample and leaves the expected lead, inter-packet gap and tail", () => {
  const packet = new Float32Array([0.25, -0.25]);
  const samples = packetPlayback(packet, 48_000, 2);
  expect(samples.length).toBe(16_800 + 4 + 19_200 + 14_400);
  expect(samples.slice(16_800, 16_802)).toEqual(packet);
  expect(samples.slice(16_802 + 19_200, 16_804 + 19_200)).toEqual(packet);
  expect(samples.filter((sample) => sample !== 0)).toHaveLength(4);
});

it.each([0, -1, 1.5, Infinity, 4])("rejects invalid repetition count %s before allocating output", (repeats) => {
  expect(() => packetPlayback(new Float32Array(1), 48_000, repeats)).toThrow("Invalid");
});
