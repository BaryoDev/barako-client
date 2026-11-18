import type { Transport } from "../transport";

export interface BlocksResource {
  /** The block schema that blocks fields are written against. */
  schema(): Promise<unknown>;
}

export function blocksResource(transport: Transport): BlocksResource {
  return {
    schema: () => transport.request<unknown>({ method: "GET", path: "/api/blocks/schema" }),
  };
}
