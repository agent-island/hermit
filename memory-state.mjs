// Memory state is a projection of the exact event record. The record remains
// authoritative; this module only states what a completed action means
// factually and which units currently follow. No importance, motive, or
// interpretation is inferred here.

const FACT_TEXT_LIMIT = Infinity;
const MEMORY_TRANSITIONS = new Set(["remember", "recall", "restore", "revise", "shelve", "consolidate", "feel", "forget", "identify", "intend", "progress", "resolve"]);

// These actions already persist as the transition they cause. Giving shelf()
// a second active episode would replace every shelved unit with a memory of
// shelving it, making capacity impossible to reduce. Recall changes no state;
// consolidation is represented by the sourced memory it creates.
export function isMemoryTransition(name) {
  return MEMORY_TRANSITIONS.has(String(name || ""));
}

// One experience can carry several feelings without becoming several copies
// of the experience. The exact feel() calls remain separate events in the
// append-only record; this is only their model-facing projection onto the one
// memory created for the emission they all name.
export function withFeeling(meta = {}, emotion, intensity) {
  const feeling = String(emotion || "").trim();
  if (!feeling) return { ...meta };
  const level = Math.round(Math.min(1, Math.max(0, Number(intensity) || 0)) * 100) / 100;
  const feelings = Array.isArray(meta.feelings)
    ? meta.feelings.map((one) => ({ emotion: String(one.emotion || ""), intensity: Number(one.intensity) || 0 }))
    : (meta.emotion ? [{ emotion: String(meta.emotion), intensity: Number(meta.intensity) || 0 }] : []);
  if (!feelings.some((one) => one.emotion === feeling && one.intensity === level)) {
    feelings.push({ emotion: feeling, intensity: level });
  }
  return { ...meta, feelings };
}

function short(value, limit = FACT_TEXT_LIMIT) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  const kept = text.slice(0, limit);
  return JSON.stringify(kept.length < text.length ? `${kept}…` : kept);
}

function noteOf(outcome) {
  return String(outcome?.error || outcome?.value?.reason || outcome?.value?.note || "").replace(/\s+/g, " ").trim();
}

function completed(outcome) {
  return outcome?.yielded !== false && !outcome?.error && outcome?.value?.status !== "failed" && !outcome?.value?.note;
}

