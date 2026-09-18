import { describe, expect, it } from "vitest";
import { fixture, formats } from "../e2e/fixtures.js";

describe("benchmark fixtures", () => {
  for (const format of formats) it(`${format}: deterministic replacement oracle preserves unrelated data`, () => {
    const { input, expected } = fixture(format, 300);
    expect(fixture(format, 300)).toEqual({ input, expected });
    expect(Buffer.byteLength(input)).toBeGreaterThan(20_000);
    expect(input.match(/PENDING_REVIEW/g)).toHaveLength(200);
    expect(expected.match(/APPROVED/g)).toHaveLength(200);
    expect(expected.match(/COMPLETE/g)).toHaveLength(100);
    expect(expected.replaceAll("APPROVED", "PENDING_REVIEW")).toBe(input);
    expect(expected.endsWith("\n")).toBe(true);
  });
});
