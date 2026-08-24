import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { buildLife } from "./export.mjs";
import { archiveLife } from "./archive.mjs";
import { loadSetup, saveSetup, DEFAULT_SETUP, PLACEHOLDERS } from "./setup.mjs";
import { rewind, points } from "./rewind.mjs";
import { buildMarkdown } from "./markdown.mjs";
import { nowPage, momentCards } from "./plain.mjs";
import { rm, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderPage } from "./panel-ui.mjs";
import { loadModel, saveModel, describeModel, detect } from "./model.mjs";
import { letters as allLetters, count as letterCount } from "./mail.mjs";
import { configFromEnv } from "./mind.mjs";
import { extensionSearch } from "./extension-search.mjs";
import { loadRun, saveRun, DEFAULT_RUN } from "./run.mjs";

const PRESENCE_TIMEOUT_MS = 20_000;
const EXTENSION_BUILD = "0.2.0";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export class Observer {
  constructor() {
    this.lastSeen = 0;
    this.since = null;
  }

  seen() {
    const wasPresent = this.present();
    this.lastSeen = Date.now();
    if (!wasPresent) this.since = new Date().toISOString();
  }

  present() {
    return Date.now() - this.lastSeen < PRESENCE_TIMEOUT_MS;
  }

  state() {
    return { present: this.present(), since: this.since };
  }
}

function files(body) {
  try {
    return body.lastFiles || [];
  } catch {
    return [];
  }
}

// A broken page fails silently — the browser throws once and shows nothing,
// and nothing here would ever know. Parse the rendered script at boot instead
// of finding out from a browser console.
function checkPage(sample) {
  const script = /<script>([\s\S]*)<\/script>/.exec(sample)?.[1] ?? "";
  try {
    new Function(script);
  } catch (error) {
    process.stdout.write(`\n  the observer page is broken: ${error.message}\n\n`);
  }
}

