#!/usr/bin/env node
// notmoviebox — share the app on your LAN and/or Tailscale.
//
//   ./scripts/share.mjs                 # LAN + Tailscale (if available)
//   ./scripts/share.mjs --port 9000
//   ./scripts/share.mjs --funnel        # also expose on the public internet
//   ./scripts/share.mjs --no-tailscale  # LAN only
//   ./scripts/share.mjs --keep-serve    # don't reset tailscale serve on exit
//
// Starts the app server bound to 0.0.0.0 so other devices on the network can
// reach it, then (optionally) publishes it on your tailnet with
// `tailscale serve` — HTTPS on your *.ts.net name, tailnet-only by default.

import { spawn, spawnSync } from "node:child_process";
import { networkInterfaces } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const c = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
};

/* ── args ─────────────────────────────────────────────────────────────────── */

const opts = {
  port: Number(process.env.PORT || 8787),
  httpsPort: 443,
  tailscale: true,
  funnel: false,
  keepServe: false,
  help: false,
};

const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--port" || a === "-p") opts.port = Number(argv[++i]);
  else if (a === "--https-port") opts.httpsPort = Number(argv[++i]);
  else if (a === "--funnel") opts.funnel = true;
  else if (a === "--no-tailscale") opts.tailscale = false;
  else if (a === "--keep-serve") opts.keepServe = true;
  else if (a === "--help" || a === "-h") opts.help = true;
  else {
    console.error(`${c.red}unknown option:${c.reset} ${a}`);
    process.exit(2);
  }
}

if (opts.help) {
  console.log(`notmoviebox — share on LAN / Tailscale

  --port <n>        app port (default 8787, auto-bumps if busy)
  --https-port <n>  Tailscale HTTPS port (default 443)
  --funnel          also expose publicly via tailscale funnel (needs Funnel enabled)
  --no-tailscale    LAN only
  --keep-serve      leave tailscale serve running after exit
`);
  process.exit(0);
}

/* ── helpers ──────────────────────────────────────────────────────────────── */

// Tailscale uses 100.64.0.0/10; excluded from the LAN list so it isn't shown twice.
const isCgnat = (ip) => {
  const [a, b] = ip.split(".").map(Number);
  return a === 100 && b >= 64 && b <= 127;
};

function lanAddresses() {
  const out = [];
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === "IPv4" && !a.internal && !isCgnat(a.address)) {
        out.push({ name, address: a.address });
      }
    }
  }
  return out;
}

function findTailscale() {
  const candidates = [
    "tailscale",
    "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
    "/usr/local/bin/tailscale",
    "/opt/homebrew/bin/tailscale",
    "/usr/bin/tailscale",
  ];
  for (const bin of candidates) {
    const r = spawnSync(bin, ["version"], { encoding: "utf8" });
    if (!r.error && r.status === 0) return bin;
  }
  return null;
}

function tailscaleStatus(ts) {
  const r = spawnSync(ts, ["status", "--json"], { encoding: "utf8", timeout: 15000 });
  if (r.status !== 0 || !r.stdout) return null;
  try {
    const j = JSON.parse(r.stdout);
    const dns = (j.Self?.DNSName || "").replace(/\.$/, "");
    return {
      running: j.BackendState === "Running",
      online: !!j.Self?.Online,
      dnsName: dns,
      ips: j.Self?.TailscaleIPs || [],
    };
  } catch {
    return null;
  }
}

/* ── start the app server on all interfaces ───────────────────────────────── */

const server = spawn(process.execPath, [path.join(ROOT, "server", "index.mjs")], {
  cwd: ROOT,
  env: { ...process.env, HOST: "0.0.0.0", PORT: String(opts.port) },
  stdio: ["ignore", "pipe", "pipe"],
});

let actualPort = opts.port;
let started = false;

server.stdout.on("data", (buf) => {
  const text = buf.toString();
  const matches = [...text.matchAll(/http:\/\/0\.0\.0\.0:(\d+)/g)];
  if (matches.length) actualPort = Number(matches[matches.length - 1][1]);
  if (!started && matches.length) {
    started = true;
    onStarted(actualPort);
  }
});

server.stderr.on("data", (buf) => process.stderr.write(buf));

server.on("exit", (code) => {
  if (!shuttingDown) {
    console.error(`\n${c.red}server exited${c.reset} (code ${code})`);
    process.exit(code ?? 1);
  }
});

