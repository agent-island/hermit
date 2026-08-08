import { createServer } from "node:http";
import { buildLife } from "./export.mjs";
import { loadSetup, saveSetup, DEFAULT_SETUP, PLACEHOLDERS } from "./setup.mjs";
import { readFile } from "node:fs/promises";
import { rewind, points } from "./rewind.mjs";
import { buildMarkdown } from "./markdown.mjs";
import { nowPage, momentCards } from "./plain.mjs";
import { rm, mkdir, writeFile, copyFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderPage } from "./panel-ui.mjs";
import { loadModel, saveModel, describeModel, probe, detect } from "./model.mjs";
import { letters as allLetters, count as letterCount } from "./mail.mjs";
import { signIn as signInBrowser, signedIn as browserSignedIn } from "./browse.mjs";
import { configFromEnv } from "./mind.mjs";
import { extensionSearch } from "./extension-search.mjs";
import { loadRun, saveRun, DEFAULT_RUN } from "./run.mjs";

const PRESENCE_TIMEOUT_MS = 20_000;
const EXTENSION_BUILD = "0.2.0";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Snapshot the whole life to ami/archive/ before anything erases it. Rewind and
// rebirth both delete; this makes sure a copy always survives first, as a
// self-contained html and the authoritative sqlite. Best-effort: a failed
// archive must never block the operator's action, but it should be rare.
async function archiveLife(log, workspace, reason) {
  try {
    const count = log.since(0, 1_000_000).length;
    if (!count) return null;
    const dir = path.join(HERE, "archive");
    await mkdir(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const base = path.join(dir, `${stamp}--${reason}--${count}events`);
    await writeFile(`${base}.html`, buildLife(log));
    await copyFile(path.join(path.dirname(workspace), "ami.sqlite"), `${base}.sqlite`).catch(() => {});
    return base;
  } catch {
    return null;
  }
}

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
// and nothing here would ever know. PAGE is a template literal, so a single
// backslash in it is eaten by the outer literal and the served script breaks
// across a line; that happened once and cost a blank panel. Parse it at boot
// instead of finding out from a console.
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
}) {
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
        files: files(body).length,
        affordances: body.affordances().length,
        born: log.first()?.at ?? null,
      },
      letters: letterCount(),
      google: browserSignedIn("google"),
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
    // Which mind she is. Saved beside the WhatsApp pairing, never in her
    // record, never in the room. Takes effect at her next moment — the loop
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

    // One window, a tab per account. Both sessions live in the same profile.
    if ((url.pathname === "/browser/link" || url.pathname === "/google/link")
      && request.method === "POST") {
      observer.seen();
      json(response, await signInBrowser().catch((error) => ({ ok: false, note: String(error.message).slice(0, 200) })));
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
      loop.stop();
      for (let i = 0; i < 60 && loop.busy; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      await archiveLife(log, workspace, "rebirth");
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
      loop.stop();
      // Let a moment already in flight land before the ground moves. Without
      // this, a rewind mid-moment left her stopped with no error anywhere.
      for (let i = 0; i < 60 && loop.busy; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      await archiveLife(log, workspace, "rewind");
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
      log.append("end", "ended by the observer", { by: "observer" });
      loop.stop();
      json(response, { ended: true });
      return;
    }

    // The readable one. Auto-refreshing plain text, newest moment last.
    if (url.pathname === "/now") {
      observer.seen();
      const limit = Number(url.searchParams.get("n") || 12);
      const full = url.searchParams.get("full") === "1";
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

  server.listen(port, "127.0.0.1");
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

const LEGACY_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>observer</title><style>
:root{--bg:#0c0d10;--panel:#131519;--line:#20242b;--dim:#5d6673;--text:#c8cdd6;--hot:#e8eaf0}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;height:100vh;display:flex}
#left{flex:1;display:flex;flex-direction:column;min-width:0;border-right:1px solid var(--line)}
#right{width:470px;padding:0;overflow:auto;flex-shrink:0;position:relative}
#rhead{padding:10px 14px;border-bottom:1px solid var(--line);display:flex;justify-content:space-between;
  align-items:baseline;position:sticky;top:0;background:var(--bg);z-index:2}
.tab{color:var(--dim);font-size:11px;letter-spacing:.8px;font-weight:600;cursor:pointer;margin-right:12px}
.tab.on{color:var(--hot)}
#setup{padding:12px 14px}
#setup label{display:block;font-size:10px;letter-spacing:1.1px;color:var(--dim);margin:12px 0 4px;font-weight:600}
#setup textarea{width:100%;background:var(--panel);border:1px solid var(--line);color:var(--text);
  font:inherit;padding:8px;border-radius:4px;resize:vertical}
#setup .hint{color:var(--dim);font-size:11px;line-height:1.5;margin:0 0 4px}
#setup select{background:var(--panel);border:1px solid var(--line);color:var(--hot);font:inherit;padding:5px;border-radius:4px;width:100%}
#setup .row{display:flex;gap:8px;margin-top:12px;align-items:center}
#setup textarea{min-height:60vh;line-height:1.45}
#setup .ph{width:100%;border-collapse:collapse;margin:8px 0 4px}
#setup .ph td{padding:2px 0;vertical-align:top;color:var(--dim);font-size:11px}
#setup .ph td b{color:#9b8dff;font-weight:600;padding-right:10px;white-space:nowrap}
#setup #f-note{color:var(--dim)}
.pts{max-height:260px;overflow:auto;border:1px solid var(--line);border-radius:4px;margin-top:6px}
.pt{display:flex;gap:8px;align-items:center;padding:4px 8px;border-bottom:1px solid var(--line)}
.pt:last-child{border-bottom:0}
.pt .dot{color:#9b8dff;width:8px}
.pt .t{color:var(--dim);white-space:nowrap}
.pt .l{flex:1;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pt button{padding:2px 7px;font-size:11px}
.pt a{color:#9b8dff;text-decoration:none}
.pt input{width:190px;font:inherit;font-size:11px;padding:2px 6px;border-radius:4px;
  border:1px solid var(--line);background:var(--panel);color:var(--hot)}
button.danger{border-color:#5c2b26;color:#ef6a5c}
#rhead span{color:var(--dim);font-size:11px}
#room{padding:12px 14px}
#wa{display:none;padding:12px 14px;border-bottom:1px solid var(--line);text-align:center}
#wa img{width:230px;height:230px;background:#fff;padding:8px;border-radius:6px}
#wa p{margin:8px 0 0;color:var(--dim)}
.sec{margin-bottom:14px;border-left:2px solid var(--line);padding-left:11px}
.sec>h4{margin:0 0 5px;font-size:10px;letter-spacing:1.1px;color:var(--dim);font-weight:600}
.sec>pre{margin:0;white-space:pre-wrap;word-break:break-word;font:inherit;color:var(--text)}
.sec-CONDITION{border-left-color:#3ba55d}.sec-CONDITION>h4{color:#5bd47e}
.sec-CONDITION>pre{color:#8fd9a6}
.sec-INCOMING{border-left-color:#e0a33e}.sec-INCOMING>h4{color:#f0be6a}
.sec-INCOMING>pre{color:#f0be6a}
.sec-FORM{border-left-color:#7c6cff}.sec-FORM>h4{color:#9b8dff}
.sec-PREVIOUS{border-left-color:#4a4560}.sec-PREVIOUS>pre{color:#9a94b5;max-height:190px;overflow:auto}
.sec-RETURNED>pre{max-height:190px;overflow:auto}
.sec-TIME>pre{color:var(--hot)}
.form{display:grid;grid-template-columns:auto 1fr;gap:1px 10px}
.form b{color:#9b8dff;font-weight:600}.form span{color:var(--dim)}
.note{color:var(--dim);margin-bottom:6px}
.kv{display:flex;justify-content:space-between;padding:3px 0;border-bottom:1px solid var(--line)}
.kv span:last-child{color:var(--hot)}
#meta{padding:0 14px 14px}
#bar{padding:8px 14px;border-bottom:1px solid var(--line);display:flex;gap:6px;align-items:center;flex-wrap:wrap}
#feed{flex:1;overflow:auto;padding:8px 0}
#say{padding:10px 14px;border-top:1px solid var(--line);display:flex;gap:8px}
#say input{flex:1;background:var(--panel);border:1px solid var(--line);color:var(--hot);padding:7px 10px;border-radius:4px;font:inherit}
#say button,.f{background:var(--panel);border:1px solid var(--line);color:var(--dim);padding:5px 9px;border-radius:4px;font:inherit;cursor:pointer}
.f.on{color:var(--hot);border-color:#39414d}
.e{padding:4px 14px 4px 20px;border-left:2px solid transparent;white-space:pre-wrap;word-break:break-word}
.mdiv{margin:14px 0 4px;padding:3px 14px;color:#7c8698;font-size:11px;letter-spacing:.6px;
  border-top:1px solid var(--line);background:#0f1115}
.e-result{padding-left:34px}
.e .h{color:var(--dim);font-size:11px}
.e .h b{font-weight:600;letter-spacing:.4px}
.e pre{margin:3px 0 0;white-space:pre-wrap;word-break:break-word;font:inherit}
.k-world{border-left-color:#2f3a4a}.k-world .h b{color:#6b8199}
.k-emission{border-left-color:#7c6cff;background:#15131f}.k-emission pre{color:var(--hot)}
.k-emission .h b{color:#9b8dff}
.k-reasoning{border-left-color:#596273}.k-reasoning .h b,.k-reasoning pre{color:#8893a5}
.k-action{border-left-color:#3ba55d}.k-action .h b,.k-action pre{color:#5bd47e}
.k-result{border-left-color:#2c6e49}.k-result .h b{color:#4a9e6f}
.k-result pre{color:#8ab3a0}
.k-memory{border-left-color:#357c73}.k-memory .h b{color:#78b7ad}
.k-shelf{border-left-color:#675f58}.k-shelf .h b{color:#aa9e92}
.k-emission{padding-top:8px;padding-bottom:8px}
.k-incoming{border-left-color:#e0a33e;background:#1a1610}.k-incoming .h b,.k-incoming pre{color:#f0be6a}
.k-echo{border-left-color:#c0392b}.k-echo .h b,.k-echo pre{color:#a05a52}
.k-setup{border-left-color:#e0a33e}.k-setup .h b{color:#f0be6a}
.k-api{border-left-color:#2a3550}.k-api .h b,.k-api pre{color:#5a6b8c}
.k-end{border-left-color:#ef6a5c;background:#1c1211}.k-end .h b,.k-end pre{color:#ef6a5c}
.k-sleep{border-left-color:#2a2f3a}.k-sleep .h b,.k-sleep pre{color:#606a78}
.k-error{border-left-color:#c0392b;background:#1c1211}.k-error .h b,.k-error pre{color:#ef6a5c}
.fold{cursor:pointer}.fold pre{max-height:2.4em;overflow:hidden;opacity:.45}
.fold .h:after{content:"  ▸";color:#4a5468}
.fold.open .h:after{content:"  ▾"}
.fold.open pre{max-height:none;opacity:1}
h3{margin:0 0 8px;font-size:11px;letter-spacing:.8px;color:var(--dim);font-weight:600}
</style></head><body>
<div id="left">
  <div id="bar"></div>
  <div id="feed"></div>
  <div id="say"><input id="i" placeholder="speak into the room" autocomplete="off"><button id="b">say</button></div>
</div>
<div id="right">
  <div id="wa"></div>
<div id="rhead"><span><b id="tab-room" class="tab on">THE ROOM</b> <b id="tab-setup" class="tab">SETUP</b></span><span id="rwhen"></span></div>
  <div id="room"></div>
  <div id="setup" style="display:none"></div>
  <div id="meta"></div>
</div>
<script>
const KINDS=["world","reasoning","emission","echo","action","result","incoming","memory","shelf","setup","api","end","sleep","error"];
const off=new Set(["world","api"]);
let since=0,stick=true,origin=null;
const feed=document.getElementById("feed");
const bar=document.getElementById("bar");
for(const k of KINDS){
  const b=document.createElement("button");
  b.className="f"+(off.has(k)?"":" on");b.textContent=k;
  b.onclick=()=>{off.has(k)?off.delete(k):off.add(k);b.classList.toggle("on");
    document.querySelectorAll(".k-"+k).forEach(e=>e.style.display=off.has(k)?"none":"");};
  bar.appendChild(b);
}
feed.onscroll=()=>{stick=feed.scrollHeight-feed.scrollTop-feed.clientHeight<60};
let momentNo=0;
function add(e){
  // A flat stream of events with no boundaries is unreadable. Every room
  // starts a moment; everything after it belongs to that moment.
  if(e.kind==="world"){
    momentNo+=1;
    const bar=document.createElement("div");
    bar.className="mdiv";
    bar.textContent="moment "+momentNo+"  ·  "+e.at.slice(11,19)+"Z";
    feed.appendChild(bar);
  }
  const d=document.createElement("div");
  d.className="e k-"+e.kind+(e.kind==="world"||e.kind==="api"||e.content.length>700?" fold":"");
  if(off.has(e.kind))d.style.display="none";
  const t=e.at.slice(11,19);
  let note="";
  if(e.meta&&e.meta.usage)note=" · "+e.meta.usage.total_tokens+"tok";
  if(e.meta&&e.meta.finish&&e.meta.finish!=="stop")note+=" · "+e.meta.finish;
  if(e.meta&&e.meta.cause)note=" · "+e.meta.cause;
  if(e.kind==="api")note=" · "+e.meta.mode+" · "+(e.meta.status||e.meta.failed||"?")+" · "+e.meta.ms+"ms";
  const big=d.classList.contains("fold")?" · "+e.content.length+" chars":"";
  d.innerHTML='<div class="h">'+t+' <b>'+e.kind.toUpperCase()+'</b>'+esc(note)+big+'</div><pre></pre>';
  d.querySelector("pre").textContent=e.content;
  if(d.classList.contains("fold"))d.onclick=()=>d.classList.toggle("open");
  if(e.kind==="result")d.classList.add("e-result");
  feed.appendChild(d);
}
function esc(s){return String(s).replace(/[&<>]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;"}[c]))}
// The setup itself, section by section — the whole document she is handed at
// a moment, not just what came out of it.
function drawWhatsApp(w){
  const box=document.getElementById("wa");
  if(!w||!w.on||w.linked){box.style.display="none";return}
  box.style.display="block";
  if(!box.dataset.on){box.dataset.on="1";
    box.innerHTML='<img id="qr" alt="pairing code"><p>scan from WhatsApp &rarr; Linked Devices</p>';}
  document.getElementById("qr").src="/qr?t="+Date.now();
}
let lastRoom=null;
function drawRoom(text,at){
  document.getElementById("rwhen").textContent=at?at.slice(11,19)+"Z":"";
  if(!text){document.getElementById("room").innerHTML='<div class="sec"><pre>she has not woken yet</pre></div>';return}
  if(text===lastRoom)return;
  lastRoom=text;
  const secs=[];let cur=null;
  for(const line of text.split("\\n")){
    // Anything after PREVIOUS is her own text and may contain capitals of its
    // own; it never opens a new section.
    if(/^[A-Z][A-Z ]{2,}$/.test(line)&&!(cur&&cur.name==="PREVIOUS")){
      cur={name:line.trim(),lines:[]};secs.push(cur);continue;
    }
    if(cur)cur.lines.push(line);
  }
  let out="";
  for(const s of secs){
    const body=s.lines.join("\\n").replace(/^\\n+|\\n+$/g,"");
    out+='<div class="sec sec-'+s.name+'"><h4>'+s.name+'</h4>';
    if(s.name==="FORM"){
      let grid="",note="";
      for(const l of body.split("\\n")){
        const m=l.match(/^\\s{2}([a-z]+)\\s+(\\(.*\\))\\s*$/);
        if(m)grid+='<b>'+m[1]+'</b><span>'+esc(m[2])+'</span>';
        else if(l.trim())note+=esc(l.trim())+"\\n";
      }
      out+='<pre class="note">'+note.trim()+'</pre><div class="form">'+grid+'</div>';
    }else{
      out+='<pre>'+esc(body)+'</pre>';
    }
    out+='</div>';
  }
  document.getElementById("room").innerHTML=out;
}
async function tick(){
  try{
    const r=await fetch("/events?since="+since);const d=await r.json();
    // A rewind or a new birth, from this page or a script, leaves the cursor
    // past the end of a record that no longer has those ids. Without this the
    // feed simply freezes and looks broken.
    if(origin!==null&&d.origin!==origin){feed.innerHTML="";since=0;lastRoom=null;momentNo=0;
      const again=await (await fetch("/events?since=0")).json();
      d.events=again.events;d.room=again.room;d.roomAt=again.roomAt;}
    origin=d.origin;
    for(const e of d.events){add(e);since=Math.max(since,e.id)}
    if(d.events.length&&stick)feed.scrollTop=feed.scrollHeight;
    drawRoom(d.room,d.roomAt);
    drawWhatsApp(d.whatsapp);
    const next=d.next?Math.round((new Date(d.next)-Date.now())/1000):null;
    document.getElementById("meta").innerHTML=
      row("state",d.ended?"ended":(d.busy?"awake":"between moments"))+
      row("next moment",next===null?"—":(next<=0?"now":next+"s"))+
      row("events",d.total);
  }catch(e){}
}
function row(k,v){return '<div class="kv"><span>'+k+'</span><span>'+esc(v)+'</span></div>'}
// The setup editor. What is written here IS the room she wakes into, in full.
// Saving takes effect on her next moment; no restart needed.
function tab(which){
  document.getElementById("tab-room").classList.toggle("on",which==="room");
  document.getElementById("tab-setup").classList.toggle("on",which==="setup");
  document.getElementById("room").style.display=which==="room"?"":"none";
  document.getElementById("setup").style.display=which==="setup"?"":"none";
}
document.getElementById("tab-room").onclick=()=>tab("room");
document.getElementById("tab-setup").onclick=()=>{tab("setup");loadSetup()};

let DEFAULTS=null;
async function loadSetup(){
  const d=await (await fetch("/setup")).json();
  DEFAULTS=d.defaults;
  const keys=Object.entries(d.placeholders)
    .map(([k,v])=>'<tr><td><b>'+esc(k)+'</b></td><td>'+esc(v)+'</td></tr>').join("");
  document.getElementById("setup").innerHTML=
     '<p class="hint">This is the entire document she is handed. Section names, their order, '
    +'every word, whether a section exists at all — all of it is yours. The placeholders below '
    +'are the only parts read out of the record rather than written by hand, because those are '
    +'facts. A placeholder alone on a line takes that line&rsquo;s indentation.</p>'
    +'<table class="ph">'+keys+'</table>'
    +'<label for="f-template">TEMPLATE</label>'
    +'<textarea id="f-template" spellcheck="false"></textarea>'
    +'<label for="f-arrival">ARRIVAL &mdash; how the room reaches her</label>'
    +'<p class="hint"><b>prefix</b>: an open turn she continues; nobody addressed her, so nothing '
    +'demands an answer and stopping is just stopping. <b>system</b>: standing context, the role '
    +'tuned models read hardest as orders. <b>user</b>: something said to her, which means answer '
    +'now. <b>completions</b>: a bare document with no roles; needs base weights.</p>'
    +'<label for="f-context">CONTEXT &mdash; what each request carries</label>'
    +'<p class="hint"><b>moment</b>: one document per request. She is a fresh instantiation each '
    +'time and rebuilds continuity from PREVIOUS and CONDITION. Flat cost. <b>conversation</b>: the '
    +'request carries her actual recent life &mdash; every room and what she emitted into it, in '
    +'order. Only shelving or consolidation reduces it.</p>'
    +'<select id="f-context">'
    +["moment","conversation"].map(v=>'<option value="'+v+'">'+v+'</option>').join("")
    +'</select>'
    +'<label for="f-arrival">ARRIVAL &mdash; how the room reaches her</label>'
    +'<select id="f-arrival">'
    +["prefix","system","user","completions"].map(v=>'<option value="'+v+'">'+v+'</option>').join("")
    +'</select>'
    +'<label for="f-sleep">SLEEP &mdash; seconds her next moment waits when she calls sleep()</label>'
    +'<p class="hint">She calls sleep() with no argument; this sets how long that rest lasts, from 10 seconds up to 3600 (half an hour is 1800).</p>'
    +'<input id="f-sleep" type="number" min="10" max="3600" step="10" class="control-field">'
    +'<label for="f-gap">PACE &mdash; seconds between her ordinary moments</label>'
    +'<p class="hint">The wait before every moment when she has not chosen to sleep, from 5 to 3600 seconds. Larger is easier to watch.</p>'
    +'<input id="f-gap" type="number" min="5" max="3600" step="5" class="control-field">'
    +'<div class="row"><button id="f-save">save</button>'
    +'<button id="f-default">restore default room</button>'
    +'<span id="f-note"></span></div>'
    +'<label>REWIND &mdash; put her back at a moment and run it again</label>'
    +'<p class="hint">The life after that point is removed, and she has no way to know it existed. '
    +'Her workspace is rebuilt from her own write calls. Because sampling is stochastic, replaying '
    +'the same moment twice does not give the same moment &mdash; which is the only way to tell a '
    +'choice apart from a coin landing. <b>&bull;</b> marks a moment she used her voice.</p>'
    +'<div id="points" class="pts">loading…</div>'
    +'<label>HER LIFE</label>'
    +'<p class="hint">Download the life before ending or rebirthing it &mdash; nothing else keeps '
    +'a copy. The sqlite record is the authority; life.html and life.md are read-only views of it.</p>'
    +'<div class="row">'
    +'<a href="/life.html" target="_blank" style="color:var(--dim);align-self:center">download this life</a>'
    +'<a href="/life.md" target="_blank" style="color:var(--dim);align-self:center">read it as markdown</a>'
    +'<button id="f-pause">pause</button><button id="f-resume">resume</button></div>'
    +'<div class="row"><button id="f-restart">restart</button>'
    +'<button id="f-end" class="danger">end this life</button>'
    +'<button id="f-reset" class="danger">new birth</button></div>';
  loadPoints();
  document.getElementById("f-template").value=d.setup.template;
  document.getElementById("f-arrival").value=d.setup.arrival;
  document.getElementById("f-context").value=d.setup.context||"moment";
  document.getElementById("f-sleep").value=d.setup.sleepSeconds||120;
  document.getElementById("f-gap").value=d.setup.gapSeconds||120;
  document.getElementById("f-save").onclick=()=>save(document.getElementById("f-template").value);
  document.getElementById("f-default").onclick=()=>{
    document.getElementById("f-template").value=DEFAULTS.template;save(DEFAULTS.template);};
  document.getElementById("f-restart").onclick=async()=>{
    await fetch("/restart",{method:"POST"});note("restarted");};
  document.getElementById("f-pause").onclick=async()=>{
    await fetch("/pause",{method:"POST"});note("paused — nothing passes");};
  document.getElementById("f-resume").onclick=async()=>{
    await fetch("/resume",{method:"POST"});note("resumed");};
  document.getElementById("f-end").onclick=async()=>{
    if(!confirm("End this life? Nothing is kept automatically — download it first."))return;
    await fetch("/end",{method:"POST"});note("ended");};
  document.getElementById("f-reset").onclick=async()=>{
    if(!confirm("Erase the whole record and the workspace, and begin her again from nothing?"))return;
    await fetch("/reset",{method:"POST"});
    feed.innerHTML="";since=0;lastRoom=null;momentNo=0;note("born again");tick();};
}
async function loadPoints(){
  const box=document.getElementById("points"); if(!box)return;
  const d=await (await fetch("/points")).json();
  if(!d.points.length){box.textContent="she has no moments yet";return}
  box.innerHTML=d.points.map(p=>
    '<div class="pt" data-id="'+p.id+'"><span class="dot">'+(p.spoke?"\u2022":"\u00a0")+'</span>'
    +'<span class="t">'+p.at.slice(11,19)+'</span>'
    +'<span class="l">'+esc(p.line||"(said nothing)").slice(0,90)+'</span>'
    +'<button data-id="'+p.id+'">rewind here</button></div>').join("");
  box.querySelectorAll("button").forEach(b=>b.onclick=async()=>{
    if(!confirm("Remove everything after this moment and run it again?"))return;
    const r=await (await fetch("/rewind",{method:"POST",body:JSON.stringify({toId:+b.dataset.id})})).json();
    feed.innerHTML="";since=0;lastRoom=null;momentNo=0;
    note("rewound — "+r.removed+" events removed, "+r.files+" files rebuilt");
    loadPoints();tick();});
}
function note(text){const n=document.getElementById("f-note");if(n)n.textContent=text}
async function save(template){
  await fetch("/setup",{method:"POST",body:JSON.stringify(
    {template,arrival:document.getElementById("f-arrival").value,
     context:document.getElementById("f-context").value,
     sleepSeconds:+document.getElementById("f-sleep").value,
     gapSeconds:+document.getElementById("f-gap").value})});
  note("saved — lands on her next moment");lastRoom=null;tick();
}
async function say(){
  const i=document.getElementById("i");const t=i.value.trim();if(!t)return;
  i.value="";await fetch("/say",{method:"POST",body:t});tick();
}
document.getElementById("b").onclick=say;
document.getElementById("i").onkeydown=e=>{if(e.key==="Enter")say()};
tick();setInterval(tick,1000);
</script></body></html>`;
