import { describe, expect, it } from "vitest";
import { z } from "zod";
import { loadEnv } from "./env.js";

const schema = z.object({ DATABASE_URL: z.string().url(), SENTRY_DSN: z.string().url().optional() });

describe("loadEnv", () => {
  it("treats blank values as unset", () => {
    expect(loadEnv(schema, { DATABASE_URL: "postgres://x@h/db", SENTRY_DSN: "" })).toEqual({
      DATABASE_URL: "postgres://x@h/db",
    });
  });

  it("names invalid variables without echoing their values", () => {
    const run = () => loadEnv(schema, { DATABASE_URL: "not-a-url-secret123" });
    expect(run).toThrow(/DATABASE_URL/);
    expect(run).not.toThrow(/secret123/);
  });
});
