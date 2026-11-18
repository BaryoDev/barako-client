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
  /** Never true on a real write. Lets code narrow a create or update result. */
  dryRun?: false;
}

/** What a rollback answers: the entry as it stands after the restore. */
export interface RollbackResult {
  id: string;
  contentType: string;
  data: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  status: ContentStatus;
  lastModifiedBy: string;
  sensitivity: number;
}

export interface ContentsResource {
  list(query?: ListContentQuery): Promise<Paged<Content>>;
  /** `etag` is the ETag response header, when the server sends one. Send it back as `ifMatch`. */
  get(id: string): Promise<Content & { etag?: string }>;
  /** One entry by type and slug, with its `etag`. */
  bySlug(type: string, slug: string): Promise<Content & { etag?: string }>;
  /** Create an entry. `dryRun` checks it and returns the changes without storing anything. */
  create(input: CreateContentInput, opts: { dryRun: true; idempotencyKey?: string }): Promise<DryRunResult>;
  create(input: CreateContentInput, opts?: { dryRun?: false; idempotencyKey?: string }): Promise<WriteResult>;
  /** Update an entry. Pass `version` for optimistic concurrency (rejected if it changed under you).
   *  `ifMatch` sends an ETag from get as If-Match. */
  update(
    id: string,
    input: UpdateContentInput & { version?: number },
    opts: { ifMatch?: string; dryRun: true },
  ): Promise<DryRunResult>;
  update(
    id: string,
    input: UpdateContentInput & { version?: number },
    opts?: { ifMatch?: string; dryRun?: false },
  ): Promise<WriteResult & { etag?: string }>;
  /** Run a named lifecycle transition on a content type that declares one. `data` carries the
   *  values for the fields that transition requires or allows. */
  transition(id: string, name: string, data?: Record<string, unknown>): Promise<{ message?: string }>;
  /** Set both times (ISO 8601, UTC). Every call replaces both, and null clears one, so state both.
   *  Event-sourced types need `version`. */
  schedule(
    id: string,
    at: { publishAt: string | null; unpublishAt: string | null; version?: number },
  ): Promise<unknown>;
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

    create: ((input: CreateContentInput, opts?: { dryRun?: boolean; idempotencyKey?: string }) =>
      transport.request<WriteResult | DryRunResult>({
        method: "POST",
        path: "/api/contents",
        body: opts?.dryRun ? { ...input, dryRun: true } : input,
        headers: opts?.idempotencyKey ? { "Idempotency-Key": opts.idempotencyKey } : undefined,
      })) as ContentsResource["create"],

    update: (async (
      id: string,
      input: UpdateContentInput & { version?: number },
      opts?: { ifMatch?: string; dryRun?: boolean },
    ) => {
      const { body, headers } = await transport.requestWithHeaders<WriteResult | DryRunResult>({
        method: "PUT",
        path: `/api/contents/${pathSegment(id)}`,
        body: opts?.dryRun ? { id, ...input, dryRun: true } : { id, ...input },
        headers: opts?.ifMatch ? { "If-Match": opts.ifMatch } : undefined,
      });
      // The server sets no ETag on a dry run, so the header is read for real writes only.
      return withEtag(body, headers);
    }) as ContentsResource["update"],

    setStatus: async (id, status) =>
      transport.request<{ message?: string }>({
        method: "PUT",
        path: `/api/contents/${pathSegment(id)}/status`,
        body: { id, newStatus: status },
      }),

    transition: async (id, name, data) =>
      transport.request<{ message?: string }>({
        method: "PUT",
        path: `/api/contents/${pathSegment(id)}/status`,
        body: data === undefined ? { id, transition: name } : { id, transition: name, data },
      }),

    schedule: async (id, at) =>
      transport.request<unknown>({
        method: "PUT",
        path: `/api/contents/${pathSegment(id)}/schedule`,
        body: {
          id,
          scheduledPublishAt: at.publishAt,
          scheduledUnpublishAt: at.unpublishAt,
          ...(at.version === undefined ? {} : { version: at.version }),
        },
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
