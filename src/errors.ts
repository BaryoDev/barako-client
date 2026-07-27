/** Thrown when the API returns a non-2xx response. Carries the status and the parsed body so callers
 *  can branch on `err.status` (401, 403, 404, 400 validation, ...) and read the server's message. */
export class BarakoError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, message: string, body?: unknown) {
    super(message);
    this.name = "BarakoError";
    this.status = status;
    this.body = body;
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