export function startPanel({
  port,
  log,
  body,
  loop,
  observer,
  workspace,
  config = null,
  audible = null,
  preserveLife = null,
}) {
  const preserve = preserveLife || ((reason) => archiveLife(log, {
    archiveDir: process.env.AMI_ARCHIVE_DIR || path.join(HERE, "archive"),
    reason,
    label: process.env.AMI_ARCHIVE_LABEL || "life",
  }));
  // When she lives in a machine (AMI_SHELL_SSH set) her files are there, not in
  // the empty local workspace. Count her home on the machine, refreshed in the
  // background so rendering stays synchronous and no request ever waits on ssh.
  const shellHost = process.env.AMI_SHELL_SSH || "";
  let machineFiles = 0;
  if (shellHost) {
    const countHome = () => {
      const remote = process.env.AMI_SHELL_EXEC
        || "export LIMA_HOME=$HOME/.lima; $HOME/lima/bin/limactl shell box timeout 20 bash -s";
      const p = spawn("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=6", shellHost, remote],
        { stdio: ["pipe", "pipe", "ignore"] });
      let out = "";
      p.stdout.on("data", (d) => (out += d));
      p.on("close", () => { const n = parseInt(String(out).trim(), 10); if (Number.isFinite(n)) machineFiles = n; });
      p.on("error", () => {});
      p.stdin.write("ls -A ~ | wc -l\n");
      p.stdin.end();
    };
    countHome();
    setInterval(countHome, 10000).unref?.();
  }
  const homePage = () =>
    renderPage({
      log: momentCards(log, 25),
      eventTotal: log.count(),
      state: {
        awake: Boolean(loop.busy),
        paused: !loop.running,
        next: loop.nextWakeAt,
      },
      setup: loadSetup(log),
      model: config?.model ?? "unknown model",
      arrival: loadSetup(log).arrival,
      mind: describeModel(config),
      world: log.last("world")?.content ?? "",
      runtime: {
        files: shellHost ? machineFiles : files(body).length,
        machine: Boolean(shellHost),
        affordances: body.affordances().length,
        born: log.first()?.at ?? null,
      },
      letters: letterCount(),
      voice: audible?.state ?? { enabled: false, name: "off", speaking: false, queued: 0 },
    });
  checkPage(homePage());
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");

    // A deliberately smaller extension surface than browser automation: one
    // queued Google query goes out and one result list comes back. The model
    // still has only search(), open(), and read_source().
    if (url.pathname.startsWith("/browser-search/")) {
      const origin = String(request.headers.origin || "");
      const extension = /^chrome-extension:\/\/[a-p]{32}$/.test(origin) || origin === "";
      const cors = {
        "access-control-allow-origin": extension ? (origin || "*") : "null",
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "content-type, x-ami-extension, x-ami-session",
        "cache-control": "no-store",
        vary: "Origin",
      };
      if (request.method === "OPTIONS") {
        response.writeHead(extension ? 204 : 403, cors).end();
        return;
      }
      if (!extension || request.headers["x-ami-extension"] !== EXTENSION_BUILD) {
        response.writeHead(403, { ...cors, "content-type": "application/json" });
        response.end(JSON.stringify({ ok: false, note: `reload Project AA extension v${EXTENSION_BUILD}` }));
        return;
      }
      if (url.pathname === "/browser-search/session" && request.method === "GET") {
        response.writeHead(200, { ...cors, "content-type": "application/json" });
        response.end(JSON.stringify(extensionSearch.issueSession()));
        return;
      }
      if (!extensionSearch.authorized(request.headers["x-ami-session"])) {
        response.writeHead(403, { ...cors, "content-type": "application/json" });
        response.end(JSON.stringify({ ok: false, note: "browser search session expired" }));
        return;
      }
      try {
        let result;
        if (url.pathname === "/browser-search/next" && request.method === "GET") {
          result = await extensionSearch.next();
        } else if (url.pathname === "/browser-search/result" && request.method === "POST") {
          const returned = JSON.parse((await read(request)) || "{}");
          result = extensionSearch.complete(returned.id, returned.result);
        } else {
          response.writeHead(404, { ...cors, "content-type": "application/json" });
          response.end(JSON.stringify({ ok: false, note: "unknown browser search route" }));
          return;
        }
        response.writeHead(200, { ...cors, "content-type": "application/json" });
        response.end(JSON.stringify(result));
      } catch (error) {
        response.writeHead(400, { ...cors, "content-type": "application/json" });
        response.end(JSON.stringify({ ok: false, note: String(error.message).slice(0, 180) }));
      }
      return;
    }

    if (url.pathname === "/") {
      observer.seen();
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end(homePage());
      return;
    }

    if (url.pathname === "/events") {
      observer.seen();
      const since = Number(url.searchParams.get("since") || 0);
      const before = Number(url.searchParams.get("before") || 0);
      const tail = Number(url.searchParams.get("tail") || 0);
      const requested = Math.min(300, Math.max(1, Number(url.searchParams.get("limit")) || 120));
      const events = before
        ? log.before(before, requested)
        : tail
          ? log.tail(requested)
          : log.since(since, requested);
      const lastEnd = log.last("end");
      const lastWorld = log.last("world");
      const ended =
        !loop.running &&
        Boolean(lastEnd) &&
        (!lastWorld || lastEnd.id > lastWorld.id);
      json(response, {
        events,
        // The exact document she last woke into, so the panel can show the
        // setup itself rather than only what came out of it.
        room: log.last("world")?.content ?? null,
        roomAt: log.last("world")?.at ?? null,
        next: loop.running ? loop.nextWakeAt : null,
        busy: loop.busy,
        running: loop.running,
        paused: !loop.running && !ended,
        model: config?.model ?? null,
        arrival: loadSetup(log).arrival,
        ended,
        total: log.count(),
        revision: log.get("observer_revision", 0),
        // The id of the oldest surviving event. It changes only when the
        // record is cut, so it identifies which life the page is watching.
        origin: log.first()?.id ?? 0,
      });
      return;
    }

    if (url.pathname === "/voice") {
      observer.seen();
      if (request.method === "POST") {
        const wanted = JSON.parse((await read(request)) || "{}");
        json(response, audible?.set(wanted.enabled) ?? { enabled: false, name: "off" });
        return;
      }
      json(response, audible?.state ?? { enabled: false, name: "off" });
      return;
    }

    if (url.pathname === "/moments") {
      observer.seen();
      const before = Number(url.searchParams.get("before") || 0);
      const requested = Math.min(
        12,
        Math.max(1, Number(url.searchParams.get("limit")) || 6),
      );
      json(response, {
        moments: log.activityPage(before || null, requested),
        total: log.activityCount(),
      });
      return;
    }

    // Her whole life as one standalone file, downloadable while she runs.
    if (url.pathname === "/life.html") {
      observer.seen();
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-disposition": 'attachment; filename="life.html"',
      });
      response.end(buildLife(log));
      return;
    }

    // The authored part of the room, read and written from the panel.
    // Which mind she is. Saved outside her record and never put in the room.
    // Takes effect at her next moment — the loop
    // reads config each time round, so nothing needs restarting.
    if (url.pathname === "/model") {
      observer.seen();
      if (request.method === "POST") {
        const wanted = JSON.parse((await read(request)) || "{}");
        saveModel(wanted);
        try {
          const next = configFromEnv(process.env, loadModel());
          Object.assign(config, next);
          loop.config = next;
          json(response, { saved: true, model: describeModel(next) });
        } catch (error) {
          json(response, { saved: true, error: String(error.message) });
        }
        return;
      }
      json(response, { model: describeModel(config) });
      return;
    }

    // Does this endpoint continue text, or answer it? A provider without
    // prefill looks like working software until you read what she said.
    if (url.pathname === "/model/probe" && request.method === "POST") {
      observer.seen();
      const wanted = JSON.parse((await read(request)) || "{}");
      const merged = { ...config, ...Object.fromEntries(Object.entries(wanted).filter(([, v]) => v)) };
      try {
        json(response, await detect(merged));
      } catch (error) {
        json(response, { ok: false, note: String(error.message) });
      }
      return;
    }

    // Everything she has written to someone. Nothing was sent; this is the
    // only place they exist besides the timeline.
    if (url.pathname === "/letters") {
      observer.seen();
      json(response, { letters: allLetters(Number(url.searchParams.get("n") || 50)) });
      return;
    }

    // The independent variables: which seed, which upstream, which
    // quantization. Kept apart from /model, which is an operator setting.
    if (url.pathname === "/run") {
      observer.seen();
      if (request.method === "POST") {
        json(response, { run: saveRun(log, JSON.parse((await read(request)) || "{}")) });
        return;
      }
      json(response, { run: loadRun(log), defaults: DEFAULT_RUN });
      return;
    }

    if (url.pathname === "/setup") {
      observer.seen();
      if (request.method === "POST") {
        const saved = saveSetup(log, JSON.parse((await read(request)) || "{}"));
        json(response, { setup: saved, defaults: DEFAULT_SETUP });
        return;
      }
      json(response, {
        setup: loadSetup(log),
        defaults: DEFAULT_SETUP,
        placeholders: PLACEHOLDERS,
        model: config?.model ?? null,
        prefill: config?.prefill ?? null,
        temperature: config?.temperature ?? null,
      });
      return;
    }

    // A new birth: the record and the workspace both go, the authored room
    // stays. Restart alone just stops and starts the loop.
    if (url.pathname === "/reset" && request.method === "POST") {
      const nextRevision = Number(log.get("observer_revision", 0)) + 1;
      loop.quiesce();
      await loop.waitUntilIdle();
      await preserve("rebirth");
      log.wipe({ keep: ["setup_v2"] });
      log.set("observer_revision", nextRevision);
      await rm(workspace, { recursive: true, force: true });
      await mkdir(workspace, { recursive: true });
      loop.echoed = false;
      loop.start();
      json(response, { ok: true, born: new Date().toISOString() });
      return;
    }

    // Back to a chosen moment, and run again from there.
    if (url.pathname === "/points") {
      observer.seen();
      json(response, { points: points(log).slice(-60).reverse() });
      return;
    }

    if (url.pathname === "/rewind" && request.method === "POST") {
      const { toId } = JSON.parse((await read(request)) || "{}");
      loop.quiesce();
      // Let a moment already in flight land before the ground moves. Without
      // this, a rewind mid-moment left her stopped with no error anywhere.
      await loop.waitUntilIdle();
      await preserve("rewind");
      const summary = await rewind(log, workspace, toId);
      log.set(
        "observer_revision",
        Number(log.get("observer_revision", 0)) + 1,
      );
      loop.echoed = false;
      loop.start();
      json(response, summary);
      return;
    }

    if (url.pathname === "/restart" && request.method === "POST") {
      loop.stop();
      loop.start();
      json(response, { ok: true });
      return;
    }

    // Pause holds her exactly where she is: no moments pass, nothing is lost,
    // and resume picks up from the same place.
    if (url.pathname === "/pause" && request.method === "POST") {
      loop.stop();
      json(response, { paused: true });
      return;
    }

    if (url.pathname === "/resume" && request.method === "POST") {
      loop.start();
      json(response, { paused: false });
      return;
    }

    // End this life deliberately. She stays readable; she simply has no next
    // moment. Download /life.html to keep a copy.
    if (url.pathname === "/end" && request.method === "POST") {
      loop.quiesce();
      await loop.waitUntilIdle();
      log.append("end", "ended by the observer", { by: "observer" });
      loop.stop();
      await preserve("ended-by-observer");
      json(response, { ended: true });
      return;
    }

    // The readable one. Auto-refreshing plain text, newest moment last.
    if (url.pathname === "/now") {
      observer.seen();
      const limit = Number(url.searchParams.get("n") || 12);
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end(nowPage(log, limit));
      return;
    }

    if (url.pathname === "/life.md") {
      observer.seen();
      response.writeHead(200, { "content-type": "text/markdown; charset=utf-8" });
      response.end(buildMarkdown(log));
      return;
    }

    if (url.pathname === "/peer-say" && request.method === "POST") {
      const expected = String(process.env.AMI_PEER_TOKEN || "");
      const supplied = String(request.headers["x-ami-peer-token"] || "");
      if (!expected || supplied !== expected) {
        response.writeHead(403, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: false }));
        return;
      }
      let message;
      try {
        message = JSON.parse((await read(request)) || "{}");
      } catch {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: false }));
        return;
      }
      const text = String(message.text || "").trim();
      const from = String(message.from || "other").trim() || "other";
      if (!text) {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: false }));
        return;
      }
      if (!loop.running) {
        response.writeHead(409, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: false }));
        return;
      }
      log.append("incoming", text, { from });
      loop.interrupt();
      json(response, { ok: true, receivedBy: String(process.env.AMI_SELF_NAME || "the other living agent") });
      return;
    }

    if (url.pathname === "/say" && request.method === "POST") {
      const text = (await read(request)).trim();
      if (text) {
        log.append("incoming", text, { from: "someone" });
        loop.interrupt();
      }
      json(response, { ok: true });
      return;
    }

    response.writeHead(404).end("not found");
  });

  // Localhost by default. Set AMI_HOST=0.0.0.0 to expose the panel on the LAN
  // (reachable at this machine's router IP) — note this also exposes control,
  // not just viewing, to anyone on the network.
  server.listen(port, process.env.AMI_HOST || "127.0.0.1");
  return server;
}

function json(response, value) {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

function read(request) {
  return new Promise((resolve) => {
    let data = "";
    request.on("data", (chunk) => {
      data += chunk;
      if (data.length > 100_000) request.destroy();
    });
    request.on("end", () => resolve(data));
  });
}
