import { pathSegment } from "../path";
import type { Transport } from "../transport";
import type { ContentTypeDefinition, Paged, ReadableContentType } from "../types";
import { allPages } from "./all-pages";

export interface ContentTypesResource {
  /** Every content type (schema) in the current tenant. */
  list(): Promise<ContentTypeDefinition[]>;
  /** Define a new content type. */
  create(definition: ContentTypeDefinition): Promise<{ id: string; name: string }>;
  /** Names of the content types this caller may read (GET /api/contents/types). */
  readable(): Promise<string[]>;
  /** The shape of one readable content type, so you can see its fields before writing. */
  get(name: string): Promise<ReadableContentType>;
}

export function contentTypesResource(transport: Transport): ContentTypesResource {
  return {
    list: () =>
      allPages((query) =>
        transport.request<Paged<ContentTypeDefinition>>({ method: "GET", path: "/api/content-types", query }),
      ),

    create: (definition) =>
      transport.request<{ id: string; name: string }>({
        method: "POST",
        path: "/api/content-types",
        body: definition,
      }),

    readable: async () => {
      const res = await transport.request<{ items: Array<{ name: string }> }>({
        method: "GET",
        path: "/api/contents/types",
      });
      return (res?.items ?? []).map((t) => t.name);
    },

    get: (name) =>
      transport.request<ReadableContentType>({
        method: "GET",
        path: `/api/contents/types/${pathSegment(name)}`,
      }),
  };
}
