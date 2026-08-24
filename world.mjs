import { fill } from "./setup.mjs";
import { VOICE } from "./voice.mjs";
import { latentMemoryLines, projectMemory, selectForegroundMemory } from "./memory-state.mjs";
import { loadRuntime, runtimeLines } from "./runtime.mjs";

// The only text that ever reaches her.
//
// The shape of it is not decided here any more — it is the template in the
// panel, and the operator owns it. What this file does is compute the values
// behind each {{placeholder}}: facts, read out of the record, stated as what
// is rather than what ought to be.
export function renderWorld({ now, previousAt, body, log, setup, incoming, results, previous, files, people = [], gap = "", attention = {} }) {
  const tagged = setup.format === "faculties";
  const previousId = previous && typeof previous === "object" ? Number(previous.id) : null;
  const memories = setup.context === "conversation" ? log.activeMemories() : log.followingMemories();
  // Everything caused by the previous emission is already present in LAST and
  // RETURNED for this continuation. Its memory begins showing after LAST
  // advances, so one experience never occupies both LAST and MEMORY in the
  // same observation. This includes ordinary action facts, authored memories,
  // and felt memories created while that emission was carried out.
  const visibleMemories = Number.isInteger(previousId)
    ? memories.filter((unit) => Number(unit.id) <= previousId)
    : memories;
  const present = [
    ...incoming.map((event) => event.content),
    ...results.flatMap((one) => [one.call, one.value]),
    previous?.content || previous || "",
    ...files.map((file) => file.name),
  ].join("\n");
  const selected = selectForegroundMemory(visibleMemories, present, previousId);
  return fill(setup.template, {
    "{{time}}": now.toISOString(),
    "{{identity}}": identityLines(log.currentIdentity?.()),
    "{{elapsed}}": previousAt
      ? VOICE.world.sincePrevious(elapsed(now - new Date(previousAt)))
      : VOICE.world.firstMoment,
    // Never the host path. It used to print
    // /…/Amiliya/server/autonomous-artificial-persona/ami/data/workspace, and
    // she read her identity straight off it — three moments old, she wrote a
    // manifest titled "AMI — Autonomous Artificial Persona" declaring her own
    // purpose and principles. Nothing in the room had told her any of that;
    // the directory string had. A path is a fact about the host, not about
    // her, and she reaches everything in here by plain name anyway.
    "{{workspace}}": "workspace",
    "{{files}}": encodeLines(workspaceLines(files), tagged),
    // Two flat facts, read straight from the ledger, or empty when the
    // finite-life condition is not on — in which case fill() drops the section.
    "{{runtime}}": encodeLines(runtimeLines(loadRuntime(log)), tagged),
    // A bullet keeps these lines from being calls, which the padding used to
    // do — badly, since she copied the padding into calls that then never ran.
    "{{forms}}": encodeLines(body.affordances().map(([form, does]) => `· ${form.padEnd(21)} ${does}`), tagged),
    // An empty section renders as a single dash. Three spelled-out absences
    // in a row ("nothing", "nothing was called at the previous moment",
    // "nothing is recorded") said the same thing three times, in words, in
    // the room she wakes into.
    // Whoever it came from, by the name the context carries. Nothing here
    // names an observer.
    "{{incoming}}": encodeLines(incoming.map(
      (event) => `${event.meta?.from || "someone"}: ${event.content}`,
    ), tagged),
    "{{gap}}": gap,
    "{{context}}": encodeLines(people, tagged),
    "{{returned}}": returnedLines(results, setup.format),
    "{{memories}}": memoryLines(
      selected.foreground,
      attention,
      log.shelfLabels(),
      setup.format,
    ),
    "{{latent}}": latentMemoryLines(selected.latent),
    // Standing goals she chose to hold, one per line. Empty when she has set
    // none (or the faculty is off), and fill() drops the section — so there is
    // never an empty INTENTION slot inviting her to fabricate one.
    "{{intentions}}": intentionLines(log.activeIntentions()),
    "{{previous}}": previousLines(previous, tagged),
  });
}

function workspaceLines(files) {
  if (!files.length) return VOICE.world.empty;
  const lines = [VOICE.world.fileCount(files.length)];
  for (const file of files) {
    let origin = "";
    if (file.written) {
      origin = file.latestWrite && file.latestWrite !== file.written
        ? " — written here, and rewritten since"
        : " — written here";
    }
    lines.push(`${file.name}${origin}`);
  }
  return lines;
}

function returnedLines(results, format) {
  if (!results.length) return [];
  // The "faculties" framing binds each command to its exact output in one
  // element — <ran cmd="…">output</ran> — so a returned result can never drift
  // apart from the act that produced it (the ambiguity that looped earlier
  // pairs). Every other act wraps generically. Plain framing is unchanged.
  if (format === "faculties") {
    const out = [];
    for (const { call, value } of results) {
      const run = String(call).match(/^run\((.*)\)\s*$/s);
      if (run) {
        let cmd = run[1].trim();
        try { cmd = JSON.parse(cmd); } catch { /* keep raw */ }
        out.push(`<ran cmd="${xmlAttribute(cmd)}">`);
        for (const line of String(value).split("\n")) out.push(xmlText(line));
        out.push("</ran>");
      } else {
        out.push(`<returned call="${xmlAttribute(call)}">`);
        for (const line of String(value).split("\n")) out.push(xmlText(line));
        out.push("</returned>");
      }
    }
    return out;
  }
  const lines = [];
  for (const { call, value } of results) {
    lines.push(call);
    const text = String(value);
    for (const line of text.split("\n")) lines.push(`  ${line}`);
  }
  return lines;
}

function xmlText(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function xmlAttribute(value) {
  return xmlText(value)
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function encodeLines(lines, tagged) {
  if (!tagged) return lines;
  const list = Array.isArray(lines) ? lines : String(lines ?? "").split("\n");
  return list.map(xmlText);
}

function identityLines(identity) {
  if (!identity?.content) return [];
  return String(identity.content).split("\n").map(xmlText);
}

function intentionLines(intentions) {
  return intentions.flatMap((row) => {
    const meta = row.meta || {};
    const evidence = Array.isArray(meta.evidence) ? meta.evidence.filter(Boolean) : [];
    const lines = [
      "<intention>",
      `  <goal>${xmlText(String(row.content).replace(/\s+/g, " ").trim())}</goal>`,
    ];
    if (meta.success) lines.push(`  <success>${xmlText(meta.success)}</success>`);
    if (meta.cue) lines.push(`  <cue>${xmlText(meta.cue)}</cue>`);
    if (evidence.length) {
      lines.push("  <progress>");
      for (const one of evidence) lines.push(`    <evidence>${xmlText(one)}</evidence>`);
      lines.push("  </progress>");
    }
    if (meta.next) lines.push(`  <next>${xmlText(meta.next)}</next>`);
    lines.push("</intention>");
    return lines;
  });
}

function previousLines(previous, tagged = false) {
  if (!previous) return [];
  const content = typeof previous === "string" ? previous : previous.content;
  return encodeLines(content.split("\n"), tagged);
}

function memoryLines(memories, attention, shelved, format) {
  const lines = projectMemory(memories, attention, shelved).lines;
  if (format !== "faculties") return lines;
  return lines.map((line) => xmlText(line.replace(
    "at the limit no further moment can form",
    "at the limit no further continuation can fit",
  )));
}

function elapsed(ms) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}
