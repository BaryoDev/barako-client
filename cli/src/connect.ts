import { createClient, type BarakoClient, type ResourceDefinition } from "@baryodev/barako-client";
import { CliError } from "./output";

export interface Env {
  BARAKO_URL?: string;
  BARAKO_API_KEY?: string;
  BARAKO_RESOURCES?: string;
  /** `1` or `true` allows the key over plain http to a host that is not loopback. */
  BARAKO_ALLOW_HTTP?: string;
}

/** The tenant is not configured here: the server derives it from the API key. */
export function connect(
  env: Env,
  flags: { url?: string; keyFile?: string; allowHttp?: boolean },
  readFile: (p: string) => string,
  resources?: ResourceDefinition[],
): { client: BarakoClient; secret: string } {
  const baseUrl = (flags.url ?? env.BARAKO_URL)?.trim();
  if (!baseUrl) {
    throw new CliError("usage", "No API URL. Set BARAKO_URL or pass --url.");
  }
  let key: string | undefined;
  if (flags.keyFile !== undefined) {
    if (flags.keyFile.trim() === "") {
      throw new CliError("usage", "--key-file needs a path.");
    }
    try {
      key = readFile(flags.keyFile).replace(/[\r\n]+$/, "").trim();
    } catch {
      throw new CliError("usage", `Cannot read the key file ${flags.keyFile}.`);
    }
  } else {
    key = env.BARAKO_API_KEY?.trim();
  }
  if (!key) {
    throw new CliError("usage", "No API key. Set BARAKO_API_KEY or pass --key-file.");
  }
  const allowInsecureHttp = flags.allowHttp === true || ["1", "true"].includes(env.BARAKO_ALLOW_HTTP?.trim().toLowerCase() ?? "");
  if (!allowInsecureHttp && sendsKeyInClear(baseUrl)) {
    throw new CliError(
      "usage",
      "Refusing to send the API key over plain http to a host that is not loopback. Use https, or pass --allow-http (or set BARAKO_ALLOW_HTTP=1) if the network is trusted.",
    );
  }
  return { client: createClient({ baseUrl, apiKey: key, allowInsecureHttp, ...(resources ? { resources } : {}) }), secret: key };
}

/** True for an http URL whose host is not localhost, 127.x.x.x or [::1]. */
function sendsKeyInClear(baseUrl: string): boolean {
  try {
    const u = new URL(baseUrl);
    return u.protocol === "http:" && !(u.hostname === "localhost" || u.hostname === "[::1]" || /^127(\.\d{1,3}){3}$/.test(u.hostname));
  } catch {
    return false;
  }
}