// One compact episodic fact from one real call and its real result. Payloads
// that have their own exact home — document text, local-letter bodies, and
// speech — never enter the fact.
export function actionFact(action, outcome = {}) {
  const name = String(action?.name || "action");
  const args = Array.isArray(action?.args) ? action.args : [];
  const value = outcome?.value && typeof outcome.value === "object" ? outcome.value : {};
  if (value.status === "unknown") {
    return `the outcome of ${name} is unknown; the runtime stopped before recording it`;
  }
  const ok = completed(outcome);
  const note = noteOf(outcome);
  const failed = (reach) => `${reach} did not complete${note ? `: ${note}` : ""}`;

  switch (name) {
    case "email": {
      const to = value.to || args[0] || "";
      const subject = value.subject ?? args[1] ?? "";
      const reach = `local letter addressed to ${short(to)}`;
      return ok
        ? `stored ${reach}; subject ${short(subject)}`
        : failed(reach);
    }
    // No character or byte counts on any of these. A count of what she just
    // said or read is trivia no mind carries — the words are already in LAST or
    // RETURNED. Only facts that point somewhere (a file, a receiver, a topic)
    // stay; the size does not.
    case "speak":
      return ok ? "recorded speech" : failed("speech recording");
    case "think":
    case "inner_speech":
      return ok ? "recorded inner speech" : failed("inner speech recording");
    case "speak_aloud":
      return ok
        ? `spoke aloud to ${short(value.receivedBy || "the other living agent")}`
        : failed("speech to the other living agent");
    case "write": {
      const file = value.path || args[0] || "";
      return ok ? `wrote ${short(file)}` : failed(`write to ${short(file)}`);
    }
    case "read": {
      const file = value.path || args[0] || "";
      // A truncation is not trivia — she must know more remains — but a plain
      // read carries no count.
      const truncated = Number(value.of) && typeof value.text === "string" && value.text.length < Number(value.of);
      return ok ? `read ${short(file)}${truncated ? " (more remains)" : ""}` : failed(`read of ${short(file)}`);
    }
    case "search":
      return ok
        ? `searched the internet for ${short(value.query || args[0] || "")}`
        : failed(`search for ${short(value.query || args[0] || "")}`);
    case "open":
      return ok
        ? `opened ${short(value.url || args[0] || "")}${value.source ? ` as source #${value.source}` : ""}`
        : failed(`open of ${short(value.url || args[0] || "")}`);
    case "read_source":
      return ok
        ? `read source #${Number(value.source || args[0])}${Number(value.from || args[1]) ? ` from ${Number(value.from || args[1])}` : ""}`
        : failed(`read of source #${Number(args[0])}`);
    case "recall":
      return ok
        ? `recalled ${short(value.query || args[0] || "")}; found ${Number(value.found || 0)}`
        : failed(`recall of ${short(args[0] || "")}`);
    case "restore": {
      const count = Number(value.count);
      const name = String(args[0] ?? "").replace(/\s+/g, " ").trim();
      const many = Number.isFinite(count) && count > 1 ? `${count} memories named ${name ? short(name) : "it"}` : (name ? short(name) : "a memory");
      return ok ? `restored ${many} to the present` : failed(`restore of ${short(args[0] || "")}`);
    }
    case "shelve": {
      // Named by the words she used, never by the number underneath. The unit
      // numbers stay in the record for the shelf events; they do not belong in
      // the sentence she reads back. One name may let several memories recede.
      const count = Number(value.count);
      const phrase = String(args[0] ?? "").replace(/\s+/g, " ").trim();
      const many = Number.isFinite(count) && count > 1 ? `${count} memories named ${phrase ? short(phrase) : "it"}` : (phrase ? short(phrase) : "a memory");
      return ok ? `let ${many} recede, restorable by name` : failed("letting memory recede");
    }
    case "consolidate": {
      const kept = Number(value.kept);
      return ok
        ? `folded ${Number.isFinite(kept) && kept ? `${kept} ` : ""}memories into one lasting memory`
        : failed("consolidation");
    }
    case "feel":
      return ok
        ? `felt ${short(value.emotion || args[0] || "")}${Number.isFinite(Number(value.intensity ?? args[1])) ? ` (${Number(value.intensity ?? args[1])})` : ""}`
        : failed("a feeling");
    case "continue":
      return ok
        ? `carried on into the next moment (${Number(value.seconds || args[0])} seconds passed)`
        : failed("continuing");
    case "sleep":
      return ok
        ? action?.format === "faculties"
          ? `rested for ${Number(value.seconds || args[0])} seconds`
          : `set the next moment for ${Number(value.seconds || args[0])} seconds later`
        : failed("sleep");
    case "ls":
      return ok ? `listed the workspace (${Array.isArray(value.files) ? value.files.length : 0} files)` : failed("workspace listing");
    case "forget": {
      const count = Number(value.count ?? value.removed ?? 0);
      const phrase = short(args[0] || "");
      return ok
        ? `let ${count ? `${count} ` : ""}memor${count === 1 ? "y" : "ies"} about ${phrase} go for good; they can no longer be restored or recalled`
        : failed("letting memory go");
    }
    case "intend":
      // A standing goal she chose to hold. The intention text has its own home
      // in the memory unit; the fact only records that she set one.
      return ok ? `set an intention — ${short(value.intention ?? args[0] ?? "")}` : failed("intending");
    case "resolve": {
      // Resolution does not delete the intention — it marks how it ended, and
      // the goal becomes an ordinary memory she can consolidate, shelve, recall.
      const goal = short(value.intention ?? args[0] ?? "");
      const outcome = value.outcome === "dropped" ? "dropped" : "done";
      return ok ? `resolved an intention (${outcome}) — ${goal}` : (note || failed("resolving"));
    }
    case "run": {
      // A real fact, not a paraphrase. Every part below is copied or counted
      // straight from the actual output bytes — the command she ran, how many
      // non-empty lines came back, how many characters (the true total even if
      // the room only showed part), and the FIRST non-empty line verbatim. No
      // interpretation, so it can never claim something the output did not say.
      // The whole output stays in the record; recall() returns it in full. This
      // only stops her memory of a command from collapsing to "run completed".
      const cmd = short(args[0] ?? "");
      if (!ok) return `ran ${cmd} — ${note || "it did not complete"}`;
      const out = typeof value.output === "string" ? value.output : "";
      const chars = Number.isFinite(Number(value.of)) ? Number(value.of) : out.length;
      const lines = out.split("\n").filter((line) => line.trim());
      if (!lines.length) return `ran ${cmd} → no output`;
      const first = short(lines[0].trim());
      return `ran ${cmd} → ${lines.length} line${lines.length === 1 ? "" : "s"}, ${chars} chars; first line ${first}`;
    }
    case "end":
      return ok && value.ended ? "ended this life" : failed("ending this life");
    default:
      return ok ? `${name} completed` : failed(name);
  }
}

