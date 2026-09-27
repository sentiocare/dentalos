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
