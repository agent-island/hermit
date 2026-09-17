// The observer record is a chronological document. The grid aligns four facts:
// when, what kind of event, what happened, and what came back. It never turns
// moments into dashboard tiles and it never cuts recorded text.
import { parseCalls } from "./mind.mjs";

export function nowPage(log, limit = 12) {
  const rendered = renderMoments(log, limit);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="10">
<title>hermit · now</title><style>${LOG_CSS}</style></head>
<body><header class="plain-head"><b>${rendered.total}</b> continuations
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
    <div class="moment-title">continuation ${number}</div>
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
    const readable = readableEmission(event.content, event.actions);
    const thought = readable.text
      ? `<details class="readable thought"${event.latest ? " open" : ""}>
         <summary>
           <span class="message-subject">${escape(subjectOf(readable.text))}</span>
           <span class="message-meta">${count(readable.text.length)} characters${readable.calls ? ` · ${readable.calls} actions below` : ""}</span>
         </summary>
         <div class="thought-text">${escape(readable.text)}</div>
       </details>`
      : `<span class="readable dim">${readable.calls} executable ${readable.calls === 1 ? "call was" : "calls were"} emitted · shown below with results</span>`;
    return `${row(time, "thought", "thought",
      `${thought}
       <span class="exact">${exactEvent(event)}</span>`, null, "message-row")}
    `;
  }
  if (event.type === "reasoning") {
    const reasoning = readableRecordText(event.content);
    return row(time, "reasoning", "reasoning",
      `<details class="readable thought">
         <summary>
           <span class="message-subject">${escape(subjectOf(reasoning))}</span>
           <span class="message-meta">${count(reasoning.length)} characters · model reasoning</span>
         </summary>
         <div class="reasoning-text">${escape(reasoning)}</div>
       </details>
       <span class="exact">${exactEvent(event)}</span>`, null, "message-row reasoning-row");
  }
  if (event.type === "reasoning_details") {
    // Some providers return the same readable reasoning twice: once in the
    // plain `reasoning` field and once inside `reasoning_details[].text`.
    // Both exact records stay preserved, but the readable record should not
    // present one thought as two thoughts.
    if (event.readableDuplicate) {
      return row(time, "reasoning", "reasoning details",
        `<span class="exact">${exactEvent(event)}</span>`, null, "exact-only");
    }
    const reasoning = readableStructuredReasoning(event.content);
    return row(time, "reasoning", "reasoning details",
      `<details class="readable thought">
         <summary>
           <span class="message-subject">${escape(subjectOf(reasoning))}</span>
           <span class="message-meta">${count(reasoning.length)} characters · structured reasoning</span>
         </summary>
         <div class="reasoning-text">${escape(reasoning)}</div>
       </details>
       <span class="exact">${exactEvent(event)}</span>`, null, "message-row reasoning-row");
  }
  if (event.type === "memory") {
    const sources = Array.isArray(event.meta?.sources)
      ? event.meta.sources.map((id) => `#${id}`).join(", ")
      : "";
    const memory = readableRecordText(event.content);
    const readableMemory = memory.length > 320
      ? `<details class="readable thought memory-document">
           <summary>
             <span class="message-subject">${escape(subjectOf(memory))}</span>
             <span class="message-meta">${count(memory.length)} characters · memory</span>
           </summary>
           <div class="memory-text">${escape(memory)}</div>
         </details>`
      : `<span class="readable">${escape(memory)}</span>`;
    return row(time, "memory", `memory #${event.id}`,
      `${readableMemory}${sources ? `<br><span class="readable dim">from ${escape(sources)}</span>` : ""}
       <span class="exact">${exactEvent(event)}</span>`, null, memory.length > 320 ? "message-row memory-row" : "");
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

  if (["speak", "think", "inner_speech", "speak_aloud"].includes(name)) {
    const words = splitArgs(action.content).join(" ");
    const aloud = name === "speak_aloud";
    const readableSpeech = words.length > 320
      ? `<details class="readable thought speech-document"${event.latest ? " open" : ""}>
           <summary>
             <span class="message-subject">${escape(subjectOf(words))}</span>
             <span class="message-meta">${count(words.length)} characters · ${aloud ? "spoken aloud" : "inner speech"}</span>
           </summary>
           <div class="thought-text speech">“${escape(words)}”</div>
         </details>`
      : `<span class="readable speech">“${escape(words)}”</span>`;
    return row(time, aloud ? "spoke" : "thought", aloud ? "spoke aloud" : "thought",
      `${readableSpeech}
       <span class="exact">${exactAction}</span>`,
      `<span class="readable">${result ? escape(outcome(name, result.content)) : "no result was recorded"}</span>
       <span class="exact">${exactResult}</span>`, words.length > 320 ? "message-row speech-row" : "");
  }

  if (name === "sleep" || name === "continue") {
    const [seconds, ...why] = splitArgs(action.content);
    const verb = name === "continue" ? "continue" : "sleep";
    const description = seconds
      ? `${verb} ${seconds}s${why.length ? ` · “${why.join(" ")}”` : ""}`
      : verb;
    return row(time, "next", "next",
      `<span class="readable next-text">${escape(description)}</span>
       <span class="exact">${exactAction}</span>`,
      `<span class="readable">${result ? escape(outcome(name, result.content)) : "no result was recorded"}</span>
       <span class="exact">${exactResult}</span>`);
  }

  const args = splitArgs(action.content);
  return row(time, "action", name,
    `<span class="readable"><code>${escape(readableAction(name, args))}</code></span>
     <span class="exact">${exactAction}</span>`,
    `<span class="readable">${result ? escape(outcome(name, result.content)) : "no result was recorded"}</span>
     <span class="exact">${exactResult}</span>`);
}

