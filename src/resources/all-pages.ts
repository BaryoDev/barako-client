import type { Paged } from "../types";

const PAGE_SIZE = 100;

/**
 * Reads every page of a list endpoint into one array.
 *
 * barakoCMS 4.x answers every collection with the `Paged` envelope and caps a page at 100. A bare
 * array, which some 3.x list endpoints returned, is taken as the whole list.
 */
export async function allPages<T>(
  fetchPage: (query: { page: number; pageSize: number }) => Promise<T[] | Paged<T>>,
): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; ; page++) {
    const res = await fetchPage({ page, pageSize: PAGE_SIZE });
    if (Array.isArray(res)) return res;
    const items = res?.items ?? [];
    out.push(...items);
    const more = typeof res.hasNextPage === "boolean" ? res.hasNextPage : items.length === PAGE_SIZE;
    if (!more || items.length === 0) return out;
  }
}
