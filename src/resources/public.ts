import type { Transport } from "../transport";
import { BarakoError } from "../errors";
import type { Paged, PublicContent, PublicMenu } from "../types";

export interface PublicListQuery {
  page?: number;
  pageSize?: number;
}

/**
 * The anonymous public delivery surface for a website frontend: published content by type or slug,
 * navigation menus, and public file URLs. No auth is needed; set `tenant` on the client to scope a
 * multi-tenant deployment to one site.
 */
export interface PublicResource {
  /** Published entries of a content type, newest first. */
  list(type: string, query?: PublicListQuery): Promise<Paged<PublicContent>>;
  /** A single published entry by its slug, or null if there is none. */
  bySlug(type: string, slug: string): Promise<PublicContent | null>;
  /** A navigation menu by slug (e.g. "main", "footer"), or null if there is none. */
  menu(slug: string): Promise<PublicMenu | null>;
  /** The public URL for a file id — use directly as an `<img>` src. */
  fileUrl(id: string): string;
}

export function publicResource(transport: Transport, baseUrl: string): PublicResource {
  const base = baseUrl.replace(/\/+$/, "");

  const orNull = async <T>(p: Promise<T>): Promise<T | null> => {
    try {
      return await p;
    } catch (e) {
      if (e instanceof BarakoError && e.status === 404) return null;
      throw e;
    }
  };

  return {
    list: (type, query) =>
      transport.request<Paged<PublicContent>>({
        method: "GET",
        path: `/api/public/${encodeURIComponent(type)}`,
        query: query && { page: query.page, pageSize: query.pageSize },
      }),

    bySlug: (type, slug) =>
      orNull(
        transport.request<PublicContent>({
          method: "GET",
          path: `/api/public/${encodeURIComponent(type)}/${encodeURIComponent(slug)}`,
        }),
      ),

    menu: (slug) =>
      orNull(
        transport.request<PublicMenu>({
          method: "GET",
          path: `/api/public/menus/${encodeURIComponent(slug)}`,
        }),
      ),

    fileUrl: (id) => `${base}/api/public/files/${encodeURIComponent(id)}`,
  };
}
