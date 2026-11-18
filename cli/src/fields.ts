import { CliError } from "./output";

type Read = (p: string) => string;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function put(out: Record<string, unknown>, name: string, value: unknown): void {
  // defineProperty keeps a name like "__proto__" as plain data.
  Object.defineProperty(out, name, { value, enumerable: true, writable: true, configurable: true });
}

function split(arg: string, flag: string): [string, string] {
  const i = arg.indexOf("=");
  if (i < 0) throw new CliError("usage", `${flag} needs Name=value`);
  const name = arg.slice(0, i);
  if (name === "") throw new CliError("usage", `${flag} needs a field name before "="`);
  return [name, arg.slice(i + 1)];
}

/** Turn --set and --set-file arguments into one field map. `Name:=json` parses the value as JSON. */
export function parseSets(sets: string[], setFiles: string[], readFile: Read): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const seen = new Set<string>();
  const claim = (name: string) => {
    if (seen.has(name)) throw new CliError("usage", `field "${name}" is set more than once`);
    seen.add(name);
  };

  for (const arg of sets) {
    const [rawName, raw] = split(arg, "--set");
    if (rawName.endsWith(":")) {
      const name = rawName.slice(0, -1);
      if (name === "") throw new CliError("usage", `--set needs a field name before ":="`);
      claim(name);
      let value: unknown;
      try {
        value = JSON.parse(raw);
      } catch {
        throw new CliError("usage", `--set ${name}:= needs valid JSON`);
      }
      put(out, name, value);
    } else {
      claim(rawName);
      put(out, rawName, raw);
    }
  }

  for (const arg of setFiles) {
    const [name, path] = split(arg, "--set-file");
    claim(name);
    let text: string;
    try {
      text = readFile(path);
    } catch {
      throw new CliError("usage", `--set-file ${name} could not read its file`);
    }
    put(out, name, text);
  }

  return out;
}

/** Read a --file JSON document. It must be an object. */
export function readDataFile(path: string, readFile: Read): Record<string, unknown> {
  let text: string;
  try {
    text = readFile(path);
  } catch {
    throw new CliError("usage", "--file could not be read");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new CliError("usage", "--file is not valid JSON");
  }
  if (!isObject(parsed)) throw new CliError("usage", "--file must hold a JSON object");
  return parsed;
}

/** Top-level replace: each key in the patch replaces the same key in current. */
export function mergeData(
  current: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(current)) put(out, k, v);
  for (const [k, v] of Object.entries(patch)) put(out, k, v);
  return out;
}