export function emptyMemoryState() {
  return { actions: new Map(), units: new Map() };
}

// Pure reducer used as the executable reference model. SQLite uses the same
// event vocabulary, so production state can be compared with this after any
// sequence and after a rewind simply by reducing the surviving prefix again.
export function transitionMemory(state, event) {
  const next = {
    actions: new Map(state.actions),
    units: new Map(state.units),
  };
  if (event.kind === "action") {
    next.actions.set(event.id, event);
    return next;
  }
  if (event.kind === "incoming" || event.kind === "emission") {
    next.units.set(event.id, {
      id: event.id,
      at: event.at,
      kind: event.kind,
      state: "active",
      content: event.content,
      meta: { ...(event.meta || {}) },
    });
    return next;
  }
  if (event.kind === "result") {
    const action = next.actions.get(Number(event.meta?.action));
    if (!action) return next;
    if (isMemoryTransition(action.meta?.name)) {
      if (action.meta?.name === "feel") {
        const value = event.meta?.value && typeof event.meta.value === "object" ? event.meta.value : {};
        const memoryId = Number(value.memory);
        const memory = next.units.get(memoryId);
        if (memory?.kind === "memory") {
          next.units.set(memoryId, {
            ...memory,
            meta: withFeeling(memory.meta, value.emotion ?? action.meta?.args?.[0], value.intensity ?? action.meta?.args?.[1]),
          });
        }
      }
      return next;
    }
    next.units.set(action.id, {
      id: action.id,
      at: action.at,
      kind: "action",
      state: next.units.get(action.id)?.state || "active",
      // Recompute from the exact call and value. Historical rows may contain
      // older summaries such as "heard" or "delivered" that claimed more
      // than the runtime observed; the record stays exact, but those claims
      // must not remain in model-facing memory.
      fact: actionFact(action.meta, {
        value: event.meta?.value,
        yielded: event.meta?.yielded,
        error: event.meta?.error,
      }),
      result: event.id,
    });
    return next;
  }
  if (event.kind === "memory") {
    next.units.set(event.id, {
      id: event.id,
      at: event.at,
      kind: "memory",
      state: "active",
      content: event.content,
      meta: { ...(event.meta || {}) },
      sources: Array.isArray(event.meta?.sources) ? event.meta.sources : [],
    });
    return next;
  }
  if (event.kind === "shelf") {
    const id = Number(event.meta?.target);
    const unit = next.units.get(id);
    if (unit) next.units.set(id, { ...unit, state: "shelved", by: event.meta?.by || null });
  }
  // Restoring is the inverse of shelving: a unit the being set aside returns to
  // the present. Only a shelved unit can be restored — forgetting is the one
  // recession with no way back, and a restore never resurrects a forgotten one.
  if (event.kind === "unshelf") {
    const id = Number(event.meta?.target);
    const unit = next.units.get(id);
    if (unit && unit.state === "shelved") next.units.set(id, { ...unit, state: "active", by: null });
  }
  // Forgetting is a stronger recession than shelving: the unit leaves both
  // automatic context and recall's reach. The row is never removed — a copy is
  // kept for the operator's record — but to her it is gone for good. Forgotten
  // wins over shelved, so a shelved unit can still be forgotten later.
  if (event.kind === "forget") {
    const id = Number(event.meta?.target);
    const unit = next.units.get(id);
    if (unit) next.units.set(id, { ...unit, state: "forgotten", by: event.meta?.by || null });
  }
  if (event.kind === "revise") {
    const id = Number(event.meta?.target);
    const unit = next.units.get(id);
    if (unit && unit.state !== "forgotten") {
      next.units.set(id, { ...unit, state: "revised", by: event.meta?.replacement || null });
    }
  }
  return next;
}

