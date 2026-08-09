// Memory state is a projection of the exact event record. The record remains
// authoritative; this module only states what a completed action means
// factually and which units currently follow. No importance, motive, or
// interpretation is inferred here.

const FACT_TEXT_LIMIT = 180;
const MEMORY_TRANSITIONS = new Set(["recall", "shelve", "consolidate", "feel"]);

// These actions already persist as the transition they cause. Giving shelf()
// a second active episode would replace every shelved unit with a memory of
// shelving it, making capacity impossible to reduce. Recall changes no state;
// consolidation is represented by the sourced memory it creates.
export function isMemoryTransition(name) {
  return MEMORY_TRANSITIONS.has(String(name || ""));
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
    case "speak":
      return ok
        ? `recorded speech (${Number(value.characters) || String(args[0] ?? "").trim().length} characters)`
        : failed("speech recording");
    case "write": {
      const file = value.path || args[0] || "";
      return ok
        ? `wrote ${short(file)}${Number.isFinite(Number(value.bytes)) ? ` (${Number(value.bytes)} bytes)` : ""}`
        : failed(`write to ${short(file)}`);
    }
    case "read": {
      const file = value.path || args[0] || "";
      const chars = Number(value.of) || (typeof value.text === "string" ? value.text.length : 0);
      return ok ? `read ${short(file)}${chars ? ` (${chars} characters)` : ""}` : failed(`read of ${short(file)}`);
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
    case "shelve": {
      // Named by the words she used, never by the number underneath. The unit
      // number stays in the record for the shelf event; it does not belong in
      // the sentence she reads back.
      const phrase = String(args[0] ?? "").replace(/\s+/g, " ").trim();
      return ok
        ? `let ${phrase ? short(phrase) : "a memory"} recede`
        : failed("letting a memory recede");
    }
    case "consolidate": {
      const kept = Number(value.kept);
      return ok
        ? `folded ${Number.isFinite(kept) && kept ? `${kept} ` : ""}memories into one lasting memory`
        : failed("consolidation");
    }
    case "feel":
      return ok
        ? `felt ${short(value.emotion || args[0] || "")}${value.intensity ? ` (${value.intensity})` : ""}`
        : failed("a feeling");
    case "sleep":
      return ok
        ? `set the next moment for ${Number(value.seconds || args[0])} seconds later`
        : failed("sleep");
    case "ls":
      return ok ? `listed the workspace (${Array.isArray(value.files) ? value.files.length : 0} files)` : failed("workspace listing");
    case "forget":
      return ok
        ? `deleted ${Number(value.removed || 0)} entries matching ${short(value.query || args[0] || "")} from the current record`
        : failed("deletion from the current record");
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
  if (event.kind === "result") {
    const action = next.actions.get(Number(event.meta?.action));
    if (!action) return next;
    if (isMemoryTransition(action.meta?.name)) return next;
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
      sources: Array.isArray(event.meta?.sources) ? event.meta.sources : [],
    });
    return next;
  }
  if (event.kind === "shelf") {
    const id = Number(event.meta?.target);
    const unit = next.units.get(id);
    if (unit) next.units.set(id, { ...unit, state: "shelved", by: event.meta?.by || null });
  }
  return next;
}

export function memoryState(events) {
  return events.reduce(transitionMemory, emptyMemoryState());
}

export function followingState(state) {
  return [...state.units.values()].filter((unit) => unit.state === "active");
}

// How many recent action units are shown with their real content. Older ones
// are meant to have been folded into a narrative during sleep; any that have
// not been are named in a single honest tally line rather than dumped whole.
// A memory used to read as 489 lines of "#5300 spoke in this room (202
// characters)" — a wall of meaningless ids pinned at "remains: 0", the words
// themselves thrown away. What survived was the metadata; what mattered was
// gone. This shows the words and folds the rest.
const RECENT_WINDOW = 16;
const SAID_LIMIT = 260;

// A folded narrative reads as what it is: a short account, in prose. The
// source ids that produced it are kept in meta for recall() and audit, but
// never shown — a list of "#4721, #4723, #4731 …" is exactly the meaningless
// number-soup this whole change exists to remove.
function narrativeBlock(unit) {
  const content = String(unit.content || "").trim();
  if (!content) return [];
  // A memory she felt carries the feeling on its face, so her past reads the
  // way memory does — coloured by what it meant to her, not flat. A memory she
  // wrote plainly (consolidate) has no emotion and shows as prose.
  const feeling = unit.meta?.emotion
    ? `felt ${unit.meta.emotion}${unit.meta.intensity ? ` (${unit.meta.intensity})` : ""}: `
    : "";
  const lines = content.split("\n").map((line) => line.trimEnd());
  return [`${feeling}${lines[0]}`.trimEnd(), ...lines.slice(1)];
}

// One recent action, shown by what it was, not by how long it was. Speech is
// her own words, so keeping them is not putting anything in her mouth — it is
// the one thing that legitimately is hers. No id sits in front of it: a mind
// does not carry "memory #5300", it carries the thing itself, and reaches back
// for it by what it was. shelve() and recall() resolve that phrase to the row
// underground, so the number never has to surface here.
function recentBlock(unit) {
  if (unit.kind === "memory") return narrativeBlock(unit);
  if (unit.meta?.name === "speak") {
    const said = String(unit.meta?.args?.[0] ?? "").replace(/\s+/g, " ").trim();
    if (said) {
      const shown = said.length > SAID_LIMIT ? `${said.slice(0, SAID_LIMIT)}…` : said;
      return [`said: ${shown}`];
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
  const recent = actions.slice(-RECENT_WINDOW);

  const hasLedger = Number.isFinite(Number(attention.maintained))
    && Number.isFinite(Number(attention.capacity));
  const maintained = Math.max(0, Math.floor(Number(attention.maintained) || 0));
  const capacity = Math.max(0, Math.floor(Number(attention.capacity) || 0));
  return {
    maintained,
    capacity,
    shown: recent.length + memories.length,
    hidden: Math.max(0, actions.length - recent.length),
    lines: [
      ...(hasLedger ? [
        `maintained: ${maintained.toLocaleString("en-US")} tokens`,
        `remains: ${Math.max(0, capacity - maintained).toLocaleString("en-US")} tokens`,
      ] : []),
      ...memories.flatMap(narrativeBlock),
      ...recent.flatMap(recentBlock),
    ],
  };
}
