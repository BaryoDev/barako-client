/** Encode one caller-supplied URL path segment. Refuses "", "." and "..", which
 *  encodeURIComponent leaves unchanged and URL resolution would collapse. */
export function pathSegment(value: string): string {
  if (value === "" || value === "." || value === "..") {
    throw new TypeError(`Invalid path segment: ${JSON.stringify(value)}`);
  }
  return encodeURIComponent(value);
}

/** Remove every trailing "/" from a string. Runs in linear time on any input. */
export function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) end--;
  return end === value.length ? value : value.slice(0, end);
}
