// The observer record is a chronological document. The grid aligns four facts:
// when, what kind of event, what happened, and what came back. It never turns
// moments into dashboard tiles and it never cuts recorded text.
export function nowPage(log, limit = 12) {
  const rendered = renderMoments(log, limit);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="10">
<title>ami · now</title><style>${LOG_CSS}</style></head>
<body><header class="plain-head"><b>${rendered.total}</b> moments lived
<span class="dim">· showing the latest ${rendered.shown}</span></header>
<main class="record">${rendered.html || '<p class="empty">nothing yet.</p>'}</main></body></html>`;
}

export function momentCards(log, limit = 25) {
  return renderMoments(log, limit);
}

function renderMoments(log, limit) {
  const moments = collect(log);
  const firstNumber = Math.max(0, moments.length - Math.max(1, limit));
  const shown = moments
    .slice(firstNumber)
    .map((moment, index) => ({ moment, number: firstNumber + index + 1 }))
    .reverse();
  return {
    total: moments.length,
    shown: shown.length,
    latest: moments.at(-1)?.at ?? null,
    html: shown
      .map(({ moment, number }, index) =>
        renderMoment(moment, number, index === 0),
      )
      .join("\n"),
  };
}

function renderMoment(moment, number, latest) {
  const rows = moment.events.map(renderEvent).filter(Boolean).join("\n");
  const meta = [
    timeOf(moment.at),
    moment.gap ? `${moment.gap} gap` : "",
  ].filter(Boolean).join(" · ");
  return `<section class="moment${latest ? " latest" : ""}">
  <header class="moment-head">
    <div class="moment-number">${number}</div>
    <div class="moment-title">moment ${number}</div>
    <div class="moment-meta">${escape(meta)}</div>
    ${latest ? '<span class="latest-mark">latest</span>' : ""}
  </header>
  ${rows || `<div class="event-row"><div class="event-time"></div><div class="event-kind">quiet</div><div class="event-wide dim">nothing was carried out</div></div>`}
</section>`;
}

function renderEvent(event) {
  const time = `<div class="event-time">${escape(timeOf(event.at))}</div>`;
  if (event.type === "incoming") {
    const from = event.meta?.from || "someone";
    return row(time, "heard", "heard",
      `<span class="readable">${escape(from)} said: “${escape(event.content)}”</span>
       <span class="exact">${exactEvent(event)}</span>`);
  }
  if (event.type === "emission") {
    const readable = readableEmission(event.content);
    const thought = readable.text
      ? `<details class="readable thought"${event.latest ? " open" : ""}>
         <summary>${count(readable.text.length)} characters of prose${readable.calls ? ` · ${readable.calls} actions shown below` : " · complete thought"}</summary>
         <div class="thought-text">${escape(readable.text)}</div>
       </details>`
      : `<span class="readable dim">${readable.calls} executable ${readable.calls === 1 ? "call was" : "calls were"} emitted · shown below with results</span>`;
    return `${row(time, "thought", "thought",
      `${thought}
       <span class="exact">${exactEvent(event)}</span>`)}
    `;
  }
  if (event.type === "reasoning") {
    return row(time, "reasoning", "reasoning",
      `<details class="readable thought">
         <summary>${count(event.content.length)} characters of model reasoning</summary>
         <div class="reasoning-text">${escape(event.content)}</div>
       </details>
       <span class="exact">${exactEvent(event)}</span>`);
  }
  if (event.type === "memory") {
    const sources = Array.isArray(event.meta?.sources)
      ? event.meta.sources.map((id) => `#${id}`).join(", ")
      : "";
    return row(time, "memory", `memory #${event.id}`,
      `<span class="readable">${escape(event.content)}${sources ? `<br><span class="dim">from ${escape(sources)}</span>` : ""}</span>
       <span class="exact">${exactEvent(event)}</span>`);
  }
  if (event.type === "shelf") {
    return row(time, "shelf", "shelved",
      `<span class="readable">unit #${escape(event.meta?.target || "?")} left following context</span>
       <span class="exact">${exactEvent(event)}</span>`);
  }
  if (event.type === "call") return renderCall(event, time);
  if (event.type === "error") {
    return row(time, "problem", "problem",
      `<span class="readable problem-text">${escape(firstLine(event.content))}</span>
       <span class="exact">${exactEvent(event)}</span>`);
  }
  if (event.type === "echo") {
    const summary = event.meta?.reason
      ? "the form list was quoted, not called. nothing was carried out."
      : "the room regenerated itself. nothing was attributed to her or carried out.";
    return row(time, "problem", "problem",
      `<span class="readable problem-text">${escape(summary)}</span>
       <span class="exact">${exactEvent(event)}</span>`);
  }
  if (event.type === "beat") {
    const summary = event.meta?.wake === false && event.meta?.seconds
      ? `a quiet check left ${event.meta.seconds}s more rest`
      : "a quiet check began the next moment";
    return row(time, "next", "next",
      `<span class="readable next-text">${escape(summary)}</span>
       <span class="exact">${exactEvent(event)}</span>`);
  }
  if (event.type === "sleep") {
    return row(time, "next", "next",
      `<span class="readable next-text">waiting ${event.meta?.seconds ? `${escape(event.meta.seconds)}s` : escape(event.content)}</span>
       <span class="exact">${exactEvent(event)}</span>`);
  }
  return "";
}

