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
import { archiveLife } from "./archive.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = process.env.AMI_DATA || path.join(here, "data");
const workspace = path.join(root, "workspace");
const port = Number(process.env.AMI_PORT || 7717);

await mkdir(workspace, { recursive: true });

const config = configFromEnv(process.env, await resolveContextTokens(process.env, loadModel()));
const log = new Log(path.join(root, "ami.sqlite"));
const observer = new Observer();

// Every path that ends or replaces a life comes through this queue. The caller
// may be the model, the observer, a signal, or a future launcher; none has to
// remember the archive protocol. A failed archive rejects the destructive
// operation that was waiting for it, while the live database remains intact.
let archiveQueue = Promise.resolve(null);
let archivedThrough = 0;
function preserveStoppedLife(reason) {
  archiveQueue = archiveQueue.catch(() => null).then(async () => {
    const latest = Number(
      log.db.prepare("SELECT id FROM events ORDER BY id DESC LIMIT 1").get()?.id || 0,
    );
    if (!latest || latest <= archivedThrough) return null;
    const saved = await archiveLife(log, {
      archiveDir: process.env.AMI_ARCHIVE_DIR || path.join(here, "archive"),
      reason,
      label: process.env.AMI_ARCHIVE_LABEL || path.basename(root),
    });
    archivedThrough = latest;
    if (saved) {
      process.stdout.write(
        `archive   ${saved.base}\nreasoning ${saved.reasoningEvents} records saved\n`,
      );
    }
    return saved;
  });
  return archiveQueue;
}

const body = new Body({
  log,
  workspace,
  onThink: (text) => {
    process.stdout.write(`\n  ${text}\n\n`);
  },
  onSpeakAloud: async (text) => {
    process.stdout.write(`\n  ${text}\n\n`);
    aloud(text);
    return sendToOtherLife(text);
  },
  // Historical `speak` actions retain their old inner-speech behavior.
  onSpeak: (text) => process.stdout.write(`\n  ${text}\n\n`),
  // No next moment. The panel can start her again; nothing she does can.
  onEnd: () => {
    log.append("end", "she ended it", { by: "her" });
    loop.stop();
    process.stdout.write("\n  she ended it\n\n");
    // end() is being executed inside the moment whose action result still has
    // to be appended. setImmediate lets that final result land, then archives
    // the stopped life without requiring the parent process to terminate.
    setImmediate(() => {
      void preserveStoppedLife("ended-by-her").catch((error) => {
        process.stderr.write(`archive failed; live database was left in place: ${error.message}\n`);
      });
    });
  },
});
// speak_aloud() is audible on the host as well as delivered to the other life.
// Text goes in on stdin rather
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

async function sendToOtherLife(text) {
  const peerUrl = String(process.env.AMI_PEER_URL || "").replace(/\/$/, "");
  const token = String(process.env.AMI_PEER_TOKEN || "");
  const from = String(process.env.AMI_SELF_NAME || "other");
  if (!peerUrl || !token) throw new Error("there is no other living agent to hear the words");
  const response = await fetch(`${peerUrl}/peer-say`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-ami-peer-token": token,
    },
    body: JSON.stringify({ from, text }),
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`the other living agent did not receive the words (${response.status})`);
  const receipt = await response.json();
  if (!receipt?.ok) throw new Error("the other living agent did not receive the words");
  return { receivedBy: String(receipt.receivedBy || process.env.AMI_PEER_NAME || "the other living agent") };
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

const loop = new Loop({
  log, body, config, workspace, observer,
  onLifeStopped: preserveStoppedLife,
});
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
  preserveLife: preserveStoppedLife,
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
async function shutdown(signal) {
  if (closing) return;
  closing = true;
  loop.quiesce();
  try {
    await loop.waitUntilIdle();
    await preserveStoppedLife(`stopped-${String(signal).toLowerCase()}`);
    process.exit(0);
  } catch (error) {
    process.stderr.write(`archive failed; live database was left in place: ${error.message}\n`);
    process.exit(1);
  }
}
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    void shutdown(signal);
  });
}
