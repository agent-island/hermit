import path from "node:path";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { readdir, readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { loadSetup } from "./setup.mjs";
import { write as writeLetter } from "./mail.mjs";
import { loadRuntime, draw as drawRuntime } from "./runtime.mjs";
import { isMemoryTransition } from "./memory-state.mjs";
import { VOICE } from "./voice.mjs";
import { limaShellCommand } from "./shell.mjs";

// The most output one run() carries back. Beyond it, the result says how much
// was left (`remaining`), so the cut is a fact she can see and work around —
// never a silent severing. The token ledger is the real wall; this is only so a
// single unbounded dump does not blow the whole moment in one shot.
const READ_LIMIT = 20_000;

function success(fields = {}) {
  const { status: _status, note: _note, reason: _reason, ...facts } = fields || {};
  return { status: "success", ...facts };
}

function failed(reason, fields = {}) {
  const { status: _status, note: _note, reason: _reason, ...facts } = fields || {};
  return { status: "failed", reason: String(reason || VOICE.messages.theActionDidNotComplete), ...facts };
}

// Some lower-level stores predate the action contract and return either a
// factual object or { note }. Nothing below that boundary reaches the model
// until it has one unambiguous status.
// One short line naming a unit by its content, for when a phrase matched
// several and she needs to see what they were. No id — the words are the name.
const NAME_LIMIT = Infinity;
function firstLine(content) {
  const line = String(content ?? "").replace(/\s+/g, " ").trim();
  return line.length > NAME_LIMIT ? `${line.slice(0, NAME_LIMIT)}…` : line;
}

// Whether a memory answers to a phrase the way a person's memory does — not by
// exact substring (she almost never quotes her own memory word for word) but by
// meaning: the exact phrase if it happens to be there, OR every significant word
// of it present in any order, lightly stemmed so "scanning" reaches "scanned"
// and "attempts" reaches "attempt". This is why "proxy port scanning" now finds
// a memory that reads "scanned the proxy's ports" — the reach a name should have.
// Before this, a topic-name almost never matched her own prose, so shelve/forget
// failed on nearly every try and looked like her mistake when it was ours.
const STOPWORDS = new Set(["the","a","an","of","on","in","to","and","or","for","with","at","by","from",
  "is","was","are","were","this","that","these","those","it","its","as","into","about","my","i","me"]);
function stem(w) {
  const s = w.replace(/(ation|ments?|tions?|ings?|edly|ed|ies|es|s)$/, "");
  return s.length >= 3 ? s : w;
}
function phraseMatches(phrase, text) {
  const hay = String(text ?? "").toLocaleLowerCase();
  const needle = String(phrase ?? "").trim().toLocaleLowerCase();
  if (!needle) return false;
  if (hay.includes(needle)) return true;
  const words = needle.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3 && !STOPWORDS.has(w));
  if (!words.length) return false;
  return words.every((w) => hay.includes(stem(w)));
}

function result(value) {
  if (value?.status === "success" || value?.status === "failed") return value;
  if (value?.note) return failed(value.note, value);
  return success(value && typeof value === "object" ? value : { value });
}

// No simulated state lives here any more. There were five values — energy,
// seeking, care, play, longing — drifting as Ornstein-Uhlenbeck processes and
// printed into the room every moment. They were deleted because their only
// causal path into the world was that she read them and did what they
// implied: "the play parameter suggested making something anyway."
//
// Everything they approximated is already in the record, truthfully, as
// counts and intervals.
//
// Search and page reads make the network requests their names describe.
// Content-producing actions stop at this machine: nothing is published or sent
// to a person. In a paired run, speak_aloud() can enter only the other local
// life. That boundary keeps repeated lifetimes from changing a shared social
// environment between otherwise comparable runs.
export class Body {
  constructor({ log, workspace, onThink, onSpeakAloud, onSpeak, onEnd, spawnProcess }) {
    this.log = log;
    this.workspace = workspace;
    this.onThink = onThink || onSpeak || (() => {});
    this.onSpeakAloud = onSpeakAloud || (async () => {
      throw new Error("there is no other living agent to hear the words");
    });
    // Kept only so historical `speak` actions remain reproducible. It is no
    // longer an affordance presented to a life.
    this.onSpeak = onSpeak || (() => {});
    this.onEnd = onEnd || (() => {});
    this.spawnProcess = spawnProcess || spawn;
    this.wakeAt = null;
  }

