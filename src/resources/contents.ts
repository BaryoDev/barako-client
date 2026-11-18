import { pathSegment } from "../path";
import type { Transport } from "../transport";
import type {
  Content,
  ContentStatus,
  ContentVersion,
  CreateContentInput,
  DryRunResult,
  ListContentQuery,
  Paged,
  UpdateContentInput,
} from "../types";
import { allPages } from "./all-pages";

export interface WriteResult {
  id: string;
  version: number;
  message?: string;
}

/** What a rollback answers: the entry as it stands after the restore. */
export interface RollbackResult {
  id: string;
  contentType: string;
  data: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
  status: ContentStatus;
  lastModifiedBy?: string;
}

export interface ContentsResource {
  list(query?: ListContentQuery): Promise<Paged<Content>>;
  /** `etag` is the ETag response header, when the server sends one. Send it back as `ifMatch`. */
  get(id: string): Promise<Content & { etag?: string }>;
  /** One entry by type and slug, with its `etag`. */
  bySlug(type: string, slug: string): Promise<Content & { etag?: string }>;
  /** Create an entry. `dryRun` checks it and returns the changes without storing anything. */
  create(
    input: CreateContentInput,
    opts?: { dryRun?: boolean; idempotencyKey?: string },
  ): Promise<WriteResult | DryRunResult>;
  /** Update an entry. Pass `version` for optimistic concurrency (rejected if it changed under you).
   *  `ifMatch` sends an ETag from get as If-Match. */
  update(
    id: string,
    input: UpdateContentInput & { version?: number },
    opts?: { ifMatch?: string; dryRun?: boolean },
  ): Promise<(WriteResult & { etag?: string }) | DryRunResult>;
  /** Run a named lifecycle transition on a content type that declares one. */
  transition(id: string, name: string): Promise<{ message?: string }>;
  /** Set or clear the publish and unpublish times (ISO 8601, UTC). */
  schedule(id: string, at: { publishAt?: string; unpublishAt?: string }): Promise<unknown>;
  /** Restore an earlier version, by the version id from history. */
  rollback(id: string, versionId: string): Promise<RollbackResult>;
  /** Remove an entry and its history for good. Needs the erase capability. */
  erase(id: string): Promise<void>;
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
          search: query.search,
        },
      }),

    get: async (id) => {
      const { body, headers } = await transport.requestWithHeaders<Content>({
        method: "GET",
        path: `/api/contents/${pathSegment(id)}`,
      });
      return withEtag(body, headers);
    },

    bySlug: async (type, slug) => {
      const { body, headers } = await transport.requestWithHeaders<Content>({
        method: "GET",
        path: `/api/contents/by-slug/${pathSegment(type)}/${pathSegment(slug)}`,
      });
      return withEtag(body, headers);
    },

    create: (input, opts) =>
      transport.request<WriteResult | DryRunResult>({
        method: "POST",
        path: "/api/contents",
        body: opts?.dryRun ? { ...input, dryRun: true } : input,
        headers: opts?.idempotencyKey ? { "Idempotency-Key": opts.idempotencyKey } : undefined,
      }),

    update: async (id, input, opts) => {
      const { body, headers } = await transport.requestWithHeaders<WriteResult | DryRunResult>({
        method: "PUT",
        path: `/api/contents/${pathSegment(id)}`,
        body: opts?.dryRun ? { id, ...input, dryRun: true } : { id, ...input },
        headers: opts?.ifMatch ? { "If-Match": opts.ifMatch } : undefined,
      });
      return "dryRun" in body && body.dryRun ? body : withEtag(body, headers);
    },

    setStatus: async (id, status) =>
      transport.request<{ message?: string }>({
        method: "PUT",
        path: `/api/contents/${pathSegment(id)}/status`,
        body: { id, newStatus: status },
      }),

    transition: async (id, name) =>
      transport.request<{ message?: string }>({
        method: "PUT",
        path: `/api/contents/${pathSegment(id)}/status`,
        body: { id, transition: name },
      }),

    schedule: async (id, at) =>
      transport.request<unknown>({
        method: "PUT",
        path: `/api/contents/${pathSegment(id)}/schedule`,
        body: { id, scheduledPublishAt: at.publishAt, scheduledUnpublishAt: at.unpublishAt },
      }),

    rollback: async (id, versionId) =>
      transport.request<RollbackResult>({
        method: "POST",
        path: `/api/contents/${pathSegment(id)}/rollback/${pathSegment(versionId)}`,
      }),

    erase: async (id) => {
      await transport.request<void>({
        method: "DELETE",
        path: `/api/contents/${pathSegment(id)}/erase`,
      });
    },

    history: (id) =>
      allPages((query) =>
        transport.request<Paged<ContentVersion>>({ method: "GET", path: `/api/contents/${pathSegment(id)}/history`, query }),
      ),
  };
}

function withEtag<T extends object>(body: T, headers: Headers): T & { etag?: string } {
  const etag = headers.get("ETag") ?? undefined;
  return etag === undefined ? body : { ...body, etag };
}
