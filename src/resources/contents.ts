import { pathSegment } from "../path";
import { callOpts, type CallOptions } from "../http";
import type { Transport } from "../transport";
import type {
  Content,
  ContentStatus,
  SensitivityLevel,
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
  sensitivity: SensitivityLevel;
}

export interface ContentsResource {
  list(query?: ListContentQuery, opts?: CallOptions): Promise<Paged<Content>>;
  /** `etag` is the ETag response header, when the server sends one. Send it back as `ifMatch`. */
  get(id: string, opts?: CallOptions): Promise<Content & { etag?: string }>;
  /** One entry by type and slug, with its `etag`. */
  bySlug(type: string, slug: string, opts?: CallOptions): Promise<Content & { etag?: string }>;
  /** Create an entry. `dryRun` checks it and returns the changes without storing anything. */
  create(input: CreateContentInput, opts: { dryRun: true; idempotencyKey?: string } & CallOptions): Promise<DryRunResult>;
  create(input: CreateContentInput, opts?: { dryRun?: false; idempotencyKey?: string } & CallOptions): Promise<WriteResult>;
  create(input: CreateContentInput, opts?: { dryRun?: boolean; idempotencyKey?: string } & CallOptions): Promise<WriteResult | DryRunResult>;
  /** Update an entry. Pass `version` for optimistic concurrency (rejected if it changed under you).
   *  `ifMatch` sends an ETag from get as If-Match. */
  update(
    id: string,
    input: UpdateContentInput & { version?: number },
    opts: { ifMatch?: string; dryRun: true } & CallOptions,
  ): Promise<DryRunResult>;
  update(
    id: string,
    input: UpdateContentInput & { version?: number },
    opts?: { ifMatch?: string; dryRun?: false } & CallOptions,
  ): Promise<WriteResult & { etag?: string }>;
  update(
    id: string,
    input: UpdateContentInput & { version?: number },
    opts?: { ifMatch?: string; dryRun?: boolean } & CallOptions,
  ): Promise<(WriteResult & { etag?: string }) | DryRunResult>;
  /** Run a named lifecycle transition on a content type that declares one. `data` carries the
   *  values for the fields that transition requires or allows. */
  transition(id: string, name: string, data?: Record<string, unknown>, opts?: CallOptions): Promise<{ message?: string }>;
  /** Set both times (ISO 8601, UTC). Every call replaces both, and null clears one, so state both.
   *  Event-sourced types need `version`. */
  schedule(
    id: string,
    at: { publishAt: string | null; unpublishAt: string | null; version?: number },
    opts?: CallOptions,
  ): Promise<unknown>;
  /** Restore an earlier version, by the version id from history. */
  rollback(id: string, versionId: string, opts?: CallOptions): Promise<RollbackResult>;
  /** Remove an entry and its history for good. Needs the erase capability. */
  erase(id: string, opts?: CallOptions): Promise<void>;
  /** Change only the lifecycle status (publish, archive, draft). */
  setStatus(id: string, status: ContentStatus, opts?: CallOptions): Promise<{ message?: string }>;
  history(id: string, opts?: CallOptions): Promise<ContentVersion[]>;
}

export function contentsResource(transport: Transport): ContentsResource {
  return {
    list: (query, opts) =>
      transport.request<Paged<Content>>({
        method: "GET",
        path: "/api/contents",
        query: query && {
          contentType: query.contentType,
          page: query.page,
          pageSize: query.pageSize,
          // The list endpoint binds the status name from the query string (core EntriesListTests uses status=Draft).
          status: query.status,
          search: query.search,
        },
        ...callOpts(opts),
      }),

    get: async (id, opts) => {
      const { body, headers } = await transport.requestWithHeaders<Content>({
        method: "GET",
        path: `/api/contents/${pathSegment(id)}`,
        ...callOpts(opts),
      });
      return withEtag(body, headers);
    },

    bySlug: async (type, slug, opts) => {
      const { body, headers } = await transport.requestWithHeaders<Content>({
        method: "GET",
        path: `/api/contents/by-slug/${pathSegment(type)}/${pathSegment(slug)}`,
        ...callOpts(opts),
      });
      return withEtag(body, headers);
    },

    create: ((input: CreateContentInput, opts?: { dryRun?: boolean; idempotencyKey?: string } & CallOptions) =>
      transport.request<WriteResult | DryRunResult>({
        method: "POST",
        path: "/api/contents",
        body: opts?.dryRun ? { ...input, dryRun: true } : input,
        headers: opts?.idempotencyKey ? { "Idempotency-Key": opts.idempotencyKey } : undefined,
        ...callOpts(opts),
      })) as ContentsResource["create"],

    update: (async (
      id: string,
      input: UpdateContentInput & { version?: number },
      opts?: { ifMatch?: string; dryRun?: boolean } & CallOptions,
    ) => {
      const { body, headers } = await transport.requestWithHeaders<WriteResult | DryRunResult>({
        method: "PUT",
        path: `/api/contents/${pathSegment(id)}`,
        body: opts?.dryRun ? { id, ...input, dryRun: true } : { id, ...input },
        headers: opts?.ifMatch ? { "If-Match": opts.ifMatch } : undefined,
        ...callOpts(opts),
      });
      // The server sets no ETag on a dry run, so the header is read for real writes only.
      return withEtag(body, headers);
    }) as ContentsResource["update"],

    setStatus: async (id, status, opts) =>
      transport.request<{ message?: string }>({
        method: "PUT",
        path: `/api/contents/${pathSegment(id)}/status`,
        body: { id, newStatus: status },
        ...callOpts(opts),
      }),

    transition: async (id, name, data, opts) =>
      transport.request<{ message?: string }>({
        method: "PUT",
        path: `/api/contents/${pathSegment(id)}/status`,
        body: data === undefined ? { id, transition: name } : { id, transition: name, data },
        ...callOpts(opts),
      }),

    schedule: async (id, at, opts) =>
      transport.request<unknown>({
        method: "PUT",
        path: `/api/contents/${pathSegment(id)}/schedule`,
        body: {
          id,
          scheduledPublishAt: at.publishAt,
          scheduledUnpublishAt: at.unpublishAt,
          ...(at.version === undefined ? {} : { version: at.version }),
        },
        ...callOpts(opts),
      }),

    rollback: async (id, versionId, opts) =>
      transport.request<RollbackResult>({
        method: "POST",
        path: `/api/contents/${pathSegment(id)}/rollback/${pathSegment(versionId)}`,
        ...callOpts(opts),
      }),

    erase: async (id, opts) => {
      await transport.request<void>({
        method: "DELETE",
        path: `/api/contents/${pathSegment(id)}/erase`,
        ...callOpts(opts),
      });
    },

    history: (id, opts) =>
      allPages((query) =>
        transport.request<Paged<ContentVersion>>({ method: "GET", path: `/api/contents/${pathSegment(id)}/history`, query, ...callOpts(opts) }),
      ),
  };
}

function withEtag<T extends object>(body: T, headers: Headers): T & { etag?: string } {
  const etag = headers.get("ETag") ?? undefined;
  return etag === undefined ? body : { ...body, etag };
}
