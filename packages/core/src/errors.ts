/** Errors the API turns into clear responses (and the agents into clear sentences). */
export type DomainErrorCode =
  "not_found" | "invalid" | "slot_taken" | "hold_not_found" | "needs_confirmation" | "forbidden" | "conflict";

export class DomainError extends Error {
  constructor(
    readonly code: DomainErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "DomainError";
  }
}

export function pgErrorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

/**
 * Runs async steps one after another. A database client can only run one query at a time, so work that
 * shares a client must not use Promise.all.
 */
export async function sequential<T extends readonly unknown[]>(
  ...steps: { [K in keyof T]: () => Promise<T[K]> }
): Promise<T> {
  const results: unknown[] = [];
  for (const step of steps) results.push(await step());
  return results as unknown as T;
}
