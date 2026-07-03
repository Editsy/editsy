/** editsy CLI entry; the five commands are described in USAGE below. */
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { formatCheckResult, runCheck } from "./check.js";
import { startServer } from "./server.js";

const USAGE = `editsy: the little CMS that lives in your repo

Usage:
  editsy init [--root <dir>]
      scaffold a project: config, the /editsy route, next.config,
      .env.example. Create-only; never touches existing files.
  editsy edit [--port <n>] [--root <dir>] [--no-open]
      open the local content editor (default port 4499)
  editsy check [--root <dir>]
      validate content files (CI-friendly)
  editsy doctor [--root <dir>]
      check the whole setup: content, auth config, the GitHub token
      (a live test), and the Next.js integration
  editsy hash-password [<password>]
      print an editor entry snippet with a scrypt password hash
      (safe for EDITSY_EDITORS or a committed editsy.editors.json).
      With no argument, prompts without echo, which keeps the password
      out of your shell history. Piped stdin works too.
`;

async function main(): Promise<void> {
  // Tolerate a literal "--" (pnpm/npm forward it verbatim from `run script -- args`).
  const argv = process.argv.slice(2).filter((a) => a !== "--");
  const [command, ...rest] = argv;
  // Package managers run scripts with cwd = the package dir; INIT_CWD is
  // where the user actually invoked from, so relative --root works as typed.
  const invokeDir = process.env.INIT_CWD ?? process.cwd();
  const rootFlag = rest.indexOf("--root");
  const root = rootFlag >= 0 ? resolve(invokeDir, rest[rootFlag + 1]!) : invokeDir;

  if (command === "hash-password") {
    let password = rest.find((a) => !a.startsWith("--"));
    if (!password) {
      // Prefer prompting over an argument: arguments land in shell history.
      password = process.stdin.isTTY ? await promptHidden("Password: ") : (await readAllStdin()).trim();
    }
    if (!password) {
      console.error("usage: editsy hash-password  (prompts)  or  editsy hash-password <password>");
      process.exitCode = 1;
      return;
    }
    const { hashPassword } = await import("./auth.js");
    const entry = { name: "Editor Name", email: "editor@example.com", passwordHash: hashPassword(password) };
    console.log(
      "Paste this as the value of EDITSY_EDITORS (or inside editsy.editors.json).\n" +
        "EDITSY_EDITORS is a JSON ARRAY; keep the [ ] even for one editor, and add\n" +
        "a { ...}, entry per additional editor:\n",
    );
    console.log(JSON.stringify([entry], null, 2));
    return;
  }

  if (command === "init") {
    const { runInit } = await import("./init.js");
    const { randomBytes } = await import("node:crypto");
    const result = await runInit(root);
    for (const f of result.created) console.log(`created  ${f}`);
    for (const f of result.skipped) console.log(`kept     ${f} (already there; init never overwrites)`);
    for (const note of result.notes) console.log(`\n→ ${note}`);
    console.log(
      `\nA fresh EDITSY_SECRET, generated for you (put it in your host's env):\n  ${randomBytes(32).toString("base64url")}`,
    );
    console.log(
      "\nNext steps:\n" +
        "  1. npx editsy hash-password   (make your first editor entry)\n" +
        "  2. set the env vars from .env.example in your host\n" +
        "  3. npx editsy doctor          (verify the whole setup)\n" +
        "Full walkthrough: https://editsy.dev/docs/remote",
    );
    return;
  }

  if (command === "doctor") {
    const { runDoctor, formatDoctorResult } = await import("./doctor.js");
    const checks = await runDoctor({ root });
    console.log(formatDoctorResult(checks));
    process.exitCode = checks.some((c) => c.status === "fail") ? 1 : 0;
    return;
  }

  if (command === "check") {
    const result = await runCheck(root);
    console.log(formatCheckResult(result));
    process.exitCode = result.problems.length > 0 ? 1 : 0;
    return;
  }

  if (command === "edit") {
    const portFlag = rest.indexOf("--port");
    const port = portFlag >= 0 ? Number(rest[portFlag + 1]) : 4499;
    if (!Number.isInteger(port) || port <= 0) {
      console.error("--port must be a positive integer");
      process.exitCode = 1;
      return;
    }
    await startServer({ root, port });
    const url = `http://localhost:${port}`;
    console.log(`editsy editing ${root}`);
    console.log(`  → ${url}`);
    if (!rest.includes("--no-open")) openBrowser(url);
    return;
  }

  console.log(USAGE);
  process.exitCode = command ? 1 : 0;
}

/** Read a line from the terminal without echoing it (for passwords). */
async function promptHidden(question: string): Promise<string> {
  const { createInterface } = await import("node:readline");
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    // readline echoes what you type via _writeToOutput; silence it after
    // printing the question. Internal API, but the standard no-dependency
    // way to take a hidden password.
    process.stdout.write(question);
    const internals = rl as unknown as { _writeToOutput: (s: string) => void };
    internals._writeToOutput = () => {};
    rl.question("", (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer);
    });
  });
}

/** Read piped stdin to the end (for `echo pw | editsy hash-password`). */
async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/** Best-effort: pop the editor open in the default browser. */
function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === "win32"
      ? ["cmd", ["/c", "start", "", url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  try {
    spawn(cmd, args as string[], { stdio: "ignore", detached: true }).unref();
  } catch {
    // Opening the browser is a nicety; the printed URL is the contract.
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