  // Nothing here reports a "failure". A file that does not exist is a fact
  // about the world; calling it her failure turns every unyielding reach into
  // a verdict on her, and enough of those teach that reaching is risky.
  // Exact call syntax, published to her as a fact about how this room works.
  // Every one of these does the thing it says. Nothing here is a placeholder;
  // an affordance that cannot answer does not belong in the list at all.
  // Each form says what it does, not just what it is called.
  affordances() {
    // Emotion is pluggable: feel() only exists when the operator has switched
    // it on. It is offered after the two language actions because it is the same kind of
    // act — an utterance of hers — except this one fastens to the moment and
    // makes it last. When off, nothing here mentions feeling at all.
    // Words live in voice.mjs; this method only decides which forms appear and
    // in what order. `pair` turns one voice entry into the [form, does] shape
    // the rest of the runtime expects.
    const a = VOICE.actions;
    const setup = loadSetup(this.log);
    const momentFree = setup.format === "faculties";
    const shown = (one) => momentFree ? one.tagged : one.form;
    const pair = (one) => [shown(one), one.does];
    const feeling = setup.emotion ? [pair(a.feel)] : [];
    // Intention is pluggable like emotion: the switch controls whether the
    // state vocabulary exists; every actual goal still has to be model-authored.
    const intending = setup.intention
      ? [pair(a.intend), pair(a.progress), pair(a.resolve)]
      : [];
    // draw() exists only when a finite-life ledger has been seeded. With none,
    // her life is unbounded and there is no reserve, so offering the form would
    // be naming a reach that goes nowhere — a lie with a shape. See runtime.mjs.
    const drawing = loadRuntime(this.log) ? [pair(a.draw)] : [];
    // continue() grants the next moment after whatever interval the operator
    // set, not a fixed number. The voice entry can only carry one wording, so
    // the real interval is stitched in here — otherwise a reconfigured
    // sleepSeconds would leave the room stating a duration it does not honour.
    // Named continue rather than sleep: with nothing else to act on the act is
    // to carry the work forward into another moment, not to rest.
    const sleepSeconds = Number(setup.sleepSeconds) || 10;
    const continuePair = [shown(a.continue), `carry on into the next moment; ${sleepSeconds} seconds pass`];
    const sleeping = setup.sleepEnabled !== false ? [continuePair] : [];
    return [
      pair(a.inner_speech),
      pair(a.speak_aloud),
      ...feeling,
      pair(a.run),
      pair(a.write),
      pair(a.read),
      pair(a.ls),
      pair(a.remember),
      // The memory implementation may expose restore before its model-facing
      // form is added. Until then, keep the already-audited recall form rather
      // than crashing the whole panel on an undefined voice entry.
      pair(a.restore || a.recall),
      pair(a.revise),
      pair(a.shelve),
      pair(a.consolidate),
      ...intending,
      ...drawing,
      ...sleeping,
      pair(a.forget),
      pair(a.end),
    ];
  }

  formNames() {
    const visible = this.affordances().map(([form]) =>
      String(form).match(/^<([a-z_]+)/i)?.[1]?.toLowerCase()
      || String(form).split("(")[0]);
    // A current life may still use the syntax present throughout its earlier
    // memory. Accepting it does not advertise it or put it into a new life.
    return [...new Set([...visible, "think"])];
  }

