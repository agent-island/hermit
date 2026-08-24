import path from "node:path";
import { rm, mkdir, writeFile } from "node:fs/promises";
import { loadSetup } from "./setup.mjs";

// Put her back exactly as she was at a chosen moment, and let it run again.
//
// This is not undo. Nothing here changes what happened — it removes it. The
// life after that point is gone, and she has no way to know it ever existed.
//
// It is worth having because sampling is stochastic: the same room, run twice,
// does not produce the same moment. Rewinding to a decision and replaying it
// several times is the only way to tell a choice apart from a coin landing —
// which is exactly the question you cannot answer by watching a life once.
//
// Everything is reconstructed from the record rather than from a snapshot,
// because the record is the only thing guaranteed to be true. The workspace is
// rebuilt by replaying her write() calls in order, so it ends up holding
// exactly what her own hands had put there by that point.
export async function rewind(log, workspace, toId) {
  const target = Number(toId);
  if (!Number.isFinite(target)) throw new Error("rewind needs an event id");

  // Observer-owned settings are not part of her mutable workspace. Older
  // setup events only recorded the room and arrival, so retain the other
  // values when replaying those lives instead of silently reverting them.
  const currentSetup = loadSetup(log);
  const removed = log.rewind(target);

  // What the loop carries between moments, recomputed from what is left.
  const lastWorld = log.last("world");
  const lastEmission = log.lastCarriedEmission();
  const lastIncoming = log.last("incoming");

  log.set("last_emission", lastEmission?.content ?? null);
  log.set("last_moment_at", lastWorld?.at ?? null);
  log.set("last_seen_incoming_id", lastIncoming?.id ?? 0);
  log.set("last_results", lastWorld ? log.lastMomentResults() : []);

  // The room as it stood then. A rewrite is an event like any other, so if the
  // one that changed the room has just been removed, the room goes back too —
  // otherwise she would be rewound into a world she never chose.
  const lastSetup = log.last("setup");
  log.set("setup_v2", lastSetup
    ? {
        ...currentSetup,
        template: lastSetup.content,
        arrival: lastSetup.meta?.arrival || currentSetup.arrival,
        context: lastSetup.meta?.context || currentSetup.context,
        heartbeat: typeof lastSetup.meta?.heartbeat === "boolean"
          ? lastSetup.meta.heartbeat
          : currentSetup.heartbeat,
      }
    : { ...currentSetup });

  // Her workspace as her own hands left it at that point.
  await rm(workspace, { recursive: true, force: true });
  await mkdir(workspace, { recursive: true });
  let files = 0;
  for (const event of log.units()) {
    if (event.kind !== "action" || event.meta?.name !== "write") continue;
    if (!event.result || event.result.meta?.yielded === false || event.result.meta?.value?.status === "failed") continue;
    const [name, text] = event.meta.args || [];
    if (typeof name !== "string") continue;
    const file = path.resolve(workspace, String(name).replace(/^\/+/, ""));
    if (!file.startsWith(path.resolve(workspace) + path.sep)) continue;
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, String(text ?? ""), "utf8");
    files += 1;
  }

  return { removed, remaining: log.count(), files, at: lastWorld?.at ?? null, room: lastSetup ? "restored to the one in force then" : "the authored room remained in force" };
}

// Somewhere worth going back to: every moment, with the first thing she said
// in it, and whether she used her voice.
export function points(log) {
  const events = log.since(0, 1_000_000);
  const list = [];
  let current = null;
  for (const event of events) {
    if (event.kind === "world") {
      current = { id: event.id, at: event.at, line: "", spoke: false, calls: [] };
      list.push(current);
      continue;
    }
    if (!current) continue;
    if (event.kind === "emission" && !current.line) {
      current.line = event.content.split("\n").map((l) => l.trim()).filter(Boolean)[0] || "";
    }
    if (event.kind === "action") {
      current.calls.push(event.meta?.name);
      if (["speak", "think", "speak_aloud"].includes(event.meta?.name)) current.spoke = true;
    }
  }
  return list;
}
