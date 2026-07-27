import type { Transport } from "../transport";
import type {
  Content,
  ContentStatus,
  ContentVersion,
  CreateContentInput,
  ListContentQuery,
  Paged,
  UpdateContentInput,
} from "../types";

export interface WriteResult {
  id: string;
  version: number;
  message?: string;
}

export interface ContentsResource {
  list(query?: ListContentQuery): Promise<Paged<Content>>;
  get(id: string): Promise<Content>;
  create(input: CreateContentInput): Promise<WriteResult>;
  /** Update an entry. Pass `version` for optimistic concurrency (rejected if it changed under you). */
  update(id: string, input: UpdateContentInput & { version?: number }): Promise<WriteResult>;
  /** Change only the lifecycle status (publish, archive, draft). */
  setStatus(id: string, status: ContentStatus): Promise<{ message?: string }>;
  history(id: string): Promise<ContentVersion[]>;
}

export function contentsResource(transport: Transport): ContentsResource {
  return {
    list: (query) =>
      transport.request<Paged<Content>>({
        method: "GET",
        path: "/api/contents",
        query: query && {
          contentType: query.contentType,
          page: query.page,
          pageSize: query.pageSize,
          status: query.status,
        },
      }),

    get: (id) => transport.request<Content>({ method: "GET", path: `/api/contents/${id}` }),

    create: (input) =>
      transport.request<WriteResult>({ method: "POST", path: "/api/contents", body: input }),

    update: (id, input) =>
      transport.request<WriteResult>({
        method: "PUT",
        path: `/api/contents/${id}`,
        body: { id, ...input },
      }),

    setStatus: (id, status) =>
      transport.request<{ message?: string }>({
        method: "PUT",
        path: `/api/contents/${id}/status`,
        body: { id, newStatus: status },
      }),

    history: (id) =>
      transport.request<ContentVersion[]>({ method: "GET", path: `/api/contents/${id}/history` }),
  };
}
