/** Errors from the API, with the server's machine-readable code ("slot_taken", "needs_confirmation", …). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly body: Record<string, unknown>,
  ) {
    super(message);
  }
}

/** The request never reached the server (no network). The change can be queued for later. */
export class OfflineError extends Error {
  constructor() {
    super("offline");
  }
}

export interface ApiClientOptions {
  apiUrl: string;
  getToken: () => Promise<string | null>;
  clinicId: () => string | null;
  onUnauthorized: () => void;
}

export type ApiFn = <T>(
  path: string,
  init?: { method?: string; body?: unknown; signal?: AbortSignal },
) => Promise<T>;

export function createApiClient(options: ApiClientOptions): ApiFn {
  return async function api<T>(
    path: string,
    init: { method?: string; body?: unknown; signal?: AbortSignal } = {},
  ) {
    const token = await options.getToken();
    const clinicId = options.clinicId();
    let res: Response;
    try {
      res = await fetch(`${options.apiUrl}${path}`, {
        method: init.method ?? "GET",
        headers: {
          ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(clinicId ? { "x-clinic-id": clinicId } : {}),
        },
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
        signal: init.signal,
      });
    } catch (error) {
      if ((error as Error).name === "AbortError") throw error;
      throw new OfflineError();
    }
    const text = await res.text();
    const body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    if (!res.ok) {
      if (res.status === 401) options.onUnauthorized();
      throw new ApiError(
        res.status,
        String(body.error ?? "error"),
        String(body.message ?? res.statusText),
        body,
      );
    }
    return body as T;
  };
}

export function newIdempotencyKey(): string {
  return `web-${crypto.randomUUID()}`;
}
