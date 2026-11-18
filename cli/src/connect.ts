import { createClient, type BarakoClient } from "@baryodev/barako-client";
import { CliError } from "./output";

export interface Env {
  BARAKO_URL?: string;
  BARAKO_API_KEY?: string;
}

/** The tenant is not configured here: the server derives it from the API key. */
export function connect(
  env: Env,
  flags: { url?: string; keyFile?: string },
  readFile: (p: string) => string,
): { client: BarakoClient; secret: string } {
  const baseUrl = (flags.url ?? env.BARAKO_URL)?.trim();
  if (!baseUrl) {
    throw new CliError("usage", "No API URL. Set BARAKO_URL or pass --url.");
  }
  let key: string | undefined;
  if (flags.keyFile) {
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
  return { client: createClient({ baseUrl, apiKey: key }), secret: key };
}
