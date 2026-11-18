import type { Transport } from "../transport";

export interface PagesResource {
  /** The page tree. */
  tree(): Promise<unknown>;
}

export function pagesResource(transport: Transport): PagesResource {
  return {
    tree: () => transport.request<unknown>({ method: "GET", path: "/api/pages/tree" }),
  };
}
