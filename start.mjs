import path from "node:path";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Log } from "./log.mjs";
import { Body } from "./body.mjs";
import { Loop } from "./loop.mjs";
import { configFromEnv, resolveContextTokens } from "./mind.mjs";
import { loadModel } from "./model.mjs";
import { loadRun, describeRun } from "./run.mjs";
import { Observer, startPanel } from "./panel.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = process.env.AMI_DATA || path.join(here, "data");
const workspace = path.join(root, "workspace");
const port = Number(process.env.AMI_PORT || 7717);

await mkdir(workspace, { recursive: true });

const config = configFromEnv(process.env, await resolveContextTokens(process.env, loadModel()));
const log = new Log(path.join(root, "ami.sqlite"));
const observer = new Observer();

const body = new Body({
  log,
  workspace,
  onSpeak: (text) => {
    process.stdout.write(`\n  ${text}\n\n`);
    aloud(text);
  },
  // No next moment. The panel can start her again; nothing she does can.
  onEnd: () => {
    log.append("end", "she ended it", { by: "her" });
    loop.stop();
    process.stdout.write("\n  she ended it\n\n");
  },
});
// speak() is the one act of hers that happens in the room rather than on
// disk, so it is the one that should be audible. Text goes in on stdin rather
// than as an argument: no escaping, no length limit, nothing of hers mangled
// on the way to being heard.
const voice = process.env.AMI_VOICE || "Ava (Premium)";
const rate = process.env.AMI_SAY_RATE || "";
let voiceEnabled = process.env.AMI_SAY !== "0";
let saying = null;
const speechQueue = [];
function aloud(text) {
  if (!voiceEnabled) return;
  speechQueue.push(String(text || ""));
  speakNext();
}

// Audible speech is optional host output, not part of her causal record.
// When enabled, preserve its order instead of cutting one utterance off when
// another arrives.
function speakNext() {
  if (saying || !speechQueue.length) return;
  const text = speechQueue.shift();
  try {
    const child = spawn("say", ["-v", voice, ...(rate ? ["-r", rate] : [])], { stdio: ["pipe", "ignore", "ignore"] });
    saying = child;
    let finished = false;
    const next = () => {
      if (finished) return;
      finished = true;
      if (saying === child) saying = null;
      speakNext();
    };
    child.once("close", next);
    child.once("error", next);
    child.stdin.on("error", () => {
      if (!child.killed) child.kill("SIGTERM");
      next();
    });
    child.stdin.end(text);
  } catch {
    saying = null;
    speakNext();
  }
}

const audible = {
  get state() {
    return {
      enabled: voiceEnabled,
      name: voice,
      speaking: Boolean(saying),
      queued: speechQueue.length,
    };
  },
  set(enabled) {
    voiceEnabled = Boolean(enabled);
    if (!voiceEnabled) {
      speechQueue.length = 0;
      if (saying && !saying.killed) saying.kill("SIGTERM");
    } else {
      speakNext();
    }
    return this.state;
  },
};

const loop = new Loop({ log, body, config, workspace, observer });
body.loop = loop;

startPanel({
  port,
  log,
  body,
  loop,
  observer,
  workspace,
  config,
  audible,
});

process.stdout.write(`Project AA — Autonomous Agent\n\n`);
process.stdout.write(`observer  http://127.0.0.1:${port}\n`);
process.stdout.write(`model     ${config.model}\n`);
process.stdout.write(`arrival   ${config.endpoint}${config.prefill ? ` (${config.prefill})` : ""}\n`);
process.stdout.write(`context   ${config.contextTokens.toLocaleString("en-US")} tokens\n`);
process.stdout.write(`run       ${describeRun(loadRun(log))}\n`);
process.stdout.write(`voice     ${voiceEnabled ? voice : "off (AMI_SAY=0)"}\n`);
process.stdout.write(`data      ${root}\n`);
process.stdout.write(`moments   ${log.count() === 0 ? "none yet — this is the first" : log.count() + " events recorded"}\n\n`);

// Maintenance can restart the observer without accidentally creating another
// moment. This is especially important while a frozen record is being
// broadcast: the SQLite record and its derived queue must stay identical.
if (process.env.AMI_START_PAUSED === "1") {
  process.stdout.write("life      paused on start\n");
} else {
  loop.start();
}

// Being shut down is also a way for a life to end, and it was the one losing
// the most: every restart during development threw a life away silently.
let closing = false;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (closing) process.exit(0);
    closing = true;
    loop.stop();
    process.exit(0);
  });
}