function row(time, kindClass, label, content, result = null, rowClass = "") {
  return `<div class="event-row${result === null ? "" : " with-result"}${rowClass ? ` ${rowClass}` : ""}">
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
      current.events.push({ type: "emission", actions: [], ...event });
      continue;
    }
    if (event.kind === "reasoning") {
      const readable = readableRecordText(event.content);
      const details = current.events.findLast((one) =>
        one.type === "reasoning_details" && !one.readableDuplicate,
      );
      if (details && sameReadableReasoning(readableStructuredReasoning(details.content), readable)) {
        details.readableDuplicate = true;
      }
      current.events.push({ type: "reasoning", ...event });
      continue;
    }
    if (event.kind === "reasoning_details") {
      current.events.push({ type: "reasoning_details", ...event });
      continue;
    }
    if (event.kind === "memory" || event.kind === "shelf") {
      current.events.push({ type: event.kind, ...event });
      continue;
    }
    if (event.kind === "action") {
      const emission = current.events.findLast((one) => one.type === "emission");
      if (emission) emission.actions.push(event.content);
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

  // A new world row can exist while the provider is still answering. Keep the
  // most recent real model text open instead of replacing it with an empty
  // card. In the faculties scaffold that text is commonly an inner_speech or
  // speak_aloud action rather than prose outside the calls.
  const newestText = moments.toReversed().flatMap((moment) => moment.events.toReversed()).find((event) => {
    if (event.type === "emission") return Boolean(readableEmission(event.content, event.actions).text);
    if (event.type !== "call") return false;
    const name = event.action?.meta?.name || callName(event.action?.content);
    return ["speak", "think", "inner_speech", "speak_aloud"].includes(name)
      && splitArgs(event.action?.content).join(" ").length > 320;
  });
  if (newestText) newestText.latest = true;
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
    case "end": return "death";
    case "continue":
    case "sleep": return field("seconds")
      ? `returns after ${field("seconds")}s`
      : field("until") ? `until ${field("until")}` : firstLine(text);
    case "speak":
    case "think":
    case "inner_speech": return `recorded ${field("characters") || "?"} characters of inner speech`;
    case "speak_aloud": return `the words reached ${field("receivedBy") || "the other living agent"}`;
    case "email": return `stored local letter ${field("letter") || ""} addressed to ${field("to") || "the address"}`;
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
.event-row.with-result{grid-template-rows:auto auto}
.event-row.with-result .event-time,.event-row.with-result .event-kind{grid-row:1/3}
.event-row.with-result .event-content{grid-column:3/5;border-right:0}
.event-row.with-result .event-result{grid-column:3/5;border-top:1px dashed var(--line);border-right:0}
.message-row .event-content{padding:14px 18px 17px}
.thought summary{display:grid;grid-template-columns:18px minmax(0,1fr) auto;align-items:start;gap:10px;
  min-height:42px;padding:7px 0;list-style:none;cursor:pointer;color:var(--fg)}
.thought summary::-webkit-details-marker{display:none}
.thought summary::before{content:"›";grid-column:1;grid-row:1;align-self:start;color:var(--thought);font-size:20px;line-height:1}
.thought[open] summary::before{content:"⌄"}
.message-subject{grid-column:2;font:600 15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
.message-meta{grid-column:3;grid-row:1;color:var(--dim);font:11px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:nowrap}
.thought-text,.memory-text{max-width:88ch;margin:10px 0 2px 20px;white-space:pre-wrap;overflow-wrap:anywhere;
  font:16px/1.72 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
.reasoning-text{max-width:96ch;margin:10px 0 2px 20px;white-space:pre-wrap;overflow-wrap:anywhere;
  color:var(--dim);font:13px/1.65 ui-monospace,SFMono-Regular,Menlo,monospace}
.speech{color:var(--spoke);font-size:15px}.problem-text{color:var(--problem)}
.next-text::before{content:"○ ";color:var(--live)}
code{padding:2px 5px;background:var(--code);color:var(--fg);
  font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;
  white-space:pre-wrap;overflow-wrap:anywhere}
.exact{display:none}.exact-record{display:block;white-space:pre-wrap;color:var(--dim);
  font:11px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace}
body.exact-mode .readable{display:none}body.exact-mode .exact{display:block}
.exact-only{display:none}body.exact-mode .exact-only{display:grid}
@media(max-width:880px){
  .event-row{grid-template-columns:64px 78px minmax(0,1fr)}
  .event-row .event-content{border-right:0}
  .event-row .event-result{grid-column:3;border-top:1px dashed var(--line);border-right:0}
  .event-row.with-result .event-content,.event-row.with-result .event-result{grid-column:3}
  .event-wide{grid-column:3}.moment-number{width:64px}
  .thought summary{grid-template-columns:18px minmax(0,1fr)}.message-meta{grid-column:2;grid-row:2}
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

export function readableEmission(text, recordedActions = []) {
  let source = String(text || "");
  let calls = 0;
  for (const action of recordedActions || []) {
    const exact = String(action || "");
    if (!exact || !source.includes(exact)) continue;
    source = source.replace(exact, "");
    calls += 1;
  }
  const lines = source.split("\n").filter((line) => {
    if (/^\s*[a-z_][a-z0-9_]*\s*\(.*\)\s*$/i.test(line)) {
      calls += 1;
      return false;
    }
    return true;
  });
  const prose = readableRecordText(lines.join("\n"));
  return {
    calls,
    text: prose.replace(/\n{3,}/g, "\n\n").trim(),
  };
}

export function readableRecordText(text) {
  let source = String(text || "").replace(/^\s*```(?:html|xml)?\s*$/gim, "");
  for (let pass = 0; pass < 6; pass += 1) {
    const decoded = decodeXmlText(source);
    if (decoded === source) break;
    source = decoded;
  }
  return source
    .replace(/<\/?[a-z_][a-z0-9_.:-]*(?:\s[^<>]*?)?\s*\/?>/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function readableStructuredReasoning(text) {
  const source = String(text || "");
  try {
    const parsed = JSON.parse(source);
    const parts = [];
    const visit = (value) => {
      if (Array.isArray(value)) {
        for (const item of value) visit(item);
        return;
      }
      if (!value || typeof value !== "object") return;
      for (const key of ["text", "summary", "content"]) {
        if (typeof value[key] === "string" && value[key].trim()) parts.push(value[key]);
      }
      for (const [key, child] of Object.entries(value)) {
        if (["text", "summary", "content"].includes(key)) continue;
        if (child && typeof child === "object") visit(child);
      }
    };
    visit(parsed);
    if (parts.length) return readableRecordText([...new Set(parts)].join("\n\n"));
  } catch {
    // Some providers return reasoning details as plain text rather than JSON.
  }
  return readableRecordText(source);
}

function callName(call) {
  const text = String(call || "");
  return (text.match(/^\s*([a-z_][a-z0-9_]*)\s*\(/i)
    || text.match(/^\s*<([a-z_][a-z0-9_]*)\b/i)
    || [])[1] || "action";
}

function splitArgs(call) {
  const text = String(call || "");
  const name = callName(text);
  const parsed = parseCalls(text, [name], { decodeEntities: true })[0];
  if (parsed) return parsed.args.map((value) => String(value));
  const inside = text.slice(text.indexOf("(") + 1, text.lastIndexOf(")"));
  try {
    return JSON.parse(`[${inside}]`).map((value) => String(value));
  } catch {
    return [inside.replace(/^["'`]|["'`]$/g, "")];
  }
}

export function readableAction(name, args = []) {
  const values = args.map((value) => oneLine(value));
  const [first = "", second = "", third = "", fourth = ""] = values;
  switch (name) {
    case "run": return `run: ${first}`;
    case "feel": return `feel: ${first}${second ? ` · ${second}` : ""}`;
    case "remember": return `remember ${first || "memory"}${second ? ` [${second}]` : ""}: ${third}`;
    case "restore": return `restore: ${first}`;
    case "recall": return `recall: ${first}`;
    case "revise": return `revise ${first}: ${second}`;
    case "shelve": return `shelve: ${first}`;
    case "consolidate": return `consolidate${first ? ` ${first}` : ""}: ${second}`;
    case "intend": return `intend: ${first}${second ? ` · success: ${second}` : ""}${third ? ` · cue: ${third}` : ""}${fourth ? ` · under: ${fourth}` : ""}`;
    case "progress": return `progress ${first}: ${second}${third ? ` · next: ${third}` : ""}${fourth ? ` · cue: ${fourth}` : ""}`;
    case "resolve": return `resolve ${first}${second ? ` · ${second}` : ""}${third ? ` · ${third}` : ""}`;
    case "forget": return `forget: ${first}`;
    case "end": return "end";
    default: return values.length ? `${name}: ${values.join(" · ")}` : name;
  }
}

function decodeXmlText(value) {
  return String(value || "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

function sameReadableReasoning(left, right) {
  const normalize = (value) => String(value || "")
    .replace(/\r\n/g, "\n")
    .trim();
  const a = normalize(left);
  const b = normalize(right);
  return Boolean(a) && a === b;
}

function count(number) {
  return Number(number || 0).toLocaleString();
}

function firstLine(text) {
  return String(text || "").split("\n").map((line) => line.trim()).find(Boolean) || "";
}

function subjectOf(text, limit = 170) {
  const line = oneLine(text);
  if (!line) return "No prose";
  // Models often spend their first sentence orienting themselves: "Let me
  // understand the current state." That is not the subject of the message.
  // Look only a few sentences ahead and use the first sentence that actually
  // says something about the work. This is an extract, never an invented
  // summary, so the record still states only words the model produced.
  const sentences = line.match(/[^.!?。！？]+[.!?。！？]+|[^.!?。！？]+$/g) || [line];
  const generic = (sentence) => [
    /^let me (?:understand|parse|review|orient|take stock|think through)\b/i,
    /^(?:i am|i'm) (?:zero|one)\b(?:\s*[,.;:!?-]|\s*$)/i,
    /^where (?:we|i) (?:are|am)\b/i,
    /^the current state\b/i,
  ].some((pattern) => pattern.test(sentence.trim()));
  const subject = sentences.slice(0, 6).find((sentence) => !generic(sentence))?.trim() || sentences[0].trim();
  if (subject.length <= limit) return subject;
  const window = subject.slice(0, limit + 1);
  const ends = [...window.matchAll(/[.!?。！？](?:\s|$)/g)];
  const sentence = ends.find((match) => Number(match.index) >= 55);
  if (sentence) return window.slice(0, Number(sentence.index) + 1);
  const cut = window.lastIndexOf(" ");
  return `${window.slice(0, cut > 80 ? cut : limit).trimEnd()}…`;
}

function timeOf(value) {
  return String(value || "").slice(11, 19);
}

function gapOf(room) {
  const match = String(room).match(/^\s{2}(.+?) since the previous moment$/m);
  return match ? match[1] : "";
}
