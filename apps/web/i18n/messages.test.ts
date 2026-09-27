import { describe, expect, it } from "vitest";
import en from "../messages/en.json";
import hi from "../messages/hi.json";

function keys(obj: object, prefix = ""): string[] {
  return Object.entries(obj).flatMap(([k, v]) =>
    v && typeof v === "object" ? keys(v, `${prefix}${k}.`) : [`${prefix}${k}`],
  );
}

describe("UI translations", () => {
  it("Hindi has exactly the same keys as English", () => {
    expect(keys(hi).sort()).toEqual(keys(en).sort());
  });

  it("no Hindi string is left empty", () => {
    const flat = (o: object): string[] =>
      Object.values(o).flatMap((v) => (typeof v === "string" ? [v] : flat(v as object)));
    for (const s of flat(hi)) expect(s.trim()).not.toBe("");
  });
});
