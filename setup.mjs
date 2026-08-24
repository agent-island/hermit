// The editable document handed to her. {{...}} values are current facts.
// The room text itself lives in voice.mjs, with the rest of her language.
import { ROOM } from "./voice.mjs";

export const PLACEHOLDERS = {
  "{{time}}": "the current time",
  "{{identity}}": "the identity most recently authored by the agent; empty until the agent authors one",
  "{{elapsed}}": "how long since the previous moment",
  "{{workspace}}": "that a private directory exists. never the real path",
  "{{files}}": "the files in that directory",
  "{{runtime}}": "her own remaining moments and any inherited reserve; absent unless a finite-life ledger is seeded",
  "{{forms}}": "every call she can make, one per line, each with what it does",
  "{{incoming}}": "messages received since the last moment",
  "{{gap}}": "the pacing interval after activity; retained for custom historical templates",
  "{{context}}": "each context you named, and how many messages it has sent",
  "{{returned}}": "each call from the previous moment and what it returned",
  "{{memories}}": "active memory units and the exact prompt token ledger",
  "{{latent}}": "counts of memories outside the current foreground but still available to recall",
  "{{intentions}}": "the standing goals she has set and not yet resolved",
  "{{previous}}": "the text she emitted last moment, verbatim",
};

export const DEFAULT_TEMPLATE = ROOM;

export const DEFAULT_SETUP = {
  scaffoldVersion: 3,
  template: DEFAULT_TEMPLATE,
  // prefix       an open assistant turn she continues — nobody addressed her.
  // system       standing context; tuned models read this role as orders.
  // user         something said to her, which means answer now.
  // completions  a bare document, no roles at all. Needs base weights.
  arrival: "prefix",
  // "moment"       every request is one document and nothing else. She is a
  //                fresh instantiation each time, reconstructing continuity
  //                from MEMORY, PREVIOUS and RETURNED. Cost is flat.
  // "conversation" the request carries her actual recent life — each room and
  //                what she emitted into it, in order. Shelving and
  //                consolidation are the only things that reduce it.
  // Earlier builds inserted a cheap first-person heartbeat between full calls.
  // The heartbeat was itself an intervention and could turn an empty interval
  // into model-authored text. It is retained only as ignored historical setup
  // metadata; continuation is now driven by events and explicit activity.
  heartbeat: false,
  context: "moment",
  // Whether feel() exists. When on, she can attach a self-authored feeling
  // report to an experience. No simulated bodily variable creates one.
  emotion: true,
  // Whether intention state exists. Goals, success conditions, cues, evidence,
  // and next steps are all authored by the model, never supplied by this flag.
  intention: true,
  // Whether sleep() exists as an act. When it is absent, only real activity or
  // an incoming event can create another continuation.
  sleepEnabled: true,
  // How long sleep() rests, in seconds. She calls sleep() with no argument; the
  // operator sets the length here (adjustable in the panel, 10–3600). Default
  // ten seconds. See body.sleep.
  sleepSeconds: 10,
  // Seconds between continuations while actual activity is ongoing. Inactivity
  // schedules nothing, regardless of this value.
  gapSeconds: 10,
  // The tagged rendering keeps temporal roles and command results distinct.
  format: "faculties",
};

const KEY = "setup_v2";

export function loadSetup(log) {
  const stored = log.get(KEY, null);
  const setup = { ...DEFAULT_SETUP, ...(stored && typeof stored === "object" ? stored : {}) };
  // Version 2 was our first tagged experiment: <time>, <around>, <heard>,
  // <returned>, <intentions>, <memory>, <last>. It was authored by this
  // framework, not an arbitrary operator template, so it can move forward to
  // the researched continuity/present scaffold. Other custom templates remain
  // byte-for-byte under operator ownership.
  const priorTaggedScaffold = stored
    && !stored.scaffoldVersion
    && stored.format === "faculties"
    && /<time>\s*\{\{time\}\}\s*<\/time>/.test(String(stored.template || ""))
    && String(stored.template || "").includes("<around>")
    && String(stored.template || "").includes("<last>");
  if (priorTaggedScaffold) setup.template = DEFAULT_TEMPLATE;
  // Untagged historical setups retain their matching plain renderer.
  if (stored && !stored.format && !stored.scaffoldVersion) setup.format = "plain";
  // The former daily-spending block was a second token system unrelated to
  // memory: shelving could never reduce it. Keep exactly one model-facing
  // matrix by migrating it out of old rooms as they are loaded.
  setup.template = String(setup.template || DEFAULT_TEMPLATE)
    .replace(/\nTOKENS\n[ \t]*\{\{tokens\}\}[ \t]*\n/g, "\n");
  // contextChars was an observer-owned attention policy. Old records may
  // still contain it, but it must not silently govern a new moment.
  delete setup.contextChars;
  return setup;
}

export function saveSetup(log, value) {
  const next = { ...loadSetup(log) };
  if (typeof value?.template === "string") next.template = value.template;
  next.scaffoldVersion = DEFAULT_SETUP.scaffoldVersion;
  if (["prefix", "system", "user", "completions"].includes(value?.arrival)) {
    next.arrival = value.arrival;
  }
  if (["moment", "conversation"].includes(value?.context)) next.context = value.context;
  if (typeof value?.heartbeat === "boolean") next.heartbeat = value.heartbeat;
  if (typeof value?.emotion === "boolean") next.emotion = value.emotion;
  if (typeof value?.intention === "boolean") next.intention = value.intention;
  if (typeof value?.sleepEnabled === "boolean") next.sleepEnabled = value.sleepEnabled;
  // How the room is rendered: "plain" (the default sections) or "faculties"
  // (our own tag language — no room, no moment, bound command/output). Only
  // changes rendering, so it is safe to carry with the rest of the setup.
  if (["plain", "faculties"].includes(value?.format)) next.format = value.format;
  if (Number.isFinite(Number(value?.sleepSeconds))) {
    next.sleepSeconds = Math.min(3600, Math.max(10, Math.round(Number(value.sleepSeconds))));
  }
  if (Number.isFinite(Number(value?.gapSeconds))) {
    next.gapSeconds = Math.min(3600, Math.max(5, Math.round(Number(value.gapSeconds))));
  }
  log.set(KEY, next);
  log.append("setup", next.template, {
    scaffoldVersion: next.scaffoldVersion,
    arrival: next.arrival,
    context: next.context,
    heartbeat: next.heartbeat,
    emotion: next.emotion,
    intention: next.intention,
    sleepEnabled: next.sleepEnabled,
    sleepSeconds: next.sleepSeconds,
    gapSeconds: next.gapSeconds,
    by: "observer",
  });
  return next;
}

export function fill(template, values) {
  const lines = template.split("\n").flatMap((line) => {
    const match = line.match(/^(\s*)(\{\{[a-z_]+\}\})\s*$/);
    if (!match) {
      return [line.replace(/\{\{[a-z_]+\}\}/g, (key) => String(values[key] ?? key).split("\n")[0])];
    }
    const [, indent, key] = match;
    const value = values[key];
    if (value == null) return [];
    const body = Array.isArray(value) ? value : String(value).split("\n");
    return body.length ? body.map((entry) => indent + entry) : [];
  });

  // Drop sections that have no value.
  const kept = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^[A-Z][A-Z_ ]{2,}$/.test(line.trim()) && line.trim() === line) {
      let next = index + 1;
      while (next < lines.length && !lines[next].trim()) next += 1;
      const empty = next >= lines.length || /^[A-Z][A-Z_ ]{2,}$/.test(lines[next].trim());
      if (empty) continue;
    }
    kept.push(line);
  }
  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
}
