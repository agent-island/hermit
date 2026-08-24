import path from "node:path";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Log } from "./log.mjs";

// Her whole life as one file that opens with no server, no network, and no
// dependencies. Everything the observer saw live is in here: every room, every
// emission byte for byte, every call, everything that came back, every value
// change and its cause.
export function buildLife(log) {
  const events = log.since(0, 1_000_000);
  const values = log.get("values", {});
  return PAGE.replace(
    "__DATA__",
    JSON.stringify({ events, values, builtAt: new Date().toISOString() }).replace(/</g, "\\u003c"),
  );
}

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>a life</title>
<style>
:root{
  color-scheme:light;
  --surface-1:#fcfcfb; --surface-2:#f3f3f1; --line:#e2e2dd;
  --text-primary:#0b0b0b; --text-secondary:#52514e; --text-muted:#84837d;
  --s1:#2a78d6; --s2:#eb6834; --s3:#1baf7a; --s4:#eda100; --s5:#e87ba4;
  --accent:#4a3aa7; --bad:#e34948;
}
@media (prefers-color-scheme:dark){:root:where(:not([data-theme="light"])){
  color-scheme:dark;
  --surface-1:#1a1a19; --surface-2:#232322; --line:#33332f;
  --text-primary:#fff; --text-secondary:#c3c2b7; --text-muted:#8d8c83;
  --s1:#3987e5; --s2:#d95926; --s3:#199e70; --s4:#c98500; --s5:#d55181;
  --accent:#9085e9; --bad:#e66767;
}}
:root[data-theme="dark"]{
  color-scheme:dark;
  --surface-1:#1a1a19; --surface-2:#232322; --line:#33332f;
  --text-primary:#fff; --text-secondary:#c3c2b7; --text-muted:#8d8c83;
  --s1:#3987e5; --s2:#d95926; --s3:#199e70; --s4:#c98500; --s5:#d55181;
  --accent:#9085e9; --bad:#e66767;
}
*{box-sizing:border-box}
body{margin:0;background:var(--surface-1);color:var(--text-primary);
  font:14px/1.6 ui-sans-serif,-apple-system,Segoe UI,sans-serif}
.wrap{max-width:1000px;margin:0 auto;padding:32px 20px 80px}
h1{font-size:22px;margin:0 0 4px;font-weight:650;letter-spacing:-.01em}
h2{font-size:12px;letter-spacing:.09em;text-transform:uppercase;color:var(--text-muted);
  font-weight:600;margin:36px 0 12px}
