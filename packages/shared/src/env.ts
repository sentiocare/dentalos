import type { z } from "zod";

/**
 * Validates environment variables at startup and fails fast with a readable list of problems.
 * Values are never printed, only variable names, so secrets cannot leak into deploy logs.
 */
export function loadEnv<T extends z.ZodType>(
  schema: T,
  source: Record<string, string | undefined> = process.env,
): z.infer<T> {
  // `KEY=` in a .env file or a blank Railway variable means "not set", not an empty string.
  const cleaned = Object.fromEntries(
    Object.entries(source).filter(([, v]) => v !== undefined && v.trim() !== ""),
  );
  const result = schema.safeParse(cleaned);
  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${problems}\nSee docs/SETUP.md.`);
  }
  return result.data;
}