/* ── tailscale serve ──────────────────────────────────────────────────────── */

let tsBin = null;
let served = false;

/** Fast: report the Tailscale IP (works on the tailnet without `serve`). */
function tailscaleInfo(port) {
  if (!opts.tailscale) return null;
  tsBin = findTailscale();
  if (!tsBin) {
    console.log(`${c.dim}tailnet   Tailscale not found — LAN only.${c.reset}`);
    return null;
  }
  const st = tailscaleStatus(tsBin);
  if (!st || !st.running) {
    console.log(`${c.yellow}tailnet   Tailscale installed but not running/logged in — LAN only.${c.reset}`);
    return null;
  }
  const ip4 = (st.ips || []).find((i) => i.includes("."));
  if (ip4) {
    console.log(`${c.green}tailnet${c.reset}   http://${ip4}:${port}/   ${c.dim}(Tailscale IP — works on your tailnet)${c.reset}`);
  }
  return st;
}

/** Optional upgrade: HTTPS on your *.ts.net name via `tailscale serve`. */
function tryServe(port, st) {
  if (!tsBin || !st) return;
  const verb = opts.funnel ? "funnel" : "serve";
  const args = [verb, "--bg", "--yes"];
  if (!opts.funnel) args.push(`--https=${opts.httpsPort}`);
  args.push(String(port));

  const r = spawnSync(tsBin, args, { encoding: "utf8", timeout: 12000 });
  const msg = ((r.stderr || "") + (r.stdout || "")).trim();

  if (r.error && r.error.code === "ETIMEDOUT") {
    console.log(`${c.dim}         tailscale ${verb} timed out — the IP URL above still works.${c.reset}`);
    return;
  }
  if (r.status !== 0) {
    const last = msg.split("\n").filter(Boolean).slice(-1)[0] || "unknown error";
    console.log(`${c.dim}         tailscale ${verb} unavailable: ${last}${c.reset}`);
    if (/GUI failed to start/i.test(msg)) {
      console.log(`${c.dim}         (macOS GUI build — use the IP URL above, or enable Serve in the app.)${c.reset}`);
    } else if (/cert|https/i.test(msg)) {
      console.log(`${c.dim}         (enable HTTPS certificates for this tailnet to get a ts.net URL.)${c.reset}`);
    }
    return;
  }
  served = true;

  const url = st.dnsName
    ? `https://${st.dnsName}${opts.funnel || opts.httpsPort === 443 ? "" : `:${opts.httpsPort}`}/`
    : null;
  if (url) console.log(`${c.green}tailnet${c.reset}   ${url}   ${c.dim}(${opts.funnel ? "public via Funnel" : "tailnet HTTPS"})${c.reset}`);
}

/* ── banner ───────────────────────────────────────────────────────────────── */

function onStarted(port) {
  const lan = lanAddresses();
  console.log(`\n${c.bold}notmoviebox${c.reset} ${c.dim}sharing${c.reset}\n`);
  console.log(`${c.green}local${c.reset}     http://127.0.0.1:${port}/`);
  if (lan.length) {
    for (const { name, address } of lan) {
      console.log(`${c.green}LAN${c.reset}       http://${address}:${port}/   ${c.dim}(${name})${c.reset}`);
    }
  } else {
    console.log(`${c.dim}LAN       no external interface found${c.reset}`);
  }

  const st = tailscaleInfo(port);

  console.log(`\n${c.dim}Ctrl+C to stop.${c.reset}\n`);

  // Optional and last, so a slow/blocked `tailscale serve` never delays the banner.
  tryServe(port, st);
}

/* ── shutdown ─────────────────────────────────────────────────────────────── */

let shuttingDown = false;

function shutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${c.dim}stopping…${c.reset}`);

  if (served && !opts.keepServe && tsBin) {
    const r = spawnSync(tsBin, ["serve", "reset"], { encoding: "utf8" });
    if (r.status === 0) console.log(`${c.dim}tailscale serve reset${c.reset}`);
    else console.log(`${c.dim}run 'tailscale serve reset' to remove the tailnet proxy${c.reset}`);
  }

  server.kill("SIGTERM");
  setTimeout(() => {
    try {
      server.kill("SIGKILL");
    } catch {
      /* ignore */
    }
    process.exit(0);
  }, 400).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
