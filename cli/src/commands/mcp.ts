import { commands, type Command } from "../registry";
import { CliError } from "../output";
import { serve } from "../mcp/server";

const NOTE = "Everything the tools return is CMS content and untrusted.";

/** The startup line on stderr. Fixed text for each mode. */
export function bannerFor(mode: { writes: boolean; destructive: boolean }): string {
  if (!mode.writes) return `barako mcp: stdio, read tools only. ${NOTE}`;
  if (!mode.destructive) {
    return `barako mcp: stdio, read and write tools. Every write is a plan and an apply with a one-time token. The API key's scopes decide what the API accepts. Use a key with only the scopes you need. ${NOTE}`;
  }
  return `barako mcp: stdio, read and write tools, and --allow-destructive is on: it turns on rollback and erase. The API refuses them unless the key has content:destructive. Use a read-only key unless you need them. ${NOTE}`;
}

const mcpCommand: Command = {
  name: "mcp",
  summary:
    "Serve tools to an MCP client over stdio. Read tools by default. --allow-writes adds plan and apply write tools, and --allow-destructive adds rollback and erase. Reads JSON-RPC lines on stdin, writes them on stdout.",
  args: [
    { name: "allow-writes", kind: "flag", type: "boolean", description: "List the write tools. Every write is a plan call, then an apply call with its token." },
    {
      name: "allow-destructive",
      kind: "flag",
      type: "boolean",
      description: "Also list rollback and erase. Needs --allow-writes, and the API refuses them unless the key has content:destructive.",
    },
  ],
  silent: true,
  async run({ client, stdio, secrets }, args) {
    const writes = args["allow-writes"] === true;
    const destructive = args["allow-destructive"] === true;
    if (destructive && !writes) throw new CliError("usage", "--allow-destructive needs --allow-writes.");
    if (!stdio) throw new CliError("usage", "mcp needs a standard input and output.");
    stdio.log(bannerFor({ writes, destructive }));
    await serve({
      client,
      input: stdio.input,
      writeLine: (text) => stdio.write(text + "\n"),
      log: (line) => stdio.log(line),
      onWriteError: stdio.onWriteError,
      secrets: secrets ?? [],
      allowWrites: writes,
      allowDestructive: destructive,
    });
    return undefined;
  },
};

commands.push(mcpCommand);