.sub{color:var(--text-secondary);margin:0 0 26px;font-size:13px}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px;margin-bottom:8px}
.tile{background:var(--surface-2);border:1px solid var(--line);border-radius:8px;padding:12px 14px}
.tile b{display:block;font-size:22px;font-weight:650;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.tile span{font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:.06em}
.card{background:var(--surface-2);border:1px solid var(--line);border-radius:10px;padding:16px}
figure{margin:0}
figcaption{font-size:12px;color:var(--text-secondary);margin-bottom:10px}
.legend{display:flex;flex-wrap:wrap;gap:14px;margin-top:10px;font-size:12px;color:var(--text-secondary)}
.legend i{width:9px;height:9px;border-radius:2px;display:inline-block;margin-right:5px;vertical-align:-1px}
.chart{width:100%;overflow-x:auto}
svg{display:block;max-width:100%}
.tip{position:fixed;pointer-events:none;background:var(--surface-1);border:1px solid var(--line);
  border-radius:7px;padding:8px 10px;font-size:12px;box-shadow:0 6px 22px #0003;opacity:0;
  transition:opacity .1s;z-index:9;font-variant-numeric:tabular-nums}
.tip div{display:flex;justify-content:space-between;gap:16px}
.tip b{font-weight:600}
.bar{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:14px;position:sticky;top:0;
  background:var(--surface-1);padding:10px 0;z-index:5;border-bottom:1px solid var(--line)}
button{font:inherit;font-size:12px;padding:5px 11px;border-radius:999px;cursor:pointer;
  border:1px solid var(--line);background:var(--surface-2);color:var(--text-secondary)}
button.on{background:var(--text-primary);color:var(--surface-1);border-color:var(--text-primary)}
input[type=search]{flex:1;min-width:160px;font:inherit;font-size:12px;padding:5px 11px;
  border-radius:999px;border:1px solid var(--line);background:var(--surface-2);color:var(--text-primary)}
.moment{border:1px solid var(--line);border-radius:10px;margin-bottom:14px;overflow:hidden}
.mhead{display:flex;justify-content:space-between;gap:12px;padding:10px 14px;
  background:var(--surface-2);font-size:12px;color:var(--text-secondary);align-items:center}
.mhead b{color:var(--text-primary);font-weight:600}
.ev{padding:10px 14px;border-top:1px solid var(--line)}
.ev .lab{font-size:10px;letter-spacing:.09em;text-transform:uppercase;color:var(--text-muted);
  font-weight:600;margin-bottom:5px}
pre{margin:0;white-space:pre-wrap;word-break:break-word;font:12px/1.55 ui-monospace,Menlo,monospace}
.ev-emission{border-left:3px solid var(--accent)}
.ev-emission pre{color:var(--text-primary)}
.ev-action{border-left:3px solid var(--s3)}
.ev-action pre{color:var(--s3);font-weight:600}
.ev-result pre,.ev-body pre,.ev-sleep pre,.ev-shelf pre{color:var(--text-secondary)}
.ev-memory{border-left:3px solid var(--s3)}
.ev-incoming{border-left:3px solid var(--s4)}
.ev-error,.ev-echo{border-left:3px solid var(--bad)}
.ev-error pre{color:var(--bad)}
.ev-world pre,.ev-echo pre{color:var(--text-muted)}
details summary{cursor:pointer;font-size:11px;color:var(--text-muted);
  text-transform:uppercase;letter-spacing:.09em;font-weight:600}
details[open] summary{margin-bottom:6px}
table{border-collapse:collapse;width:100%;font-size:12px}
th,td{text-align:left;padding:6px 10px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--text-muted);font-weight:600;text-transform:uppercase;font-size:10px;letter-spacing:.08em}
td.c{font-family:ui-monospace,Menlo,monospace;white-space:pre-wrap;word-break:break-word;max-width:620px}
.empty{color:var(--text-muted);padding:26px 0;text-align:center}
</style></head><body>
<div class="wrap">
  <h1>a life</h1>
  <p class="sub" id="sub"></p>
  <div class="tiles" id="tiles"></div>

  <h2>every moment</h2>
  <div class="bar" id="bar"></div>
  <div id="feed"></div>

  <h2>every event</h2>
  <div class="card" style="overflow-x:auto"><table id="table"></table></div>
