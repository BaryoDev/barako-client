/** Why a request failed before an HTTP answer was usable. `timeout`, `aborted` and `network` carry
 *  status 0. `invalid-json` carries the status of the response whose body was not JSON. */
export type BarakoErrorCode = "timeout" | "aborted" | "network" | "invalid-json";

export interface BarakoErrorInit {
  code?: BarakoErrorCode;
  outcomeUnknown?: boolean;
}

/** Thrown when the API returns a non-2xx response, or when a request cannot finish. Carries the
 *  status and the parsed body so callers can branch on `err.status` (401, 403, 404, 400 validation,
 *  ...) and read the server's message. `code` is set when there was no usable answer. */
export class BarakoError extends Error {
  readonly status: number;
  readonly body: unknown;
  /** Set for a timeout, an abort, a network failure or a body that was not JSON. */
  readonly code?: BarakoErrorCode;
  /** True when a write timed out or lost its connection, so the server may have applied it. */
  readonly outcomeUnknown?: boolean;

  constructor(status: number, message: string, body?: unknown, init?: BarakoErrorInit) {
    super(message);
    this.name = "BarakoError";
    this.status = status;
    this.body = body;
    if (init?.code) this.code = init.code;
    if (init?.outcomeUnknown) this.outcomeUnknown = true;
  }

  get isUnauthorized(): boolean {
    return this.status === 401;
  }
  get isForbidden(): boolean {
    return this.status === 403;
  }
  get isNotFound(): boolean {
    return this.status === 404;
  }
  get isValidation(): boolean {
    return this.status === 400;
  }
}
