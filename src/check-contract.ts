import { BarakoError } from "./errors";
import {
  SUPPORTED_CONTRACT,
  isInRange,
  readContractVersion,
  type ContractSurface,
} from "./contract";
import { fetchText } from "./http";

export interface CheckContractDeps {
  fetch: typeof fetch;
  stdout(line: string): void;
  stderr(line: string): void;
  /** Timeout for the one request. Default 15000. */
  timeoutMs?: number;
}

const USAGE = "usage: barako-client check-contract <api url> [--surface admin|delivery|both]";

/** Only printable ASCII and a short length, so nothing from the network can shape the output. */
function plain(text: string): string {
  return text.replace(/[^\x20-\x7e]/g, "?").slice(0, 200);
}

/**
 * `barako-client check-contract <api url> [--surface admin|delivery|both]`.
 *
 * One GET to `<url>/api/meta`, no auth, headers read whatever the status. Returns the exit code:
 * 0 in range, 1 outside or the header it needs is missing, 2 the API cannot be reached (or the
 * arguments are wrong).
 */
export async function checkContract(argv: string[], deps: CheckContractDeps): Promise<number> {
  let url: string | undefined;
  let surface = "both";
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--surface") {
      surface = argv[++i] ?? "";
    } else if (arg.startsWith("--surface=")) {
      surface = arg.slice("--surface=".length);
    } else if (!arg.startsWith("-") && url === undefined) {
      url = arg;
    } else {
      deps.stderr(USAGE);
      return 2;
    }
  }
  if (!url || !/^https?:\/\//i.test(url) || !["admin", "delivery", "both"].includes(surface)) {
    deps.stderr(USAGE);
    return 2;
  }

  let res;
  try {
    res = await fetchText(
      deps.fetch,
      `${url.replace(/\/+$/, "")}/api/meta`,
      { method: "GET", headers: {} },
      { signals: [], timeoutMs: deps.timeoutMs ?? 15_000 },
    );
  } catch (e) {
    const reason = e instanceof BarakoError ? e.message : "request failed";
    deps.stderr(`check-contract: cannot reach the API. ${plain(reason)}`);
    return 2;
  }

  const surfaces: ContractSurface[] = surface === "both" ? ["admin", "delivery"] : [surface as ContractSurface];
  let missing = false;
  let outside = false;
  const parts = surfaces.map((s) => {
    const { min, max } = SUPPORTED_CONTRACT[s];
    const version = readContractVersion(res.headers, s);
    if (version === undefined) {
      missing = true;
      return `${s} missing (supported ${min} to ${max})`;
    }
    if (!isInRange(s, version)) outside = true;
    return `${s} ${version} (supported ${min} to ${max})`;
  });

  const verdict = missing ? "missing header" : outside ? "outside range" : "in range";
  deps.stdout(`check-contract: ${verdict}. ${parts.join(", ")}`);
  return missing || outside ? 1 : 0;
}
