import { checkContract } from "./check-contract";

const [command, ...rest] = process.argv.slice(2);

if (command === "check-contract") {
  checkContract(rest, {
    fetch: globalThis.fetch,
    stdout: (line) => console.log(line),
    stderr: (line) => console.error(line),
  }).then((code) => {
    process.exitCode = code;
  });
} else {
  console.error("usage: barako-client check-contract <api url> [--surface admin|delivery|both] [--strict]");
  process.exitCode = 2;
}
