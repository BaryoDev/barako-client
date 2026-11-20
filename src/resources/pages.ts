import { callOpts, type CallOptions } from "../http";
import type { Transport } from "../transport";

export interface PagesResource {
  /** The page tree. */
  tree(opts?: CallOptions): Promise<unknown>;
}

export function pagesResource(transport: Transport): PagesResource {
  return {
    tree: (opts) => transport.request<unknown>({ method: "GET", path: "/api/pages/tree", ...callOpts(opts) }),
  };
}
