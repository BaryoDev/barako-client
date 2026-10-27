/** Encode one caller-supplied URL path segment. Refuses "", "." and "..", which
 *  encodeURIComponent leaves unchanged and URL resolution would collapse. */
export function pathSegment(value: string): string {
  if (value === "" || value === "." || value === "..") {
    throw new TypeError(`Invalid path segment: ${JSON.stringify(value)}`);
  }
  return encodeURIComponent(value);
}