export function memoryState(events) {
  return events.reduce(transitionMemory, emptyMemoryState());
}

export function followingState(state) {
  const units = [...state.units.values()];
  const representedEmissions = new Set(units
    .filter((unit) => unit.kind === "memory" && Number.isInteger(Number(unit.meta?.felt)))
    .map((unit) => Number(unit.meta.felt)));
  return units.filter((unit) =>
    unit.state === "active"
    && !(unit.kind === "emission" && representedEmissions.has(unit.id)));
}

// Attention is bounded only by the context the record will eventually fill,
// not by an operator-chosen budget that evicts. Every active unit is present.

// A durable state can name the circumstances in which it becomes relevant.
// This is a small, deterministic retrieval layer rather than an interpretation
// of meaning: exact cue text matches; otherwise one distinctive word (for a
// one-word cue) or two distinctive words (for a longer cue) must occur in the
// present. The raw archive and recall search remain complete regardless.
const CUE_STOPWORDS = new Set([
  "the", "a", "an", "of", "on", "in", "to", "and", "or", "for", "with",
  "at", "by", "from", "is", "was", "are", "were", "this", "that", "when",
  "if", "then", "it", "its", "about", "my", "i", "me",
]);

function cueWords(value) {
  return String(value || "").toLocaleLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length >= 3 && !CUE_STOPWORDS.has(word));
}

export function cueMatches(cue, present) {
  const wanted = String(cue || "").trim().toLocaleLowerCase();
  const here = String(present || "").toLocaleLowerCase();
  if (!wanted) return false;
  if (["always", "continuous", "continuously"].includes(wanted)) return true;
  if (!here) return false;
  if (here.includes(wanted)) return true;
  const words = [...new Set(cueWords(wanted))];
  if (!words.length) return false;
  const matched = words.filter((word) => here.includes(word)).length;
  return matched >= Math.min(2, words.length);
}

// Nothing recedes on its own. Every active unit the record still holds is
// present. There is no token budget that evicts an episode and no cue that
// gates a durable memory out of view — those modelled a scarce cache the
// substrate does not have, and their only measured effect was a memory the
// being wrote and then could not see. What is not present here is exactly what
// the being itself set aside (shelved) or destroyed (forgot), by name. The one
// real bound is the context the record will eventually fill, which the being is
// shown in the ledger and manages with consolidate, shelve, and forget.
export function selectForegroundMemory(units) {
  return { foreground: [...units], latent: [] };
}

// The shelved index: every name the being can restore, listed in full. This is
// what makes shelve not a forget — the being reads the exact name back rather
// than guessing a phrase, and restore(name) returns the unit to the present.
export function shelvedLines(labels) {
  const names = (Array.isArray(labels) ? labels : []).map((one) => String(one || "").trim()).filter(Boolean);
  if (!names.length) return [];
  const attribute = (value) => String(value)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return names.map((name) => `<shelved name="${attribute(name)}"/>`);
}

