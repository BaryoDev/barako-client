import type { Transport } from "../transport";
import { BarakoError } from "../errors";
import type { MenuItem, Paged, PublicContent, PublicMenu } from "../types";

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
  /**
   * A navigation menu by slug (e.g. "main", "footer"), or null if there is none. A menu is just a
   * `menu` content type read through public delivery, so it stays pluggable like any other content.
   */
  menu(slug: string): Promise<PublicMenu | null>;
  /** The public URL for a file id — use directly as an `<img>` src. */
  fileUrl(id: string): string;
}

/**
 * Normalize a stored menu `Items` value (arbitrary JSON from the `json` field) into typed MenuItems.
 * Accepts both PascalCase (as stored by the admin) and camelCase keys, and caps nesting at one level.
 */
function toMenuItems(raw: unknown, depth = 0): MenuItem[] {
  if (!Array.isArray(raw)) return [];
  const items: MenuItem[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const label = (e.label ?? e.Label) as unknown;
    const url = (e.url ?? e.Url) as unknown;
    if (typeof label !== "string" || label.trim() === "") continue;
    const item: MenuItem = {
      label: label.trim(),
      url: typeof url === "string" ? url : "",
      openInNewTab: Boolean(e.openInNewTab ?? e.OpenInNewTab),
    };
    if (depth === 0) {
      const children = toMenuItems(e.children ?? e.Children, depth + 1);
      if (children.length) item.children = children;
    }
    items.push(item);
  }
  return items;
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

    menu: async (slug) => {
      const content = await orNull(
        transport.request<PublicContent>({
          method: "GET",
          path: `/api/public/menu/${encodeURIComponent(slug)}`,
        }),
      );
      if (!content) return null;
      const d = content.data ?? {};
      return {
        slug: content.slug ?? slug,
        name: typeof d.Name === "string" ? d.Name : "",
        items: toMenuItems(d.Items),
      };
    },

    fileUrl: (id) => `${base}/api/public/files/${encodeURIComponent(id)}`,
  };
}
