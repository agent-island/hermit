// The black box.
//
// An append-only mirror of every raw model response, written OUTSIDE any
// per-agent data directory. The live SQLite record is the primary log, but it
// lives inside a folder that a rerun can reuse, a wipe can reset, and a rewind
// can shorten — and once, that cost us the full text and reasoning of the two
// most important lives. This file cannot be touched by any of those: it is
// opened only in append mode, keyed by life, and never overwritten or deleted
// by the runtime. If the SQLite is ever lost, the raw responses — full text and
// reasoning verbatim — still survive here.
//
// A returned model response is not allowed to pass silently if this copy
// cannot be made. The SQLite event is the other copy; callers attempt both and
// surface either failure. fsync closes the small power-loss window left by an
// ordinary append whose bytes have reached only the operating-system cache.
import { closeSync, fsyncSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const DIR = process.env.AMI_BLACKBOX_DIR || path.join(os.homedir(), ".ami-blackbox");
let ready = false;
function ensure() {
  if (!ready) { mkdirSync(DIR, { recursive: true }); ready = true; }
}

// One append-only file per (data-folder, model). Reusing a folder for a new
// life appends to the same file rather than replacing it, so no earlier life's
// raw record is ever displaced — entries carry their own run id and timestamp
// to tell the lives apart.
export function blackboxFile(dataDir, model) {
  const folder = path.basename(dataDir || "life").replace(/[^A-Za-z0-9._-]+/g, "-") || "life";
  const m = String(model || "model").replace(/[^A-Za-z0-9._-]+/g, "-");
  return path.join(DIR, `${folder}--${m}.jsonl`);
}

export function recordRaw(file, entry) {
  ensure();
  const fd = openSync(file, "a", 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(entry)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
