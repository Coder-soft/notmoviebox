#!/usr/bin/env node
// notmoviebox — CLI.
//
//   notmoviebox            share on LAN + Tailscale (default)
//   notmoviebox share ...  same, with options
//   notmoviebox serve      local only (127.0.0.1)
//   notmoviebox --help
//
// Installed via `npm link` (or `npm run link`), which exposes `notmoviebox`
// and the short alias `nmb`.

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));

const HELP = `${pkg.name} ${pkg.version}

Usage:
  notmoviebox [share] [options]   start and share on LAN + Tailscale (default)
  notmoviebox serve [options]     start locally only (127.0.0.1)
  notmoviebox help                show this help
  notmoviebox version             print the version

Share options:
  --port <n>        app port (default 8787, auto-bumps if busy)
  --https-port <n>  Tailscale HTTPS port (default 443)
  --funnel          also expose publicly via tailscale funnel
  --no-tailscale    LAN only
  --keep-serve      leave tailscale serve running after exit

Serve options:
  --port <n>        app port (default 8787)

Examples:
  notmoviebox
  notmoviebox share --port 9000
  notmoviebox serve --port 8080
`;

const [cmd = "share", ...rest] = process.argv.slice(2);

if (cmd === "help" || cmd === "-h" || cmd === "--help") {
  process.stdout.write(HELP);
  process.exit(0);
}
if (cmd === "version" || cmd === "-v" || cmd === "--version") {
  console.log(pkg.version);
  process.exit(0);
}

let script;
let env = { ...process.env };
let args = rest;

if (cmd === "share") {
  script = path.join(ROOT, "scripts", "share.mjs");
} else if (cmd === "serve" || cmd === "start") {
  script = path.join(ROOT, "server", "index.mjs");
  env = { ...env, HOST: env.HOST || "127.0.0.1" };
  // The server reads PORT/HOST from the environment, not argv.
  const cleaned = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--port" || rest[i] === "-p") env.PORT = rest[++i];
    else if (rest[i] === "--host") env.HOST = rest[++i];
    else cleaned.push(rest[i]);
  }
  args = cleaned;
} else {
  // Unknown command — treat it as an option to `share` so `notmoviebox --port 9000` works.
  script = path.join(ROOT, "scripts", "share.mjs");
  args = [cmd, ...rest];
}

const child = spawn(process.execPath, [script, ...args], { stdio: "inherit", env });

let exiting = false;
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    if (exiting) return;
    exiting = true;
    try {
      child.kill(sig);
    } catch {
      /* ignore */
    }
  });
}

child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
child.on("error", (err) => {
  console.error(`${pkg.name}: ${err.message}`);
  process.exit(1);
});
