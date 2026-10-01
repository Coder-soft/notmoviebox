// notmoviebox — browser bridge.
//
// Playback needs an authenticated MovieBox session. Rather than asking you to
// paste credentials, this drives a real Chrome (via the Chrome DevTools
// Protocol) against themoviebox.xyz using a persistent profile you log into
// once. API calls that need the session (play, captions) are executed inside
// that page, so they run with the exact cookies/token the real site uses.
//
// It does not forge tokens or bypass anything: it is your own account, in your
// own browser, just automated.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PROFILE_DIR = path.join(os.homedir(), ".notmoviebox", "chrome-profile");
const SITE = "https://themoviebox.xyz/";

function walk(dir, depth, out) {
  if (depth < 0) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, depth - 1, out);
    else if (/^(Google Chrome|Chromium|chrome)( for Testing)?$/i.test(e.name) && /MacOS$/.test(dir)) out.push(full);
  }
}

function findChrome() {
  const out = [];
  if (process.env.NMB_CHROME) out.push(process.env.NMB_CHROME);
  walk(path.join(os.homedir(), "wcli", "browsers"), 6, out);
  walk(path.join(os.homedir(), ".cache", "wcli", "browsers"), 6, out);
  out.push(
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"
  );
  return out.find((p) => {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Cdp {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.id = 0;
    this.pending = new Map();
  }
  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = () => reject(new Error("CDP socket error"));
    });
    this.ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
    };
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.ws.send(JSON.stringify(payload));
      } catch (err) {
        this.pending.delete(id);
        reject(err);
      }
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(method + " timed out"));
        }
      }, 30000);
    });
  }
  close() {
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
  }
}

export class Bridge {
  constructor() {
    this.proc = null;
    this.port = 9333;
    this.cdp = null;
    this.targetId = null;
    this.sessionId = null;
    this.chrome = null;
  }

  get running() {
    return !!this.proc && !this.proc.killed;
  }

  status() {
    return {
      running: this.running,
      available: true,
      chrome: this.chrome || findChrome() || null,
      site: SITE,
      profile: PROFILE_DIR,
    };
  }

  async start() {
    if (this.running) return this.status();
    const chrome = findChrome();
    if (!chrome) {
      const err = new Error("No Chrome/Chromium found. Set NMB_CHROME=/path/to/chrome");
      err.code = "no_chrome";
      throw err;
    }
    this.chrome = chrome;
    fs.mkdirSync(PROFILE_DIR, { recursive: true });
    this.proc = spawn(
      chrome,
      [
        `--remote-debugging-port=${this.port}`,
        `--user-data-dir=${PROFILE_DIR}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-features=Translate",
        SITE,
      ],
      { stdio: "ignore", detached: true }
    );
    this.proc.unref();
    this.proc.on("exit", () => {
      this.proc = null;
      this.cdp?.close();
      this.cdp = null;
      this.sessionId = null;
      this.targetId = null;
    });

    // wait for the debug endpoint
    let version = null;
    for (let i = 0; i < 60; i++) {
      try {
        const r = await fetch(`http://127.0.0.1:${this.port}/json/version`);
        version = await r.json();
        break;
      } catch {
        await sleep(250);
      }
    }
    if (!version) throw new Error("Chrome did not expose a debugging port");
    this.cdp = new Cdp(version.webSocketDebuggerUrl);
    await this.cdp.connect();
    await this.ensureTarget();
    return this.status();
  }

  async ensureTarget() {
    if (!this.cdp) throw new Error("bridge not started");
    const { targetInfos } = await this.cdp.send("Target.getTargets");
    let page = targetInfos.find((t) => t.type === "page" && t.url.includes("themoviebox.xyz"));
    if (!page) {
      const created = await this.cdp.send("Target.createTarget", { url: SITE });
      page = { targetId: created.targetId };
    }
    if (page.targetId !== this.targetId || !this.sessionId) {
      const { sessionId } = await this.cdp.send("Target.attachToTarget", {
        targetId: page.targetId,
        flatten: true,
      });
      this.targetId = page.targetId;
      this.sessionId = sessionId;
    }
    return this.sessionId;
  }

  async evaluate(expression) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await this.ensureTarget();
        const res = await this.cdp.send(
          "Runtime.evaluate",
          { expression, awaitPromise: true, returnByValue: true },
          this.sessionId
        );
        if (res.exceptionDetails) {
          throw new Error(res.exceptionDetails.exception?.description || "page evaluation failed");
        }
        return res.result?.value;
      } catch (err) {
        // a navigation may have dropped the session — re-attach once
        this.sessionId = null;
        this.targetId = null;
        if (attempt === 1) throw err;
        await sleep(500);
      }
    }
  }

  /** Run a BFF API call inside the logged-in page and return parsed JSON. */
  async call(apiPath, { method = "GET", body, referrer } = {}) {
    if (!this.running) throw new Error("bridge not running");
    const p = JSON.stringify("/wefeed-h5api-bff" + apiPath);
    const m = JSON.stringify(method.toUpperCase());
    const b = body === undefined ? "null" : JSON.stringify(JSON.stringify(body));
    const ref = referrer ? JSON.stringify(referrer) : "location.href";
    const expr = `(async () => {
      try {
        const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
        let tok = "";
        try {
          const pr = await fetch("/wefeed-h5api-bff/user/profile", { headers: { Accept: "application/json" }, credentials: "include" });
          const xu = pr.headers.get("x-user");
          if (xu) tok = (JSON.parse(xu).token) || "";
        } catch (e) {}
        const headers = { Accept: "application/json", "X-Client-Info": JSON.stringify({ timezone: tz }) };
        if (tok) headers.Authorization = "Bearer " + tok;
        const init = { method: ${m}, headers, credentials: "include", referrer: ${ref}, referrerPolicy: "unsafe-url" };
        if (${b} !== null) { headers["content-type"] = "application/json"; init.body = ${b}; }
        const r = await fetch(${p}, init);
        return await r.text();
      } catch (e) {
        return JSON.stringify({ code: -1, message: "bridge: " + String(e) });
      }
    })()`;
    const text = await this.evaluate(expr);
    try {
      return JSON.parse(text);
    } catch {
      return { code: -1, message: "bridge: bad response" };
    }
  }

  /** Report whether the profile is signed in. */
  async session() {
    if (!this.running) return { running: false, loggedIn: false };
    try {
      const prof = await this.call("/user/profile");
      const data = prof?.data || null;
      const nickname = data?.nickname || data?.name || data?.userName || "";
      return { running: true, loggedIn: !!data, nickname, userType: data?.userType ?? null };
    } catch (err) {
      return { running: true, loggedIn: false, error: String(err) };
    }
  }

  stop() {
    const proc = this.proc;
    if (proc) {
      const kill = (sig) => {
        try {
          process.kill(-proc.pid, sig); // whole process group
        } catch {
          try {
            proc.kill(sig);
          } catch {
            /* ignore */
          }
        }
      };
      kill("SIGTERM");
      setTimeout(() => kill("SIGKILL"), 1500).unref?.();
      this.proc = null;
    }
    this.cdp?.close();
    this.cdp = null;
    this.sessionId = null;
    this.targetId = null;
    return { running: false };
  }
}

export const bridge = new Bridge();
