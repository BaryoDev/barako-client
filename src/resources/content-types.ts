import type { Transport } from "../transport";
import type { ContentTypeDefinition } from "../types";

export interface ContentTypesResource {
  /** Every content type (schema) in the current tenant. */
  list(): Promise<ContentTypeDefinition[]>;
  /** Define a new content type. */
  create(definition: ContentTypeDefinition): Promise<{ id: string; name: string }>;
}

export function contentTypesResource(transport: Transport): ContentTypesResource {
  return {
    // List reads /api/schemas (the definitions the admin uses); create writes /api/content-types.
    list: () => transport.request<ContentTypeDefinition[]>({ method: "GET", path: "/api/schemas" }),

    create: (definition) =>
      transport.request<{ id: string; name: string }>({
        method: "POST",
        path: "/api/content-types",
        body: definition,
      }),
  };
}
