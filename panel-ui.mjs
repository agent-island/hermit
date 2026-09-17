// The observer is one compact instrument. The record remains the large surface;
// live context stays visible beside it, while editing and endings have their own
// views so they cannot compete with reading a continuation.
import { LOG_CSS } from "./plain.mjs";

export function renderPage({
  log,
  eventTotal = 0,
  state,
  setup,
  scaffold = "",
  model,
  arrival,
  mind = {},
  letters = 0,
  world = "",
  runtime = {},
  voice = {},
  fullResetRequired = false,
}) {
  const status = state.awake
    ? "continuing"
    : state.paused
      ? "paused"
      : state.next
        ? `waiting · next ${clock(state.next)}`
        : "waiting";
  const stateAction = state.paused
    ? '<button class="control" data-post="/resume">Resume</button>'
    : '<button class="control" data-post="/pause">Pause</button>';
  const voiceName = voice.enabled ? shortVoice(voice.name) : "voice off";
  const age = lifeAge(runtime.born);
  const attention = attentionFacts(world);
  const newLifeControl = fullResetRequired
    ? `<div class="action-row divided">
                <div><b>Begin a new paired life</b><p class="dim">A paired life requires a complete VM rebuild. Run <code>./restart-new-lives.sh</code> from the two-agents directory.</p></div>
                <span class="control disabled" aria-disabled="true">Full-machine launcher only</span>
              </div>`
    : `<div class="action-row divided">
                <div><b>Begin a new life</b><p class="dim">Clear the record and workspace, then start.</p></div>
                <button class="control danger" data-post="/reset" data-confirm="Archive this life and begin a new one?">Archive and begin</button>
              </div>`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Hermit</title><style>${LOG_CSS}${PANEL_CSS}</style></head>
<body>
<header class="topbar">
  <div class="identity"><b>Hermit</b><span class="live ${state.awake ? "awake" : ""}"></span><span class="status">${escape(status)}</span></div>
  <nav aria-label="Observer sections">
    <button class="tab active" type="button" data-tab="record" aria-selected="true">Record</button>
    <button class="tab" type="button" data-tab="scaffold" aria-selected="false">Scaffold</button>
    <button class="tab" type="button" data-tab="lives" aria-selected="false">Lives</button>
  </nav>
  <div class="top-actions">
    <span class="mechanics">${escape(model)} · ${escape(arrival)}</span>
    <button class="control voice-control ${voice.enabled ? "on" : ""}" id="voice-toggle" type="button"
      aria-pressed="${voice.enabled ? "true" : "false"}">${escape(voiceName)}</button>
    ${stateAction}
  </div>
</header>

<div class="observer">
  <div class="main-surface">
    <section class="view active" id="view-record">
      <div class="view-tools">
        <b>${log.total} continuations</b>
        <span class="dim">· ${Number(eventTotal).toLocaleString()} events · newest first · showing ${log.shown || 0} · complete actions and results</span>
        <span class="grow"></span>
        <button class="new-activity" id="new-activity" type="button" role="status" hidden>New activity · show</button>
        <button class="control" id="record-width" type="button" aria-pressed="true">Show context</button>
        <div class="mode-switch" aria-label="Record detail">
          <button class="mode active" type="button" data-mode="readable" aria-pressed="true">Readable</button>
          <button class="mode" type="button" data-mode="exact" aria-pressed="false">Exact</button>
        </div>
      </div>
      <main class="record">${log.html}</main>
    </section>

    <section class="view" id="view-scaffold" hidden>
      <div class="view-tools"><b>Scaffold</b><span class="dim">· exact model-facing structure</span></div>
      <main class="compact-page two-columns">
        <div>
          <section class="panel-section">
            <header><b>Complete scaffold</b><span class="dim"> · current faculties expanded</span></header>
            <div class="panel-body">
              <textarea id="scaffold-document" class="scaffold-document" spellcheck="false" rows="34" readonly>${escape(scaffold || setup.template)}</textarea>
            </div>
          </section>

          <section class="panel-section">
            <header><b>Structure</b><span class="dim"> · editable; faculties expand at runtime</span></header>
            <div class="panel-body">
              <textarea id="template" spellcheck="false" rows="18">${escape(setup.template)}</textarea>
              <div class="actions">
                <button class="control primary" id="save-scaffold" type="button">Save structure</button>
                <span id="scaffold-result" class="dim"></span>
              </div>
            </div>
          </section>

          <section class="panel-section">
            <header><b>Last state sent to the model</b><span class="dim"> · exact</span></header>
            <details class="world-document">
              <summary>${world ? "Complete state · expand" : "No continuation yet"}</summary>
              <pre>${escape(world || "No state has been assembled.")}</pre>
            </details>
          </section>
        </div>

        <div>
          <section class="panel-section">
            <header><b>Mind</b><span class="dim"> · machine-local; she never sees this</span></header>
            <div class="panel-body">
              <label for="arrival">Arrival</label>
              <select id="arrival">
                ${["prefix", "completions"]
                  .map((key) => `<option value="${key}"${key === setup.arrival ? " selected" : ""}>${ARRIVAL[key]}</option>`)
                  .join("")}
              </select>
              <label for="base-url">Endpoint</label>
              <input id="base-url" class="control-field" value="${escape(mind.baseUrl || "")}" placeholder="https://openrouter.ai/api/v1" autocomplete="off">
              <label for="api-key">Key ${mind.apiKeySet ? `<span class="dim">· saved ${escape(mind.apiKeyHint)} · ${escape(mind.source)}</span>` : '<span class="dim">· none saved</span>'}</label>
              <input id="api-key" class="control-field" type="password" value="" placeholder="leave blank to keep the current key" autocomplete="off">
              <div class="field-pair">
                <div><label for="model-name">Model</label><input id="model-name" class="control-field" value="${escape(mind.model || "")}" placeholder="vendor/model" autocomplete="off"></div>
                <div><label for="temperature">Temperature</label><input id="temperature" class="control-field" value="${escape(String(mind.temperature ?? ""))}" placeholder="1" autocomplete="off"></div>
              </div>
              <div class="actions">
                <button class="control" id="probe-model" type="button">Test compatibility</button>
                <button class="control primary" id="save-model" type="button">Save</button>
                <span id="probe-result" class="dim"></span>
              </div>
            </div>
          </section>

          <section class="panel-section">
            <header><b>Letters</b><span class="dim"> · ${letters} written</span></header>
            <div class="panel-body">
              <p class="dim people-note">Letters she has written to addresses she found. None of them were sent
                anywhere — there is no mail server. They are kept here and carried to the timeline.</p>
              <div id="letters" class="dim">${letters ? "loading…" : "None yet."}</div>
            </div>
          </section>

        </div>
      </main>
    </section>

    <section class="view" id="view-lives" hidden>
      <div class="view-tools"><b>Lives</b><span class="dim">· preservation and irreversible changes</span></div>
      <div class="life-summary">
        <b>Current · ${escape(age)}</b><span>${log.total} continuations</span><span>${Number(eventTotal).toLocaleString()} events</span>
        <span class="grow"></span>
        <a class="control" href="/life.html">Life HTML</a>
        <a class="control" href="/life.md" target="_blank">Markdown</a>
      </div>
      <main class="compact-page two-columns lives-grid">
        <div>
          <section class="panel-section">
            <header><b>Rewind and replay</b><span class="dim"> · the life after the point is removed</span></header>
            <div id="points" class="table-wrap dim">loading…</div>
          </section>
        </div>
        <div>
          <section class="panel-section">
            <header><b>Loop</b></header>
            <div class="panel-body action-row">
              <div><b>Restart from here</b><p class="dim">Restart the process at the present state without changing the record.</p></div>
              <button class="control" data-post="/restart">Restart</button>
            </div>
          </section>
          <section class="panel-section danger-zone">
            <header><b>Endings</b><span class="dim"> · nothing is kept automatically</span></header>
            <div class="panel-body">
              <div class="action-row">
                <div><b>End this life</b><p class="dim">Stop permanently and keep it readable.</p></div>
                <button class="control danger" data-post="/end" data-confirm="End this life? She stops permanently.">End</button>
              </div>
              ${newLifeControl}
            </div>
          </section>
        </div>
      </main>
    </section>
  </div>

  <aside class="context-rail" aria-label="Live agent context">
    <section class="rail-section">
      <b>Speak into the room</b>
      <form id="say" class="say">
        <input name="text" placeholder="She sees this next continuation" autocomplete="off">
        <button class="control primary">Say</button>
      </form>
    </section>

    <section class="rail-section">
      <div class="rail-title"><b>Now</b><span class="${state.paused ? "dim" : "good"}">${state.paused ? "paused" : state.awake ? "continuing" : "running"}</span></div>
      <dl class="facts">
        <div><dt>Next</dt><dd>${state.next ? `${clock(state.next)} · ${until(state.next)}` : state.paused ? "held" : "none"}</dd></div>
        <div><dt>Voice</dt><dd id="voice-state">${escape(voiceName)}${voice.speaking ? " · speaking" : voice.queued ? ` · ${voice.queued} queued` : ""}</dd></div>
        <div><dt>Mind</dt><dd>${escape(model)} · ${escape(arrival)}</dd></div>
      </dl>
    </section>

    <section class="rail-section">
      <div class="rail-title"><b>Scaffold</b><button class="text-link" type="button" data-go="scaffold">audit</button></div>
      <dl class="facts">
        <div><dt>State</dt><dd>${world ? `${world.length.toLocaleString()} characters` : "not assembled"}</dd></div>
        <div><dt>${runtime.machine ? "Machine" : "Workspace"}</dt><dd>${runtime.machine ? `workstation · ${Number(runtime.files) || 0} in ~` : `${Number(runtime.files) || 0} files`}</dd></div>
        <div><dt>Actions</dt><dd>${Number(runtime.affordances) || 0}</dd></div>
        <div><dt>Attention</dt><dd>${attention ? `${escape(attention.maintained)} maintained · ${escape(attention.remains)} remains` : "not recorded"}</dd></div>
      </dl>
    </section>

    <section class="rail-section">
      <div class="rail-title"><b>Life</b><button class="text-link" type="button" data-go="lives">manage</button></div>
      <dl class="facts">
        <div><dt>Age</dt><dd>${escape(age)}</dd></div>
        <div><dt>Record</dt><dd>${log.total} continuations · ${Number(eventTotal).toLocaleString()} events</dd></div>
      </dl>
      <div class="rail-actions">
        <button class="control" data-post="/save">Save copy</button>
        <a class="control" href="/life.html">Life HTML</a>
      </div>
    </section>
  </aside>
</div>

<script>
const views = [...document.querySelectorAll(".view")];
const tabs = [...document.querySelectorAll("[data-tab]")];
const newActivity = document.getElementById("new-activity");
const recordWidth = document.getElementById("record-width");
let seenEventTotal = ${Number(eventTotal) || 0};
let wideRecord = sessionStorage.getItem("ami-record-width") !== "compact";

function applyRecordWidth() {
  const recordActive = !document.getElementById("view-record").hidden;
  document.body.classList.toggle("record-focus", recordActive && wideRecord);
  recordWidth.setAttribute("aria-pressed", String(wideRecord));
  recordWidth.textContent = wideRecord ? "Show context" : "Widen messages";
}

function showView(name) {
  for (const view of views) {
    const active = view.id === "view-" + name;
    view.hidden = !active;
    view.classList.toggle("active", active);
  }
  for (const tab of tabs) {
    const active = tab.dataset.tab === name;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", String(active));
  }
  sessionStorage.setItem("ami-view", name);
  applyRecordWidth();
}
for (const tab of tabs) tab.onclick = () => showView(tab.dataset.tab);
for (const link of document.querySelectorAll("[data-go]")) link.onclick = () => showView(link.dataset.go);
const storedView = sessionStorage.getItem("ami-view");
showView(storedView === "room" ? "scaffold" : storedView || "record");

function showMode(name) {
  document.body.classList.toggle("exact-mode", name === "exact");
  for (const mode of document.querySelectorAll("[data-mode]")) {
    const active = mode.dataset.mode === name;
    mode.classList.toggle("active", active);
    mode.setAttribute("aria-pressed", String(active));
  }
  sessionStorage.setItem("ami-mode", name);
}
for (const mode of document.querySelectorAll("[data-mode]")) mode.onclick = () => showMode(mode.dataset.mode);
showMode(sessionStorage.getItem("ami-mode") || "readable");

recordWidth.onclick = () => {
  wideRecord = !wideRecord;
  sessionStorage.setItem("ami-record-width", wideRecord ? "wide" : "compact");
  applyRecordWidth();
};

document.getElementById("say").onsubmit = async (event) => {
  event.preventDefault();
  const field = event.target.text;
  if (!field.value.trim()) return;
  await fetch("/say", { method: "POST", body: field.value });
  field.value = "";
  showView("record");
  location.reload();
};

for (const button of document.querySelectorAll("[data-post]")) {
  button.onclick = async () => {
    if (button.dataset.confirm && !confirm(button.dataset.confirm)) return;
    button.disabled = true;
    await fetch(button.dataset.post, { method: "POST" });
    location.reload();
  };
}

document.getElementById("voice-toggle").onclick = async (event) => {
  const button = event.currentTarget;
  const enabled = button.getAttribute("aria-pressed") !== "true";
  button.disabled = true;
  try {
    const state = await fetch("/voice", {
      method: "POST",
      body: JSON.stringify({ enabled }),
    }).then((response) => response.json());
    button.setAttribute("aria-pressed", String(state.enabled));
    button.classList.toggle("on", state.enabled);
    button.textContent = state.enabled ? shortVoice(state.name) : "voice off";
    document.getElementById("voice-state").textContent = button.textContent;
  } finally {
    button.disabled = false;
  }
};

const mindFields = () => ({
  baseUrl: document.getElementById("base-url").value.trim(),
  apiKey: document.getElementById("api-key").value.trim(),
  model: document.getElementById("model-name").value.trim(),
  temperature: document.getElementById("temperature").value.trim(),
});

document.getElementById("probe-model").onclick = async (event) => {
  const out = document.getElementById("probe-result");
  event.target.disabled = true;
  out.textContent = "testing…";
  try {
    const r = await fetch("/model/probe", { method: "POST", body: JSON.stringify(mindFields()) }).then((response) => response.json());
    out.textContent = (r.ok ? "✓ " : "✗ ") + r.note + (r.continued ? " · " + r.continued : "");
    out.className = r.ok ? "good" : "problem";
  } catch (error) {
    out.textContent = String(error.message);
    out.className = "problem";
  }
  event.target.disabled = false;
};

document.getElementById("save-model").onclick = async () => {
  const r = await fetch("/model", { method: "POST", body: JSON.stringify(mindFields()) }).then((response) => response.json());
  if (r.error) {
    const out = document.getElementById("probe-result");
    out.textContent = r.error;
    out.className = "problem";
    return;
  }
  location.reload();
};

document.getElementById("save-scaffold").onclick = async () => {
  const out = document.getElementById("scaffold-result");
  await fetch("/setup", { method: "POST", body: JSON.stringify({
    template: document.getElementById("template").value,
    arrival: document.getElementById("arrival").value,
  })});
  out.textContent = "saved";
  location.reload();
};

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;"
  })[character]);
}

