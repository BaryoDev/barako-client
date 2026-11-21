import { checkResourceDefinitions, type ResourceDefinition } from "@baryodev/barako-client";
import { CliError } from "./output";

export const MAX_RESOURCES_FILE_BYTES = 256 * 1024;
export const MAX_RESOURCES_FILE_ENTRIES = 200;

/** Reads extra resource definitions from a JSON file shaped `{ "resources": [ ... ] }`. A bad file is a
 *  usage error that names what failed, and it never echoes the file's text. */
export function loadResourcesFile(path: string, readFile: (p: string) => string): ResourceDefinition[] {
  let text: string;
  try {
    text = readFile(path);
  } catch {
    throw new CliError("usage", "The resources file could not be read.");
  }
  if (Buffer.byteLength(text, "utf8") > MAX_RESOURCES_FILE_BYTES) {
    throw new CliError("usage", `The resources file is over ${MAX_RESOURCES_FILE_BYTES / 1024} KB.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new CliError("usage", "The resources file is not valid JSON.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new CliError("usage", `The resources file must hold { "resources": [ ... ] }.`);
  }
  const keys = Object.keys(parsed);
  if (keys.length !== 1 || keys[0] !== "resources") {
    throw new CliError("usage", `The resources file must hold only the key "resources".`);
  }
  const list = (parsed as { resources: unknown }).resources;
  if (!Array.isArray(list)) {
    throw new CliError("usage", `In the resources file, "resources" must be an array.`);
  }
  if (list.length > MAX_RESOURCES_FILE_ENTRIES) {
    throw new CliError("usage", `The resources file has more than ${MAX_RESOURCES_FILE_ENTRIES} entries.`);
  }
  try {
    return checkResourceDefinitions(list);
  } catch (err) {
    throw new CliError("usage", `The resources file is refused. ${(err as Error).message}`);
  }
}