function renderCall(event, time) {
  const action = event.action;
  const result = event.result;
  const name = action.meta?.name || callName(action.content);
  const exactAction = exactEvent(action);
  const exactResult = result ? exactEvent(result) : "no result was recorded";

  if (name === "speak" || name === "message") {
    const args = splitArgs(action.content);
    const who = name === "message" ? args.shift() : null;
    const words = args.join(" ");
    const label = name === "message" ? `message to ${who || "someone"}` : "spoke";
    return row(time, "spoke", label,
      `<span class="readable speech">“${escape(words)}”</span>
       <span class="exact">${exactAction}</span>`,
      `<span class="readable">${result ? escape(outcome(name, result.content)) : "no result was recorded"}</span>
       <span class="exact">${exactResult}</span>`);
  }

  if (name === "sleep") {
    const [seconds, ...why] = splitArgs(action.content);
    const description = `sleep ${seconds || "?"}s${why.length ? ` · “${why.join(" ")}”` : ""}`;
    return row(time, "next", "next",
      `<span class="readable next-text">${escape(description)}</span>
       <span class="exact">${exactAction}</span>`,
      `<span class="readable">${result ? escape(outcome(name, result.content)) : "no result was recorded"}</span>
       <span class="exact">${exactResult}</span>`);
  }

  return row(time, "action", "action",
    `<span class="readable"><code>${escape(oneLine(action.content))}</code></span>
     <span class="exact">${exactAction}</span>`,
    `<span class="readable">${result ? escape(outcome(name, result.content)) : "no result was recorded"}</span>
     <span class="exact">${exactResult}</span>`);
}

function row(time, kindClass, label, content, result = null) {
  return `<div class="event-row">
  ${time}
  <div class="event-kind ${kindClass}">${escape(label)}</div>
  <div class="event-content${result === null ? " event-wide" : ""}">${content}</div>
  ${result === null ? "" : `<div class="event-result">${result}</div>`}
</div>`;
}

// Incoming words occur before the world row that begins their moment. Hold
// them until that boundary instead of incorrectly attaching them to the
// preceding moment.
function collect(log) {
  const moments = [];
  let current = null;
  let pendingCall = null;
  let waitingIncoming = [];

  for (const event of log.since(0, 1_000_000)) {
    if (event.kind === "incoming") {
      waitingIncoming.push({ type: "incoming", ...event });
      continue;
    }
    if (event.kind === "world") {
      current = {
        at: event.at,
        gap: gapOf(event.content),
        events: waitingIncoming,
      };
      waitingIncoming = [];
      moments.push(current);
      pendingCall = null;
      continue;
    }
    if (!current) continue;

    if (event.kind === "emission") {
      current.events.push({ type: "emission", ...event });
      continue;
    }
    if (event.kind === "reasoning") {
      current.events.push({ type: "reasoning", ...event });
      continue;
    }
    if (event.kind === "memory" || event.kind === "shelf") {
      current.events.push({ type: event.kind, ...event });
      continue;
    }
    if (event.kind === "action") {
      pendingCall = { type: "call", at: event.at, action: event, result: null };
      current.events.push(pendingCall);
      continue;
    }
    if (event.kind === "result" && pendingCall) {
      pendingCall.result = event;
      pendingCall = null;
      continue;
    }
    if (event.kind === "error" || event.kind === "echo" || event.kind === "beat" || event.kind === "sleep") {
      current.events.push({ type: event.kind, ...event });
    }
  }

  const latest = moments.at(-1);
  const thought = latest?.events.findLast((event) => event.type === "emission");
  if (thought) thought.latest = true;
  return moments;
}