</div>
<div class="tip" id="tip"></div>
<script>
const DATA = __DATA__;
const esc = s => String(s).replace(/[&<>]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;"}[c]));
const clock = a => a.slice(11,19);

/* ---------- tiles ---------- */
const ev = DATA.events;
const first = ev[0], last = ev[ev.length-1];
const moments = ev.filter(e=>e.kind==="world").length;
const calls = ev.filter(e=>e.kind==="action").length;
const thought = ev.filter(e=>e.kind==="action"&&(e.meta.name==="speak"||e.meta.name==="think")).length;
const spoke = ev.filter(e=>e.kind==="action"&&e.meta.name==="speak_aloud").length;
const alive = first&&last ? (new Date(last.at)-new Date(first.at))/1000 : 0;
const dur = s => s<60?Math.round(s)+"s":s<3600?Math.round(s/60)+"m":(s/3600).toFixed(1)+"h";
document.getElementById("sub").textContent = first
  ? "born "+first.at.replace("T"," ").slice(0,19)+"Z · "+ev.length+" events recorded, nothing edited or removed"
  : "nothing has happened yet";
document.getElementById("tiles").innerHTML = [
  [moments,"moments"],[calls,"calls made"],[thought,"inner thoughts"],[spoke,"times spoke aloud"],
  [ev.filter(e=>e.kind==="incoming").length,"spoken to"],
  [ev.filter(e=>e.kind==="echo").length,"rooms echoed"],
  [ev.filter(e=>e.kind==="action"&&e.meta.name==="write").length,"things made"],
  [dur(alive),"alive for"],
].map(([v,k])=>'<div class="tile"><b>'+v+'</b><span>'+k+'</span></div>').join("");

/* ---------- moments ---------- */
const KINDS=["world","reasoning","reasoning_details","emission","echo","action","result","incoming","memory","shelf","body","sleep","error","api","end"];
const hidden=new Set(["world","api"]);
let needle="";
const bar=document.getElementById("bar");
bar.innerHTML='<input type="search" id="q" placeholder="search everything she ever emitted">'
  +KINDS.map(k=>'<button data-k="'+k+'" class="'+(hidden.has(k)?"":"on")+'">'+k+'</button>').join("");
bar.addEventListener("click",e=>{const b=e.target.closest("button");if(!b)return;
  const k=b.dataset.k; hidden.has(k)?hidden.delete(k):hidden.add(k); b.classList.toggle("on"); render();});
document.getElementById("q").addEventListener("input",e=>{needle=e.target.value.toLowerCase();render();});

const groups=[]; let cur=null;
for(const e of ev){ if(e.kind==="world"||!cur){cur={world:e.kind==="world"?e:null,events:[],at:e.at};groups.push(cur);}
  if(e.kind!=="world") cur.events.push(e); }

function render(){
  const feed=document.getElementById("feed"); let out="";
  groups.forEach((g,i)=>{
    const all=(g.world?[g.world]:[]).concat(g.events);
    const shown=all.filter(e=>!hidden.has(e.kind)&&(!needle||e.content.toLowerCase().includes(needle)));
    if(!shown.length)return;
    const em=g.events.find(e=>e.kind==="emission");
    out+='<div class="moment"><div class="mhead"><b>moment '+(i+1)+'</b><span>'+g.at.replace("T"," ").slice(0,19)+'Z · '
      +(em?em.content.trim().split(/\\s+/).length+" words":"nothing emitted")+'</span></div>';
    for(const e of shown){
      const long=e.kind==="world"||e.kind==="echo"||e.content.length>900;
      out+='<div class="ev ev-'+e.kind+'"><div class="lab">'+e.kind
        +(e.meta&&e.meta.cause?" · "+esc(e.meta.cause):"")
        +(e.meta&&e.meta.usage?" · "+e.meta.usage.total_tokens+" tokens":"")+'</div>';
      out+= long ? '<details><summary>'+e.content.length+' characters</summary><pre>'+esc(e.content)+'</pre></details>'
                 : '<pre>'+esc(e.content)+'</pre>';
      out+='</div>';}
    out+='</div>';});
  feed.innerHTML=out||'<p class="empty">nothing matches</p>';
}
render();

/* ---------- table ---------- */
document.getElementById("table").innerHTML='<thead><tr><th>at</th><th>kind</th><th>content</th></tr></thead><tbody>'
  +ev.map(e=>'<tr><td>'+clock(e.at)+'</td><td>'+e.kind+'</td><td class="c">'+esc(e.content.slice(0,1500))+'</td></tr>').join("")
  +'</tbody>';
</script></body></html>`;

// Run directly to write the file; imported by the panel to serve it live.
if (import.meta.url === `file://${process.argv[1]}`) {
  const root = process.env.AMI_DATA || path.join(path.dirname(fileURLToPath(import.meta.url)), "data");
  const out = process.argv[2] || path.join(root, "life.html");
  const log = new Log(path.join(root, "ami.sqlite"));
  await writeFile(out, buildLife(log), "utf8");
  const { buildMarkdown } = await import("./markdown.mjs");
  await writeFile(out.replace(/\.html$/, ".md"), buildMarkdown(log), "utf8");
  process.stdout.write(`${out}\n`);
}
