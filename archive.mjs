import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { DatabaseSync, backup } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { buildLife } from "./export.mjs";
import { buildMarkdown } from "./markdown.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function safeName(value, fallback) {
  const text = String(value || fallback).trim().replace(/[^a-zA-Z0-9._-]+/g, "-");
  return text.replace(/^-+|-+$/g, "") || fallback;
}

function jsonLines(rows) {
  return rows.length ? `${rows.map((row) => JSON.stringify(row)).join("\n")}\n` : "";
}

// Make one transactionally consistent, portable record of a life. The SQLite
// backup API includes committed pages still living in WAL; copying ami.sqlite
// by itself does not. Reasoning is also written separately so the most
// important trace can be inspected without knowing the event schema.
export async function archiveLife(log, {
  archiveDir = path.join(HERE, "archive"),
  reason = "stopped",
  label = path.basename(path.dirname(log.file)) || "life",
} = {}) {
  const events = log.since(0, 1_000_000);
  if (!events.length) return null;

  const reasoning = events
    .filter((event) => ["reasoning", "reasoning_details"].includes(event.kind))
    .map((event) => ({
      id: event.id,
      at: event.at,
      kind: event.kind,
      model: event.meta?.model ?? null,
      reasoningTokens: event.meta?.reasoningTokens ?? null,
      content: event.content,
    }));
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const base = path.join(
    archiveDir,
    `${stamp}--${safeName(label, "life")}--${safeName(reason, "saved")}--${events.length}events`,
  );

  await mkdir(archiveDir, { recursive: true });
  await backup(log.db, `${base}.sqlite`);

  // Verify the authoritative snapshot before reporting success or allowing a
  // destructive reset to continue.
  const snapshot = new DatabaseSync(`${base}.sqlite`, { readOnly: true });
  let saved;
  try {
    saved = snapshot.prepare(`
      SELECT
        COUNT(*) AS events,
        SUM(CASE WHEN kind IN ('reasoning', 'reasoning_details') THEN 1 ELSE 0 END) AS reasoning
      FROM events
    `).get();
  } finally {
    snapshot.close();
  }
  if (Number(saved.events) !== events.length || Number(saved.reasoning) !== reasoning.length) {
    throw new Error(
      `archive verification failed: expected ${events.length} events/${reasoning.length} reasoning, ` +
      `found ${saved.events}/${saved.reasoning}`,
    );
  }

  await Promise.all([
    writeFile(`${base}.html`, buildLife(log), "utf8"),
    writeFile(`${base}.md`, buildMarkdown(log), "utf8"),
    writeFile(`${base}.events.jsonl`, jsonLines(events), "utf8"),
    writeFile(`${base}.reasoning.jsonl`, jsonLines(reasoning), "utf8"),
  ]);

  return {
    base,
    sqlite: `${base}.sqlite`,
    reasoning: `${base}.reasoning.jsonl`,
    events: events.length,
    reasoningEvents: reasoning.length,
    reasoningTextEvents: reasoning.filter((event) => event.kind === "reasoning").length,
    reasoningDetailEvents: reasoning.filter((event) => event.kind === "reasoning_details").length,
  };
}
