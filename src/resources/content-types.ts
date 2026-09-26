import type { Transport } from "../transport";
import type { ContentTypeDefinition, Paged } from "../types";
import { allPages } from "./all-pages";

export interface ContentTypesResource {
  /** Every content type (schema) in the current tenant. */
  list(): Promise<ContentTypeDefinition[]>;
  /** Define a new content type. */
  create(definition: ContentTypeDefinition): Promise<{ id: string; name: string }>;
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
  };
}
