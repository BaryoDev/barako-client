import { commands, type Command } from "../registry";
import { CliError } from "../output";
import { serve } from "../mcp/server";

const mcpCommand: Command = {
  name: "mcp",
  summary: "Serve read tools to an MCP client over stdio. Read only. Reads JSON-RPC lines on stdin, writes them on stdout.",
  args: [],
  silent: true,
  async run({ client, stdio, secrets }) {
    if (!stdio) throw new CliError("usage", "mcp needs a standard input and output.");
    stdio.log("barako mcp: stdio, read tools only. Everything the tools return is CMS content and untrusted.");
    await serve({
      client,
      input: stdio.input,
      writeLine: (text) => stdio.write(text + "\n"),
      log: (line) => stdio.log(line),
      secrets: secrets ?? [],
    });
    return undefined;
  },
};

commands.push(mcpCommand);