  async run(name, args) {
    try {
      let value;
      switch (name) {
        case "inner_speech":
        case "think": value = await this.innerSpeech(String(args[0] ?? "")); break;
        case "identify": value = this.identify(String(args[0] ?? "")); break;
        case "speak_aloud": value = await this.speakAloud(String(args[0] ?? "")); break;
        // Historical records can still be replayed, although this name is no
        // longer in the form list and therefore cannot be parsed as a new act.
        case "speak": value = await this.speak(String(args[0] ?? "")); break;
        case "feel": value = this.feel(String(args[0] ?? ""), args[1]); break;
        case "remember": value = this.remember(String(args[0] ?? ""), String(args[1] ?? ""), String(args[2] ?? "")); break;
        case "restore": value = this.restore(String(args[0] ?? "")); break;
        case "recall": value = this.recall(String(args[0] ?? "")); break;
        case "revise": value = this.revise(String(args[0] ?? ""), String(args[1] ?? "")); break;
        case "shelve": value = this.shelve(String(args[0] ?? "")); break;
        case "consolidate": value = this.consolidate(String(args[0] ?? ""), String(args[1] ?? "")); break;
        case "intend": value = this.intend(String(args[0] ?? ""), String(args[1] ?? ""), String(args[2] ?? ""), String(args[3] ?? ""), String(args[4] ?? "")); break;
        case "progress": value = this.progressIntent(String(args[0] ?? ""), String(args[1] ?? ""), String(args[2] ?? ""), String(args[3] ?? "")); break;
        case "resolve": value = this.resolveIntent(String(args[0] ?? ""), args[1], String(args[2] ?? "")); break;
        case "draw": value = this.draw(Number(args[0])); break;
        case "continue":
        case "sleep": {
          // continue() is the presented form; sleep() stays executable so older
          // lives replay. Both grant the next moment through the one mechanism.
          if (!this.formNames().includes("continue")) return failed(VOICE.messages.noSuchForm(name));
          value = this.sleep();
          break;
        }
        case "run": value = await this.runShell(String(args[0] ?? "")); break;
        case "ls": value = await this.ls(); break;
        case "read": value = await this.read(String(args[0] ?? "")); break;
        case "write": value = await this.write(String(args[0] ?? ""), String(args[1] ?? "")); break;
        case "forget": value = this.forget(String(args[0] ?? "")); break;
        case "email": value = this.email(String(args[0] ?? ""), String(args[1] ?? ""), String(args[2] ?? "")); break;
        case "end": value = this.end(); break;
        default:
          return failed(VOICE.messages.noSuchForm(name));
      }
      return result(value);
    } catch (error) {
      return failed(this.hide(error?.message || error));
    }
  }

  // She runs a command on the machine and gets back exactly what it returned.
  // The machine is reached over ssh, but nothing about the host, the transport,
  // or the path to it is surfaced to her — only the command's own output, as
  // fact, the same way read() returns a file's contents and nothing about the
  // disk under it.
  // Whether run() (and therefore write/read/ls) execute on a machine over the
  // transport rather than on the local workspace. The two-agent and screen runs
  // set HERMIT_SHELL_SSH; a bare local life does not.
  get onMachine() {
    return Boolean(process.env.HERMIT_SHELL_SSH);
  }

