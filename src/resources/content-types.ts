import { pathSegment } from "../path";
import { callOpts, type CallOptions } from "../http";
import type { Transport } from "../transport";
import type { AddFieldInput, AddFieldResult, ContentTypeDefinition, Paged, ReadableContentType } from "../types";
import { allPages } from "./all-pages";

export interface ContentTypesResource {
  /** Every content type (schema) in the current tenant. */
  list(opts?: CallOptions): Promise<ContentTypeDefinition[]>;
  /** Define a new content type. */
  create(definition: ContentTypeDefinition, opts?: CallOptions): Promise<{ id: string; name: string }>;
  /** Names of the content types this caller may read (GET /api/contents/types). */
  readable(opts?: CallOptions): Promise<string[]>;
  /** The shape of one readable content type, so you can see its fields before writing. */
  get(name: string, opts?: CallOptions): Promise<ReadableContentType>;
  /** Add one field to a content type that exists (POST /api/content-types/{name}/fields). Needs the
   *  `contenttype:write` scope on a key. The server refuses a name the type already has. */
  addField(name: string, field: AddFieldInput, opts?: CallOptions): Promise<AddFieldResult>;
}

export function contentTypesResource(transport: Transport): ContentTypesResource {
  return {
    list: (opts) =>
      allPages((query) =>
        transport.request<Paged<ContentTypeDefinition>>({ method: "GET", path: "/api/content-types", query, ...callOpts(opts) }),
      ),

    create: (definition, opts) =>
      transport.request<{ id: string; name: string }>({
        method: "POST",
        path: "/api/content-types",
        body: definition,
        ...callOpts(opts),
      }),

    readable: async (opts) => {
      const res = await transport.request<{ items: Array<{ name: string }> }>({
        method: "GET",
        path: "/api/contents/types",
        ...callOpts(opts),
      });
      return (res?.items ?? []).map((t) => t.name);
    },

    get: (name, opts) =>
      transport.request<ReadableContentType>({
        method: "GET",
        path: `/api/contents/types/${pathSegment(name)}`,
        ...callOpts(opts),
      }),

    addField: (name, field, opts) =>
      transport.request<AddFieldResult>({
        method: "POST",
        path: `/api/content-types/${pathSegment(name)}/fields`,
        body: field,
        ...callOpts(opts),
      }),
  };
}
