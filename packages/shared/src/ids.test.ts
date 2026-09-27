import { describe, expect, it } from "vitest";
import { uuidv7 } from "./ids";

describe("uuidv7", () => {
  it("is a valid v7 UUID", () => {
    expect(uuidv7()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("sorts by creation time", () => {
    const a = uuidv7(1_700_000_000_000);
    const b = uuidv7(1_700_000_000_001);
    expect(a < b).toBe(true);
  });

  it("is unique", () => {
    const ids = new Set(Array.from({ length: 10_000 }, () => uuidv7(1)));
    expect(ids.size).toBe(10_000);
  });
});