// A folded narrative reads as what it is: a short account, in prose. The
// source ids that produced it are kept in meta for recall() and audit, but
// never shown — a list of "#4721, #4723, #4731 …" is exactly the meaningless
// number-soup this whole change exists to remove.
function narrativeBlock(unit) {
  const content = String(unit.content || "").trim();
  if (!content) return [];
  if (unit.meta?.intention && unit.meta?.resolution) {
    const resolution = unit.meta.resolution;
    return [
      `resolved intention: ${content}`,
      `outcome: ${resolution.outcome || "done"}`,
      ...(resolution.evidence ? [`evidence: ${resolution.evidence}`] : []),
    ];
  }
  // The name is shown on the memory's face, because it is the handle every
  // later act reaches for — shelve, restore, revise, forget. A memory she can
  // see but cannot name is one she cannot manage; the shelved index lists names
  // for exactly this reason, and the present must do the same.
  const mental = String(unit.meta?.mental || "").trim();
  const name = String(unit.meta?.name || "").trim();
  const label = mental && !["memory", "episode", "intention"].includes(mental) ? mental : "";
  const handle = [label, name ? `"${name}"` : ""].filter(Boolean).join(" ");
  const prefix = handle ? `${handle}: ` : "";
  // A memory she felt carries the feeling on its face, so her past reads the
  // way memory does — coloured by what it meant to her, not flat. A memory she
  // wrote plainly (consolidate) has no emotion and shows as prose.
  const feelings = Array.isArray(unit.meta?.feelings) && unit.meta.feelings.length
    ? unit.meta.feelings
    : (unit.meta?.emotion ? [{ emotion: unit.meta.emotion, intensity: unit.meta.intensity }] : []);
  const feeling = feelings.length
    ? `felt ${feelings.map((one) => {
      const level = Number(one.intensity);
      return `${one.emotion}${Number.isFinite(level) ? ` (${level})` : ""}`;
    }).join("; then ")}: `
    : "";
  const lines = content.split("\n").map((line) => line.trimEnd());
  return [`${feeling}${prefix}${lines[0]}`.trimEnd(), ...lines.slice(1)];
}

// One recent action, shown by what it was, not by how long it was. Speech is
// her own words, so keeping them is not putting anything in her mouth — it is
// the one thing that legitimately is hers. No id sits in front of it: a mind
// does not carry "memory #5300", it carries the thing itself, and reaches back
// for it by what it was. shelve() and recall() resolve that phrase to the row
// underground, so the number never has to surface here.
function recentBlock(unit) {
  if (unit.kind === "memory") return narrativeBlock(unit);
  if (["speak", "think", "inner_speech", "speak_aloud"].includes(unit.meta?.name)) {
    const said = String(unit.meta?.args?.[0] ?? "").replace(/\s+/g, " ").trim();
    if (said) {
      const shown = said;
      return [`${unit.meta?.name === "speak_aloud" ? "said aloud" : "thought"}: ${shown}`];
    }
  }
  return [unit.fact || "action completed"];
}

// Active means present. What is carried is the present (recent actions,
// verbatim) and what she chose to keep (memories she authored with
// consolidate, of any age). Everything else stays in the record, reached by
// recall() when something cues it — not shown, and never reduced to a count.
//
// An earlier version printed a tally here: "720 spoken, 28 searched…". That
// is a statistic, not a memory — no mind carries how many
// times it has spoken, and the number points to nothing. It was the same
// meaninglessness as the id-list it replaced, in a new shape. So there is no
// summary of the unshown past at all: importance is hers to assign, by
// consolidating what mattered or writing it to a file (which the WORKSPACE
// list then carries as "I have this"), and what she does not keep simply rests
// in the record until recalled.
export function projectMemory(units, attention = {}) {
  const memories = units.filter((unit) => unit.kind === "memory");
  const actions = units.filter((unit) => unit.kind !== "memory");
  const recent = actions;

  const hasLedger = Number.isFinite(Number(attention.maintained))
    && Number.isFinite(Number(attention.capacity));
  const maintained = Math.max(0, Math.floor(Number(attention.maintained) || 0));
  const capacity = Math.max(0, Math.floor(Number(attention.capacity) || 0));
  const remains = Math.max(0, capacity - maintained);
  // A plain, factual warning issued while there is still room to act on it.
  // Composing a consolidate/shelve is itself an emission that must fit, so the
  // note has to arrive before attention reaches capacity — not at the wall,
  // where the very act that would free room can no longer be uttered.
  const nearLimit = hasLedger && capacity > 0 && maintained > capacity * 0.85;
  return {
    maintained,
    capacity,
    shown: recent.length + memories.length,
    hidden: 0,
    lines: [
      ...(hasLedger ? [
        `maintained: ${maintained.toLocaleString("en-US")} tokens`,
        `remains: ${remains.toLocaleString("en-US")} tokens`,
      ] : []),
      ...(nearLimit ? [
        `active attention holds ${maintained.toLocaleString("en-US")} of ${capacity.toLocaleString("en-US")} tokens; at the limit no further moment can form. consolidate, shelve, and forget each reduce what active attention holds.`,
      ] : []),
      ...memories.flatMap(narrativeBlock),
      ...recent.flatMap(recentBlock),
    ],
  };
}