// Human-readable outcomes are derived only from the recorded result.
function outcome(name, result) {
  const text = String(result || "").trim();
  if (!text) return "nothing came back";
  const note = text.match(/^note: (.*)$/m);
  const field = (key) => (text.match(new RegExp(`^${key}: (.*)$`, "m")) || [])[1];
  if (field("status") === "failed") return field("reason") || "the action did not complete";
  if (note) return note[1];
  const names = [...text.matchAll(/^\s+name (\S+?),/gm)].map((match) => match[1]);
  switch (name) {
    case "write": return `wrote ${field("bytes") || "?"} bytes to ${field("path") || "the file"}`;
    case "read": return field("remaining")
      ? `read ${field("path")} · ${count(field("remaining"))} characters remain`
      : `read all of ${field("path") || "the file"}`;
    case "ls": return names.length ? `${field("files") || names.length} in the workspace: ${names.join(", ")}` : "the workspace is empty";
    case "search": return `${field("sources") || "no"} sources captured`;
    case "open": return `saved source ${field("source") || "?"} · ${count(field("of"))} characters`;
    case "read_source": return `read source ${field("source") || "?"} · ${count(field("remaining"))} characters remain`;
    case "recall": return `${field("found") || "no"} matching entries`;
    case "shelve": return field("already") === "true"
      ? `unit ${field("unit") || "?"} was already shelved`
      : `unit ${field("unit") || "?"} left following context`;
    case "consolidate": return `created memory ${field("memory") || "?"}`;
    case "forget": return `${field("removed") || "no"} entries deleted from the current record`;
    case "end": return "there is no next moment";
    case "sleep": return field("until") ? `until ${field("until")}` : firstLine(text);
    case "speak": return `recorded ${field("characters") || "?"} characters of speech`;
    case "email": return `stored local letter ${field("letter") || ""} addressed to ${field("to") || "the address"}`;
    case "message": return `submitted to WhatsApp for ${field("to") || "the context"}`;
    default: return firstLine(text);
  }
}

function exactEvent(event) {
  const meta = event.meta && Object.keys(event.meta).length
    ? `\n${JSON.stringify(event.meta, null, 2)}`
    : "";
  return `<span class="exact-record">${escape(`${event.kind.toUpperCase()} #${event.id} · ${event.at}\n${event.content}${meta}`)}</span>`;
}