function stamp(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value || "") : date.toLocaleString([], {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

fetch("/letters").then((response) => response.json()).then((data) => {
  const box = document.getElementById("letters");
  if (!box || !data.letters.length) return;
  box.innerHTML = data.letters.map((one) =>
    '<div class="letter"><b>' + esc(one.to) + '</b>'
    + (one.subject ? ' <span class="dim">' + esc(one.subject) + '</span>' : "")
    + '<pre>' + esc(one.body) + '</pre></div>').join("");
}).catch(() => {});

fetch("/points").then((response) => response.json()).then((data) => {
  const rows = (data.points || []).slice(0, 20);
  document.getElementById("points").innerHTML = rows.length
    ? '<table><thead><tr><th>Continuation</th><th>First line</th><th>Actions</th><th></th></tr></thead><tbody>'
      + rows.map((one, index) => '<tr><td>' + escapeHtml(String(rows.length - index)) + " · " + escapeHtml(stamp(one.at))
        + '</td><td>' + escapeHtml(one.line || "nothing emitted") + '</td><td>'
        + escapeHtml((one.calls || []).join(" · ") || "none") + '</td><td><button class="control rewind" data-id="'
        + Number(one.id) + '">Rewind</button></td></tr>').join("")
      + "</tbody></table>"
    : "No continuations yet.";
  for (const button of document.querySelectorAll(".rewind")) {
    button.onclick = async () => {
      if (!confirm("Keep a copy, remove everything after this continuation, rebuild the workspace, and run it again?")) return;
      button.disabled = true;
      await fetch("/rewind", { method: "POST", body: JSON.stringify({ toId: Number(button.dataset.id) }) });
      sessionStorage.setItem("ami-view", "record");
      location.reload();
    };
  }
}).catch(() => { document.getElementById("points").textContent = "could not load"; });

newActivity.onclick = () => {
  sessionStorage.setItem("ami-view", "record");
  location.reload();
};

async function checkForActivity() {
  try {
    const response = await fetch("/events?tail=1&limit=1");
    const data = await response.json();
    if (Number(data.total) > seenEventTotal) {
      const added = Number(data.total) - seenEventTotal;
      newActivity.textContent = added === 1 ? "1 new · show" : added + " new · show";
      newActivity.hidden = false;
    }
  } catch {}
}
setInterval(checkForActivity, 4000);

function shortVoice(value) {
  return String(value || "voice").replace(/\\s*\\(.*?\\)\\s*$/, "");
}
</script>
</body></html>`;
}

const ARRIVAL = {
  prefix: "Continue text · works with most models",
  completions: "Plain document · fewer models support this",
};

const PANEL_CSS = `
.letter{padding:10px 0;border-top:1px solid var(--line)}
.letter pre{white-space:pre-wrap;overflow-wrap:anywhere;margin:6px 0 0;color:var(--fg);
  font:12.5px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace}
body{min-height:100vh;overflow-x:hidden}
.topbar{height:48px;display:grid;grid-template-columns:minmax(230px,1fr) auto minmax(350px,1fr);
  align-items:stretch;padding:0 14px;background:var(--chrome);border-bottom:1px solid var(--line);
  position:sticky;top:0;z-index:5}
.identity,.top-actions,nav,.view-tools,.mode-switch,.say,.actions,.rail-title,.life-summary,.action-row{
  display:flex;align-items:center}
.identity{gap:7px;min-width:0}.status{color:var(--dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.live{width:8px;height:8px;border-radius:50%;background:var(--live);box-shadow:0 0 0 3px #183326}
.live.awake{box-shadow:0 0 10px var(--live)}
nav{align-self:stretch;gap:23px}.tab{height:48px;border:0;border-bottom:2px solid transparent;background:transparent;
  color:var(--dim);font:inherit;cursor:pointer}.tab.active{color:var(--fg);border-bottom-color:var(--fg)}
.top-actions{justify-content:flex-end;gap:8px;min-width:0}.mechanics{color:var(--dim);
  font:11px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:nowrap}
.control{display:inline-flex;align-items:center;justify-content:center;gap:5px;min-height:29px;
  border:1px solid var(--line2);border-radius:3px;background:transparent;color:var(--fg);
  padding:4px 9px;font:inherit;text-decoration:none;cursor:pointer;white-space:nowrap}
.control:hover{background:var(--alt)}.control.primary{background:var(--fg);color:var(--chrome);border-color:var(--fg)}
.control:disabled{opacity:.5}.voice-control.on::before{content:"";width:7px;height:7px;border-radius:50%;background:var(--live)}
.observer{display:grid;grid-template-columns:minmax(0,1fr) 292px;min-height:calc(100vh - 48px)}
.record-focus .observer{grid-template-columns:minmax(0,1fr)}.record-focus .context-rail{display:none}
.main-surface{min-width:0;border-right:1px solid var(--line)}.view[hidden]{display:none}
.view-tools{min-height:39px;padding:0 12px;gap:7px;background:var(--chrome);border-bottom:1px solid var(--line);
  position:sticky;top:48px;z-index:4}.grow{flex:1}.new-activity{border:0;background:transparent;
  color:var(--live);padding:4px 6px;font:inherit;cursor:pointer}.new-activity[hidden]{display:none}
.mode-switch{border:1px solid var(--line)}.mode{border:0;border-right:1px solid var(--line);
  background:var(--alt);color:var(--dim);padding:4px 8px;font:inherit;cursor:pointer}
.mode:last-child{border-right:0}.mode.active{background:var(--row);color:var(--fg)}
.record{max-width:none;margin:0;padding:9px 10px 12px}.moment{margin:0 0 8px}.moment-head{min-height:35px}
.moment-number{width:70px}.moment-title{padding:0 10px}.moment-meta{padding:0 10px}
.event-row{grid-template-columns:70px 84px minmax(0,1fr) 210px;min-height:36px}
.event-time,.event-kind,.event-content,.event-result{padding:7px 8px}.event-time,.event-kind{white-space:nowrap}
.message-row .event-content{padding:9px 10px 11px}
.thought summary{min-height:34px;padding:4px 0}
.thought-text,.memory-text{max-width:92ch;margin:7px 0 2px 0;font:15px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
.reasoning-text{max-width:100ch;margin:7px 0 2px 0;font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace}
.latest-mark{margin-right:8px}.context-rail{background:var(--chrome)}
.rail-section{padding:11px 12px;border-bottom:1px solid var(--line)}.rail-title{justify-content:space-between;gap:8px;margin-bottom:7px}
.say{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:6px;margin-top:7px}.say input,
select,textarea,.control-field{width:100%;min-width:0;border:1px solid var(--line2);border-radius:3px;
  background:var(--row);color:var(--fg);padding:6px 8px;font:inherit}
.facts{margin:0;padding:0}.facts>div{display:grid;grid-template-columns:78px minmax(0,1fr);gap:7px;padding:4px 0}
.facts dt{color:var(--dim)}.facts dd{margin:0;min-width:0;overflow-wrap:anywhere}
.good{color:var(--live)}.good::before{content:"";display:inline-block;width:6px;height:6px;border-radius:50%;
  background:currentColor;margin-right:5px;vertical-align:1px}.problem{color:var(--problem)}
.text-link{border:0;padding:0;background:transparent;color:var(--dim);font:inherit;font-size:12px;
  text-decoration:underline;text-underline-offset:3px;cursor:pointer}.rail-actions{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:8px}
.compact-page{padding:10px}.two-columns{display:grid;grid-template-columns:minmax(0,1.18fr) minmax(310px,.82fr);gap:9px;align-items:start}
.panel-section{border:1px solid var(--line);background:var(--row)}.panel-section+.panel-section{margin-top:9px}
.panel-section>header{min-height:38px;padding:8px 10px;border-bottom:1px solid var(--line);background:var(--alt)}
.panel-body{padding:9px 10px}.panel-body label{display:block;margin:8px 0 4px;color:var(--dim);font-size:12px}
.panel-body label:first-child{margin-top:0}.field-pair{display:grid;grid-template-columns:1fr 1fr;gap:7px}
textarea{resize:vertical;font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}
.scaffold-document{min-height:560px;resize:vertical;background:var(--chrome)}
.actions{gap:6px;margin-top:8px;flex-wrap:wrap}.people-note{margin:0 0 7px}
.world-document{padding:8px 10px}.world-document summary{cursor:pointer;color:var(--dim)}
.world-document pre{max-height:420px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;
  font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}
.life-summary{min-height:47px;padding:7px 10px;gap:16px;flex-wrap:wrap;border-bottom:1px solid var(--line);background:var(--row)}
.lives-grid{grid-template-columns:minmax(0,1.25fr) minmax(290px,.75fr)}
.table-wrap{overflow:auto}table{width:100%;border-collapse:collapse}th,td{padding:7px 8px;border-bottom:1px solid var(--line);
  text-align:left;vertical-align:middle}th{color:var(--dim);font-size:12px;font-weight:400}
tr:last-child td{border-bottom:0}td:last-child{text-align:right}td:nth-child(2){max-width:340px;overflow:hidden;text-overflow:ellipsis}
table a{color:var(--fg);text-underline-offset:3px}.action-row{justify-content:space-between;gap:12px}
.action-row p{margin:2px 0 0}.action-row.divided{margin-top:10px;padding-top:10px;border-top:1px solid var(--line)}
.danger-zone>header,.danger-zone>.panel-body>b{color:var(--problem)}.control.danger{color:var(--problem);border-color:#6b3734}
@media(max-width:1000px){
  .observer{grid-template-columns:minmax(0,1fr) 240px}.event-row{grid-template-columns:64px 78px minmax(0,1fr)}
  .event-row .event-content{border-right:0}.event-row .event-result{grid-column:3;border-top:1px dashed var(--line);border-right:0}
  .event-wide{grid-column:3}.moment-number{width:64px}.two-columns{grid-template-columns:1fr}.top-actions .mechanics{display:none}
}
@media(max-width:760px){
  .topbar{height:auto;position:static;grid-template-columns:1fr auto;padding-top:6px}.top-actions{display:none}
  .identity{min-height:30px}.topbar nav{grid-column:1/-1;min-height:40px}.tab{height:40px}
  .observer{grid-template-columns:1fr;min-height:0}.main-surface{border-right:0}.context-rail{border-top:1px solid var(--line)}
  .view-tools{top:0}.view-tools>.dim{display:none}.field-pair{grid-template-columns:1fr}.life-summary{gap:8px}
}
`;

function attentionFacts(world) {
  const block = String(world || "").match(/(?:^|\n)MEMORY\n((?:  .*\n?)*)/)?.[1] || "";
  const maintained = block.match(/^  maintained:\s*(.+)$/m)?.[1];
  const remains = block.match(/^  remains:\s*(.+)$/m)?.[1];
  return maintained && remains ? { maintained, remains } : null;
}

function escape(text) {
  return String(text ?? "").replace(/[&<>"]/g, (character) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character],
  );
}

function clock(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? String(value || "")
    : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function until(value) {
  const seconds = Math.max(0, Math.round((new Date(value).getTime() - Date.now()) / 1000));
  return duration(seconds);
}

function duration(seconds) {
  const amount = Math.max(0, Number(seconds) || 0);
  if (amount < 60) return `${Math.round(amount)}s`;
  if (amount < 3600) return `${Math.floor(amount / 60)}m ${Math.round(amount % 60)}s`;
  return `${Math.floor(amount / 3600)}h ${Math.round((amount % 3600) / 60)}m`;
}

function lifeAge(born) {
  if (!born) return "not born yet";
  return duration((Date.now() - new Date(born).getTime()) / 1000);
}

function shortVoice(value) {
  return String(value || "voice").replace(/\s*\(.*?\)\s*$/, "");
}
