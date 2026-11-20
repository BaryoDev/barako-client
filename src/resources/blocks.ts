import { callOpts, type CallOptions } from "../http";
import type { Transport } from "../transport";

export interface BlocksResource {
  /** The block schema that blocks fields are written against. */
  schema(opts?: CallOptions): Promise<unknown>;
}

export function blocksResource(transport: Transport): BlocksResource {
  return {
    schema: (opts) => transport.request<unknown>({ method: "GET", path: "/api/blocks/schema", ...callOpts(opts) }),
  };
}