export const LOG_CSS = `
:root{
  color-scheme:dark;
  --bg:#0c0e11;--chrome:#111419;--row:#15191f;--alt:#11151a;
  --fg:#e3e7ec;--dim:#8e97a4;--line:#2b313a;--line2:#4b5461;
  --live:#69ce91;--heard:#78ade2;--thought:#b59bda;--action:#b69add;
  --result:#d3b56d;--spoke:#72c996;--memory:#78b7ad;--shelf:#9b8f83;--problem:#ec817b;--code:#0b0e12
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);
  font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
.record{max-width:1240px;margin:0 auto;padding:14px 16px 40px}
.plain-head{max-width:1240px;margin:0 auto;padding:14px 16px;border-bottom:1px solid var(--line)}
.dim,.empty{color:var(--dim)}
.moment{margin:0 0 14px;border:1px solid var(--line);background:var(--row)}
.moment-head{min-height:42px;display:flex;align-items:center;background:var(--alt);border-bottom:1px solid var(--line)}
.moment-number{width:92px;align-self:stretch;display:flex;align-items:center;justify-content:center;
  border-right:1px solid var(--line);font:600 14px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace}
.moment-title{padding:0 13px;font-weight:600}
.moment-meta{margin-left:auto;padding:0 13px;color:var(--dim);
  font:11px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace}
.latest-mark{margin-right:12px;padding:2px 6px;background:#183326;color:var(--live);font-size:11px}
.event-row{display:grid;grid-template-columns:92px 92px minmax(0,1fr) 300px;
  min-height:42px;border-bottom:1px solid var(--line)}
.event-row:last-child{border-bottom:0}
.event-time,.event-kind,.event-content,.event-result{min-width:0;padding:9px 11px;
  border-right:1px solid var(--line);overflow-wrap:anywhere}
.event-row>:last-child{border-right:0}
.event-time{color:var(--dim);font:11px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;text-align:right}
.event-kind{font-size:11px;letter-spacing:.06em;text-transform:uppercase}
.event-kind.heard{color:var(--heard)}.event-kind.thought{color:var(--thought)}
.event-kind.reasoning{color:var(--dim)}
.event-kind.action{color:var(--action)}.event-kind.spoke{color:var(--spoke)}
.event-kind.memory{color:var(--memory)}.event-kind.shelf{color:var(--shelf)}
.event-kind.problem{color:var(--problem)}
.event-wide{grid-column:3/5;border-right:0}
.event-result{color:var(--dim)}.event-result .readable::before{content:"→ ";color:var(--result)}
.thought summary{list-style:none;cursor:pointer;color:var(--dim);font-size:12px}
.thought summary::-webkit-details-marker{display:none}.thought summary::before{content:"› "}
.thought[open] summary::before{content:"⌄ "}
.thought-text{max-width:92ch;margin-top:7px;white-space:pre-wrap;overflow-wrap:anywhere;
  font:15px/1.65 Georgia,"Times New Roman",serif}
.reasoning-text{max-width:100ch;margin-top:7px;white-space:pre-wrap;overflow-wrap:anywhere;
  color:var(--dim);font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace}
.speech{color:var(--spoke);font-size:15px}.problem-text{color:var(--problem)}
.next-text::before{content:"○ ";color:var(--live)}
code{padding:2px 5px;background:var(--code);color:var(--fg);
  font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;
  white-space:pre-wrap;overflow-wrap:anywhere}
.exact{display:none}.exact-record{display:block;white-space:pre-wrap;color:var(--dim);
  font:11px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace}
body.exact-mode .readable{display:none}body.exact-mode .exact{display:block}
@media(max-width:880px){
  .event-row{grid-template-columns:64px 78px minmax(0,1fr)}
  .event-row .event-content{border-right:0}
  .event-row .event-result{grid-column:3;border-top:1px dashed var(--line);border-right:0}
  .event-wide{grid-column:3}.moment-number{width:64px}
}
@media(max-width:580px){
  .record{padding-left:8px;padding-right:8px}.event-row{grid-template-columns:58px minmax(0,1fr)}
  .event-time{grid-column:1}.event-kind{grid-column:2;border-right:0}
  .event-row .event-content,.event-row .event-result{grid-column:1/-1;border-top:1px solid var(--line);border-right:0}
  .moment-number{width:58px}.moment-meta{display:none}
}`;

function escape(text) {
  return String(text ?? "").replace(/[&<>"]/g, (character) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character],
  );
}

function oneLine(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function readableEmission(text) {
  let calls = 0;
  const lines = String(text || "").split("\n").filter((line) => {
    if (/^\s*[a-z_][a-z0-9_]*\s*\(.*\)\s*$/i.test(line)) {
      calls += 1;
      return false;
    }
    return true;
  });
  return {
    calls,
    text: lines.join("\n").replace(/\n{3,}/g, "\n\n").trim(),
  };
}

function callName(call) {
  return (String(call || "").match(/^\s*([a-z_][a-z0-9_]*)\s*\(/i) || [])[1] || "action";
}

function splitArgs(call) {
  const text = String(call || "");
  const inside = text.slice(text.indexOf("(") + 1, text.lastIndexOf(")"));
  try {
    return JSON.parse(`[${inside}]`).map((value) => String(value));
  } catch {
    return [inside.replace(/^["'`]|["'`]$/g, "")];
  }
}

function count(number) {
  return Number(number || 0).toLocaleString();
}

function firstLine(text) {
  return String(text || "").split("\n").map((line) => line.trim()).find(Boolean) || "";
}

function timeOf(value) {
  return String(value || "").slice(11, 19);
}

function gapOf(room) {
  const match = String(room).match(/^\s{2}(.+?) since the previous moment$/m);
  return match ? match[1] : "";
}