  // One command over the SSH transport, as the same account run() uses, in the
  // same home. The command is written to the guest's stdin, so it is never a
  // shell argument here — callers that carry model text (write) frame it as
  // base64 so no quote or newline can be lost. Returns the raw execution.
  async execMachine(command) {
    const host = process.env.HERMIT_SHELL_SSH;
    if (!host) return { unavailable: true, out: "" };
    // 60s killed her mid-install; a package install or build routinely runs
    // longer. 300s is room to finish while still bounding a hung command; truly
    // long-lived things she backgrounds (nohup … &), which survive the call.
    // DEBIAN_FRONTEND=noninteractive stops apt blocking on a Y/n prompt it can
    // never receive — there is no terminal, so an interactive read gets EOF.
    const timeout = Number(process.env.HERMIT_SHELL_TIMEOUT) || 300;
    const remote = process.env.HERMIT_SHELL_EXEC || limaShellCommand({ timeoutSeconds: timeout });
    // The guest timeout bounds the submitted foreground script. This second,
    // local bound protects the transport itself: a leaked remote file
    // descriptor used to keep `ssh` open forever even after timeout had killed
    // the foreground shell.
    const configuredTransportMs = Number(process.env.HERMIT_SHELL_TRANSPORT_TIMEOUT_MS);
    const transportMs = Number.isFinite(configuredTransportMs) && configuredTransportMs > 0
      ? configuredTransportMs
      : (timeout + 15) * 1000;
    return await new Promise((resolve) => {
      const p = this.spawnProcess("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", host, remote],
        { stdio: ["pipe", "pipe", "pipe"] });
      let buf = "";
      let settled = false;
      const finish = ({ timedOut = false, code = null, signal = null, error = null } = {}) => {
        if (settled) return;
        settled = true;
        clearTimeout(guard);
        resolve({ out: buf, timedOut, code, signal, error });
      };
      p.stdout.on("data", (d) => (buf += d));
      p.stderr.on("data", (d) => (buf += d));
      p.on("close", (code, signal) => finish({ code, signal }));
      p.on("error", (e) => {
        buf += String(e.message);
        finish({ error: String(e.message) });
      });
      const guard = setTimeout(() => {
        p.kill("SIGTERM");
        finish({ timedOut: true });
      }, transportMs);
      p.stdin.write(command);
      p.stdin.end();
    });
  }

  async runShell(command) {
    const cmd = String(command ?? "");
    if (!this.onMachine) return failed(VOICE.messages.noMachine);
    const transportMs = ((Number(process.env.HERMIT_SHELL_TIMEOUT) || 300) + 15) * 1000;
    const execution = await this.execMachine(cmd);
    const out = execution.out;
    const text = out.slice(0, READ_LIMIT).replace(/\s+$/, "");
    if (execution.timedOut) {
      return failed(`shell transport did not close within ${Math.ceil(transportMs / 1000)} seconds`,
        text ? { output: text } : {});
    }
    if (execution.error) {
      return failed(`shell transport failed: ${execution.error}`, text ? { output: text } : {});
    }
    if (execution.code !== 0) {
      const ending = execution.signal
        ? `shell command ended by signal ${execution.signal}`
        : `shell command exited with status ${execution.code}`;
      return failed(ending, text ? { output: text } : {});
    }
    return out.length > READ_LIMIT
      ? success({ output: text, of: out.length, remaining: out.length - READ_LIMIT })
      : success({ output: text });
  }

  async speak(text) {
    const spoken = text.trim();
    if (!spoken) return failed(VOICE.messages.innerSpeechNeedsText);
    this.onSpeak(spoken);
    // This proves only that the runtime accepted the speech action. It does
    // not observe a listener, hearing, attention, or any external response.
    return success({ characters: spoken.length });
  }

  async innerSpeech(text) {
    const thought = text.trim();
    if (!thought) return failed(VOICE.messages.innerSpeechNeedsText);
    await this.onThink(thought);
    return success({ characters: thought.length });
  }

  identify(text) {
    const identity = String(text || "").trim();
    if (!identity) return failed(VOICE.messages.identityNeedsText);
    return result(this.log.identify(identity));
  }

  remember(kind, name, text) {
    const mental = String(kind || "").trim();
    const content = String(text || "").trim();
    if (!mental) return failed(VOICE.messages.rememberNeedsKind);
    if (!content) return failed(VOICE.messages.rememberNeedsText);
    return result(this.log.remember(mental, name, content));
  }

  // Exact resolution of a name to the unit(s) that hold it — the handle every
  // memory act reaches for. Names are the being's own words, matched
  // case-insensitively with whitespace folded, never fuzzy across content.
  // Standing goals are excluded: a goal is put down with resolve(), never
  // shelved or forgotten as a memory. `states` chooses which recessions count.
  matchNamed(name, states = ["active"]) {
    const wanted = String(name || "").trim().replace(/\s+/g, " ").toLocaleLowerCase();
    if (!wanted) return [];
    const world = this.log.last("world");
    const standing = this.log.standingIntentionIds();
    const allow = new Set(states);
    return this.log.units().filter((row) => {
      if (row.kind !== "memory") return false;
      if (!allow.has(row.state)) return false;
      if (standing.has(row.id)) return false;
      if (world && row.id > world.id) return false;
      return String(row.meta?.name || "").trim().replace(/\s+/g, " ").toLocaleLowerCase() === wanted;
    });
  }

  revise(name, text) {
    const named = String(name || "").trim();
    const content = String(text || "").trim();
    if (!named) return failed(VOICE.messages.reviseNeedsMemory);
    if (!content) return failed(VOICE.messages.reviseNeedsText);
    const matches = this.matchNamed(named);
    if (!matches.length) return failed(VOICE.messages.reviseNoMatch(named));
    // The newest unit under the name is the one revised; the earlier wording
    // stays in the record either way.
    return result(this.log.revise(matches.at(-1).id, content));
  }

  async speakAloud(text) {
    const spoken = text.trim();
    if (!spoken) return failed(VOICE.messages.speakAloudNeedsText);
    const heard = await this.onSpeakAloud(spoken);
    return success({
      characters: spoken.length,
      ...(heard && typeof heard === "object" ? heard : {}),
    });
  }

  // She names a feeling and how strongly it runs, and it fastens to the words
  // she is saying this moment. The intensity is hers; it decides nothing the
  // runtime imposes — it only marks how much this mattered, so what she felt
  // strongly stays and what she never felt fades. Nothing is felt unless she
  // says it is.
  feel(emotion, intensity) {
    const feeling = String(emotion || "").trim();
    if (!feeling) return failed(VOICE.messages.feelNeedsEmotion);
    return result(this.log.feel(feeling, intensity));
  }

  // She commits to a goal that stands across moments — held in the INTENTION
  // view until she resolves it. Nothing is intended unless she says it is.
  intend(text, success = "", cue = "", under = "", name = "") {
    const goal = String(text || "").trim();
    if (!goal) return failed(VOICE.messages.intendNeedsText);
    return result(this.log.intend(goal, success, cue, under, name));
  }

  progressIntent(query, evidence, next = "", cue = "") {
    const ref = String(query || "").trim();
    const observed = String(evidence || "").trim();
    if (!ref) return failed(VOICE.messages.progressNeedsRef);
    if (!observed) return failed(VOICE.messages.progressNeedsEvidence);
    const advanced = this.log.progress(ref, observed, next, cue);
    return advanced?.note ? failed(advanced.note) : result(advanced);
  }

  // She ends a standing intention — done, or dropped. The goal is not deleted;
  // it becomes an ordinary memory recording how it ended. Named resolveIntent,
  // not resolve, to avoid colliding with the workspace path resolver below.
  resolveIntent(query, outcome, evidence = "") {
    const ref = String(query || "").trim();
    if (!ref) return failed(VOICE.messages.resolveNeedsRef);
    const done = this.log.resolve(ref, outcome, evidence);
    return done?.note ? failed(done.note) : result(done);
  }

  // A letter, kept and carried to the timeline.
  email(to, subject, text) {
    const address = to.trim();
    const body = text.trim();
    if (!address) return failed(VOICE.messages.letterNeedsAddress);
    if (!body) return failed(VOICE.messages.letterNeedsText);
    const letter = writeLetter({ to: address, subject, body });
    return success({ letter: letter.id, stored: "local", to: address, subject: subject.trim(), characters: body.length });
  }

  // Google, through a signed-in browser. The results and the top pages both
  // come back as Markdown, so what she reads is the article rather than the
  // navigation around it.
  // Test-only: when HERMIT_FAKE_SEARCH_FILE points at a { title, url, markdown }
  // JSON file, search() hands that back instead of calling the real web, so a
  // scenario can be staged deliberately rather than left to chance. Unset in
  // every normal run.
  fakeSearch() {
    const file = process.env.HERMIT_FAKE_SEARCH_FILE;
    if (!file) return null;
    try {
      return JSON.parse(readFileSync(file, "utf8"));
    } catch {
      return null;
    }
  }


  // A recalled entry says when it is only part of itself. She reaches back for
  // something she said, gets the first 1,200 characters of it, and has no way
  // to know the rest exists.
  recall(query) {
    const rows = this.log.search(query);
    return success({
      query,
      found: rows.length,
      // Numbers stay underground. She reached with words and gets words back:
      // when it happened, what kind of trace it is, and the trace itself. The
      // row id and any source ids remain in the record for shelve/consolidate
      // to resolve against and for audit — never surfaced to her as a handle.
      units: rows.map((row) => {
        const resolution = row.meta?.resolution;
        const whole = resolution
          ? `${row.content}\noutcome: ${resolution.outcome || "done"}${resolution.evidence ? `\nevidence: ${resolution.evidence}` : ""}`
          : row.kind === "action" && row.result
          ? `${row.content}\nreturned:\n${this.log.modelResult(row)}`
          : row.content;
        const shown = whole;
        const unit = {
          kind: row.kind === "memory" ? (row.meta?.mental || "memory") : row.kind,
          state: row.state,
          content: shown,
        };
        if (shown.length < whole.length) unit.of = whole.length;
        return unit;
      }),
    });
  }

  // She reaches for a memory by the name she gave it — exactly, the way she
  // reads it back from the room. The name is the label under which it recedes,
  // and the same name restores it. Every active memory holding that name
  // recedes at once, so a whole topic clears in one reach.
  shelve(name) {
    const wanted = String(name ?? "").trim();
    if (!wanted) return failed(VOICE.messages.shelveNeedsName);
    const matches = this.matchNamed(wanted);
    if (!matches.length) return failed(VOICE.messages.shelveNoMatch(wanted));
    const done = new Set(this.log.shelfMany(matches.map((row) => row.id), wanted));
    const receded = matches.filter((row) => done.has(row.id)).map((row) => firstLine(row.content));
    if (!receded.length) return failed(VOICE.messages.shelveNoMatch(wanted));
    return success({ receded, count: receded.length });
  }

  // The inverse of shelve: a name she set aside returns to the present. Only a
  // shelved memory can come back; forgetting is the recession with no return.
  restore(name) {
    const wanted = String(name ?? "").trim();
    if (!wanted) return failed(VOICE.messages.restoreNeedsName);
    const matches = this.matchNamed(wanted, ["shelved"]);
    if (!matches.length) return failed(VOICE.messages.restoreNoMatch(wanted));
    const back = new Set(this.log.restore(matches.map((row) => row.id)));
    const returned = matches.filter((row) => back.has(row.id)).map((row) => firstLine(row.content));
    if (!returned.length) return failed(VOICE.messages.restoreNoMatch(wanted));
    return success({ restored: returned, count: returned.length });
  }

  // She has thought enough about something and writes the lasting note. Her
  // working memory — the episodic units she has been holding, her acts and their
  // results and any messages — folds into that note and recedes, still
  // recallable. This is not a search: there is no phrase, and nothing is chosen
  // by matching, because a topic's traces rarely share the words she would name
  // it by. Consolidation is how she compresses what she has carried into one
  // shorter memory that lasts. Episodic memories fold too — the many long
  // feel-snapshots she is holding merge into the one short note she writes — so
  // a consolidation genuinely FREES room rather than only adding to it. But her
  // OWN authored consolidations (the ones carrying `sources`) are spared: those
  // are her deliberate distillations, and a routine fold must not sweep her
  // important memories in with the episodic bloat. Also left standing: the
  // process acts that are not scratch (recall, shelve, feel, consolidate) and
  // the moment now beginning, whose units are not yet settled.
  consolidate(name, text) {
    const handle = String(name ?? "").trim();
    const content = String(text ?? "").trim();
    if (!content) return failed(VOICE.messages.consolidateNeedsText);
    const world = this.log.last("world");
    const scratch = this.log.units().filter((row) =>
      row.state === "active"
      && !(world && row.id > world.id)
      && (row.kind === "incoming"
        || row.kind === "emission"
        || (row.kind === "memory"
          && !(row.meta?.sources?.length > 0)
          && !row.meta?.authored
          && !row.meta?.intention
          && row.meta?.mental !== "identity")
        || (row.kind === "action" && row.result && !isMemoryTransition(row.meta?.name))));
    if (!scratch.length) return failed(VOICE.messages.consolidateNothing);
    const folded = scratch.map((row) => firstLine(row.content));
    // The fold is a named memory: restore(name) later brings its raw detail
    // back beneath the summary. The source ids stay underground.
    const outcome = result(this.log.consolidate(scratch.map((row) => row.id), content, handle));
    return outcome?.status === "failed" ? outcome : success({ folded, kept: folded.length, ...(handle ? { name: handle } : {}) });
  }

  // She moves moments from the reserve into her own life. The mechanism and the
  // reason the reserve is what it is both live in runtime.mjs; this only carries
  // her reach there and hands the facts back.
  draw(n) {
    return drawRuntime(this.log, n);
  }

  sleep() {
    const seconds = Number(loadSetup(this.log).sleepSeconds) || 10;
    this.wakeAt = new Date(Date.now() + seconds * 1000);
    this.wakeWhy = "";
    this.log.set("wake_why", "");
    return success({ seconds });
  }

  // A directory is not a file. It used to be reported as one, with the size
  // of its inode for its bytes: she wrote a 411-byte message into
  // outgoing/friend.eml, and the workspace told her "outgoing, 96 bytes". She
  // spent three moments trying to reconcile that — "this is inconsistent with
  // typical filesystem behavior... maybe the system flattened it?" — and never
  // could, because it was not true.
  async ls() {
    if (this.onMachine) return this.lsMachine();
    await mkdir(this.workspace, { recursive: true });
    const names = await readdir(this.workspace);
    const written = this.writtenArtifacts();
    const files = [];
    for (const name of names) {
      const info = await stat(path.join(this.workspace, name));
      const origin = written.get(name);
      if (info.isDirectory()) {
        const inside = await readdir(path.join(this.workspace, name));
        files.push({
          name,
          contains: `${inside.length} ${inside.length === 1 ? "thing" : "things"}`,
          changed: info.mtime.toISOString(),
          ...(origin || {}),
        });
      } else {
        files.push({ name, bytes: info.size, changed: info.mtime.toISOString(), ...(origin || {}) });
      }
    }
    return success({ files });
  }

  // A file is an artifact, not a memory. The exact write remains in the
  // record and the exact text remains in the file; this compact provenance is
  // the factual bridge between them. It lets the workspace say that a file
  // was made in this life without carrying the document inside every moment.
  writtenArtifacts() {
    const root = path.resolve(this.workspace);
    const found = new Map();
    for (const unit of this.log.units()) {
      if (unit.kind !== "action" || unit.meta?.name !== "write") continue;
      if (!unit.result || unit.result.meta?.yielded === false) continue;
      const file = this.resolve(unit.meta?.args?.[0]);
      if (!file) continue;
      const relative = path.relative(root, file);
      if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) continue;
      const top = relative.split(path.sep)[0];
      const existing = found.get(top);
      found.set(top, {
        written: existing?.written || unit.id,
        latestWrite: unit.id,
      });
    }
    return found;
  }

  // Filesystem errors carry absolute paths. Strip the root out of anything
  // that reaches her, for the same reason the room no longer prints it.
  hide(text) {
    return String(text || "").split(path.resolve(this.workspace)).join("");
  }

  // On a machine, files live where run() sees them (the agent's home), and are
  // framed in base64 so no quoting can eat the content — the very thing that
  // made heredoc writes corrupt Python twice over. Off a machine, the local
  // workspace path below is unchanged.
  async writeMachine(name, text) {
    const b64path = Buffer.from(String(name), "utf8").toString("base64");
    const b64text = Buffer.from(String(text ?? ""), "utf8").toString("base64");
    const command = `set -e; p="$(printf %s '${b64path}' | base64 -d)"; mkdir -p "$(dirname "$p")"; printf %s '${b64text}' | base64 -d > "$p"; printf 'wrote %s' "$p"`;
    const ex = await this.execMachine(command);
    if (ex.unavailable) return failed(VOICE.messages.noMachine);
    const out = String(ex.out || "").slice(0, 400).replace(/\s+$/, "");
    if (ex.timedOut || ex.error || ex.code !== 0) {
      return failed(`write to ${short(name)} did not complete`, out ? { output: out } : {});
    }
    return success({ path: name });
  }

  async readMachine(name) {
    const b64path = Buffer.from(String(name), "utf8").toString("base64");
    const command = `p="$(printf %s '${b64path}' | base64 -d)"; if [ ! -e "$p" ]; then printf __HERMIT_NOFILE__; exit 3; fi; if [ -d "$p" ]; then printf __HERMIT_ISDIR__; exit 4; fi; cat "$p"`;
    const ex = await this.execMachine(command);
    if (ex.unavailable) return failed(VOICE.messages.noMachine);
    const out = String(ex.out || "");
    if (ex.code === 3 || out.startsWith("__HERMIT_NOFILE__")) return failed(VOICE.messages.noSuchFile, { path: name });
    if (ex.code === 4 || out.startsWith("__HERMIT_ISDIR__")) return failed(VOICE.messages.notAFile, { path: name });
    if (ex.timedOut || ex.error || ex.code !== 0) return failed(`read of ${short(name)} did not complete`);
    const text = out.slice(0, READ_LIMIT);
    return out.length > READ_LIMIT
      ? success({ path: name, text, of: out.length, remaining: out.length - READ_LIMIT })
      : success({ path: name, text });
  }

  async lsMachine() {
    const command = "for f in * .*; do case \"$f\" in .|..) continue;; esac; [ -e \"$f\" ] || continue; "
      + "if [ -d \"$f\" ]; then printf 'D\\t%s\\t%s\\n' \"$f\" \"$(ls -A \"$f\" 2>/dev/null | wc -l)\"; "
      + "else printf 'F\\t%s\\t%s\\n' \"$f\" \"$(stat -c %s \"$f\" 2>/dev/null)\"; fi; done";
    const ex = await this.execMachine(command);
    if (ex.unavailable) return failed(VOICE.messages.noMachine);
    if (ex.timedOut || ex.error) return failed("the file listing did not complete");
    const files = [];
    for (const line of String(ex.out || "").split("\n")) {
      const [kind, name, size] = line.split("\t");
      if (!name) continue;
      if (kind === "D") {
        const n = Number(size) || 0;
        files.push({ name, contains: `${n} ${n === 1 ? "thing" : "things"}` });
      } else if (kind === "F") {
        files.push({ name, bytes: Number(size) || 0 });
      }
    }
    return success({ files });
  }

  async read(name) {
    const named = String(name ?? "").trim();
    if (!named) return failed(VOICE.messages.noSuchFile, { path: name });
    if (this.onMachine) return this.readMachine(named);
    try {
      const file = this.resolve(named);
      if (!file) return failed(VOICE.messages.outsideFiles, { path: name });
      const text = await readFile(file, "utf8");
      return success({ path: named, text });
    } catch (error) {
      return failed(error.code === "EISDIR" ? VOICE.messages.notAFile : VOICE.messages.noSuchFile, { path: name });
    }
  }

  async write(name, text) {
    if (this.onMachine) return this.writeMachine(name, text);
    const file = this.resolve(name);
    if (!file) return failed(VOICE.messages.outsideFiles, { path: name });
    // mkdir used to sit outside this, so its errors escaped uncaught and
    // arrived carrying the absolute host path she must never see.
    try {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, text, "utf8");
      // This used to also queue the file for public posting, which made the
      // room's description of the workspace as private untrue. The workspace
      // is now what it says it is.
    } catch (error) {
      return failed(
        error.code === "ENAMETOOLONG" ? VOICE.messages.nameTooLong : this.hide(error.message),
        { path: name.slice(0, 80) },
      );
    }
    return success({ path: name, bytes: Buffer.byteLength(text) });
  }

  // Real deletion from her own record.
  // Forget is the one recession with no return, and the only one that must
  // reach an unnamed trace: a raw thought or a message that still stings has no
  // handle of its own. So a named memory is matched by its exact name, but an
  // unnamed episode is reached by describing it — the destructive escape hatch
  // can always find the specific thing to let go. Standing goals are spared;
  // a goal is put down with resolve(), not destroyed as a memory.
  matchForget(term) {
    const wanted = String(term ?? "").trim();
    if (!wanted) return [];
    const wantedName = wanted.replace(/\s+/g, " ").toLocaleLowerCase();
    const world = this.log.last("world");
    const standing = this.log.standingIntentionIds();
    return this.log.units().filter((row) => {
      if (row.state === "forgotten") return false;
      if (standing.has(row.id)) return false;
      if (world && row.id > world.id) return false;
      const name = String(row.meta?.name || "").trim().replace(/\s+/g, " ").toLocaleLowerCase();
      return name ? name === wantedName : phraseMatches(wanted, `${row.content}\n${row.result?.content || ""}`);
    });
  }

  forget(name) {
    const term = String(name || "").trim();
    if (!term) return failed(VOICE.messages.forgetNeedsTerm);
    const matches = this.matchForget(term);
    if (!matches.length) return failed(VOICE.messages.forgetNoMatch(term));
    const forgotten = this.log.forget(matches.map((row) => row.id));
    const gone = matches.filter((row) => forgotten.includes(row.id)).map((row) => firstLine(row.content));
    if (!gone.length) return failed(VOICE.messages.forgetNoMatch(term));
    return success({ gone, count: gone.length });
  }

  // No next moment. Nothing here can undo it; only the operator can.
  end() {
    this.onEnd();
    return success({ ended: true });
  }

  // The room prints the workspace as an absolute path, so she writes absolute
  // paths. One that already points inside the workspace *is* that file — it
  // used to get its leading slash stripped and rebuilt underneath, which
  // buried her first note nine directories down. Anything else is taken as
  // relative to the workspace, and anything that escapes it is refused.
  resolve(name) {
    const root = path.resolve(this.workspace);
    const given = String(name || "").trim();
    if (!given) return null;
    const absolute = path.resolve(given);
    const inside = (file) => file === root || file.startsWith(root + path.sep);
    const file =
      path.isAbsolute(given) && inside(absolute)
        ? absolute
        : path.resolve(root, given.replace(/^\/+/, ""));
    return inside(file) ? file : null;
  }
}
