/** The API contract versions this client works with. The API keeps no minimum, so the range lives
 *  here. `admin` is `X-Api-Contract-Version`, `delivery` is `X-Delivery-Contract-Version` (the
 *  routes under `/api/public/`). */
export const SUPPORTED_CONTRACT = {
  admin: { min: 1, max: 16 },
  delivery: { min: 1, max: 10 },
} as const;

export type ContractSurface = "admin" | "delivery";

/** What `onContractMismatch` receives. */
export interface ContractMismatch {
  surface: ContractSurface;
  /** The number the API sent. */
  apiVersion: number;
  /** The range this client supports for that surface. */
  min: number;
  max: number;
}

/** A header value that is a whole number, or undefined. Anything else counts as missing. */
export function parseContractVersion(value: string | null | undefined): number | undefined {
  if (typeof value !== "string") return undefined;
  const v = value.trim();
  if (!/^\d+$/.test(v)) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** The API's number for a surface. An API from before the delivery split sends only the admin
 *  header, and then the admin number is the delivery number. */
export function readContractVersion(headers: Headers, surface: ContractSurface): number | undefined {
  const admin = parseContractVersion(headers.get("X-Api-Contract-Version"));
  if (surface === "admin") return admin;
  return parseContractVersion(headers.get("X-Delivery-Contract-Version")) ?? admin;
}

export function surfaceOfPath(path: string): ContractSurface {
  return path.startsWith("/api/public/") ? "delivery" : "admin";
}

export function isInRange(surface: ContractSurface, version: number): boolean {
  const { min, max } = SUPPORTED_CONTRACT[surface];
  return version >= min && version <= max;
}

/** Checks each response against the range. A mismatch is reported once per surface for the life of
 *  the monitor, through `onMismatch` or, when none is given, `console.warn`. It never throws. */
export function createContractMonitor(onMismatch?: (info: ContractMismatch) => void) {
  const reported = new Set<ContractSurface>();
  return (path: string, headers: Headers): void => {
    try {
      const surface = surfaceOfPath(path);
      if (reported.has(surface)) return;
      const apiVersion = readContractVersion(headers, surface);
      if (apiVersion === undefined || isInRange(surface, apiVersion)) return;
      reported.add(surface);
      const { min, max } = SUPPORTED_CONTRACT[surface];
      const info: ContractMismatch = { surface, apiVersion, min, max };
      if (onMismatch) onMismatch(info);
      else {
        console.warn(
          `barako-client: the API is on ${surface} contract ${apiVersion}, this client supports ${min} to ${max}. Update the client.`,
        );
      }
    } catch {
      // a failing callback must not change the request result
    }
  };
}
