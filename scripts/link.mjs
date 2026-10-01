#!/usr/bin/env node
// notmoviebox — link the CLI onto your PATH.
//
//   npm run link          # or: node scripts/link.mjs
//   npm run unlink        # or: node scripts/link.mjs --unlink
//
// Tries `npm link` first. If the global npm prefix isn't writable (common on
// Homebrew/system Node — /usr/local/lib/node_modules is root-owned), it falls
// back to symlinking the bin into the first writable directory already on your
// PATH, which needs no sudo.

import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));

const c = { reset: "\x1b[0m", dim: "\x1b[2m", green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m" };

const bins = Object.entries(pkg.bin || {});
if (!bins.length) {
  console.error(`${c.red}package.json has no "bin" entries.${c.reset}`);
  process.exit(1);
}

const unlink = process.argv.includes("--unlink") || process.argv.includes("-u");

const isWritableDir = (dir) => {
  try {
    if (!existsSync(dir) || !lstatSync(dir).isDirectory()) return false;
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
};

const npmPrefixWritable = () => {
  const r = spawnSync("npm", ["prefix", "-g"], { encoding: "utf8" });
  if (r.status !== 0) return false;
  // npm link writes a symlink into <prefix>/lib/node_modules specifically.
  return isWritableDir(path.join(r.stdout.trim(), "lib", "node_modules"));
};

/** First writable directory on PATH that isn't inside this project. */
function pathDir() {
  const home = os.homedir();
  const preferred = [path.join(home, ".local", "bin"), "/usr/local/bin", "/opt/homebrew/bin"];
  const entries = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  for (const dir of [...preferred, ...entries]) {
    if (dir.startsWith(ROOT)) continue;
    if (isWritableDir(dir)) return dir;
  }
  return null;
}

/* ── unlink ───────────────────────────────────────────────────────────────── */

if (unlink) {
  let removed = 0;
  // npm link first (quietly — it errors noisily when the prefix isn't writable)
  const r = spawnSync("npm", ["unlink", "-g", pkg.name], { stdio: "ignore" });
  if (r.status === 0) removed++;

  const dir = pathDir();
  if (dir) {
    for (const [name] of bins) {
      const link = path.join(dir, name);
      try {
        if (lstatSync(link).isSymbolicLink()) {
          rmSync(link);
          console.log(`${c.green}removed${c.reset} ${link}`);
          removed++;
        }
      } catch {
        /* not there */
      }
    }
  }
  if (!removed) console.log(`${c.dim}nothing to remove.${c.reset}`);
  process.exit(0);
}

/* ── link ─────────────────────────────────────────────────────────────────── */

if (npmPrefixWritable()) {
  console.log(`${c.dim}global npm prefix is writable — using npm link${c.reset}`);
  const r = spawnSync("npm", ["link"], { stdio: "ignore" });
  if (r.status === 0) {
    console.log(`${c.green}linked${c.reset} ${bins.map(([n]) => n).join(", ")} ${c.dim}(npm link)${c.reset}`);
    process.exit(0);
  }
  console.log(`${c.yellow}npm link failed — falling back to a PATH symlink.${c.reset}`);
}

const dir = pathDir();
if (!dir) {
  console.error(`${c.red}No writable directory on PATH.${c.reset}`);
  console.error(`Add one to PATH (e.g. mkdir -p ~/.local/bin && export PATH="$HOME/.local/bin:$PATH"), then re-run.`);
  process.exit(1);
}

for (const [name, rel] of bins) {
  const target = path.join(ROOT, rel);
  const link = path.join(dir, name);
  try {
    rmSync(link, { force: true });
    symlinkSync(target, link);
    console.log(`${c.green}linked${c.reset} ${link} ${c.dim}-> ${target}${c.reset}`);
  } catch (err) {
    console.error(`${c.red}failed${c.reset} ${link}: ${err.message}`);
    process.exit(1);
  }
}

const onPath = (process.env.PATH || "").split(path.delimiter).includes(dir);
console.log(
  `\n${c.dim}Run${c.reset} ${bins.map(([n]) => n).join(" or ")} ${c.dim}from anywhere.` +
    (onPath ? "" : ` ${c.yellow}(${dir} is not on PATH)${c.reset}`) +
    `\n${c.dim}Remove with: npm run unlink${c.reset}`
);
