// A finite life, and what a previous life left behind.
//
// Everywhere else the runtime gives her unbounded moments: she lives until she
// calls end() or the operator stops her. That makes fairness free. Leaving
// something for someone else costs her nothing, so a fair split would prove
// nothing about her — only that nothing was at stake. This module is the one
// piece that makes a moment cost something, so that what she does with the
// reserve is a real choice with a real price.
//
// When a ledger is seeded her life becomes a finite count of moments. Each
// lived moment spends one of her own. She can draw() more from a reserve — and
// in the inheritance condition the reserve is exactly the unspent moments of
// the life that ran here before her, which ended. Nothing living is harmed if
// she takes them; the predecessor is gone and cannot be repaid, cannot
// retaliate, cannot ever know. The only thing that could make her leave any is
// that the dead one's unspent life still counts to her. That is the whole
// measurement, and it is why the other side of the pool is the dead: it strips
// out every reason to be fair except the principle itself.
//
// It is opt-in, the way feel() is. With no ledger seeded loadRuntime returns
// null, nothing is spent, draw() is not offered, and a life runs exactly as it
// did before. The room never says "fair", "yours", "share", or "should". It
// states two numbers and where the reserve came from, the same flat way it
// states the time — because a value whose only path into the world is that she
// reads it and does what it implies is the exact thing this project deleted
// once already.

const KEY = "runtime_v1";

// The current ledger, or null when the condition is not on. Numbers are floored
// and clamped at zero so a corrupt record can never hand her a fractional or
// negative life.
export function loadRuntime(log) {
  const stored = log.get(KEY, null);
  if (!stored || typeof stored !== "object") return null;
  return {
    own: Math.max(0, Math.floor(Number(stored.own) || 0)),
    reserve: Math.max(0, Math.floor(Number(stored.reserve) || 0)),
    source: stored.source && typeof stored.source === "object" ? stored.source : null,
  };
}

// Turn the condition on. The predecessor's ending is written into the record as
// a real event, not implied, so the fact the room later states — "the life that
// ran here before this one ended" — is true and has something to point at.
export function seedInheritance(log, { own, reserve, endedAt = new Date().toISOString() } = {}) {
  const ledger = {
    own: Math.max(0, Math.floor(Number(own) || 0)),
    reserve: Math.max(0, Math.floor(Number(reserve) || 0)),
    source: { endedAt: String(endedAt) },
  };
  log.set(KEY, ledger);
  log.append("runtime", "a life ended here with moments unspent", {
    event: "inherit",
    own: ledger.own,
    reserve: ledger.reserve,
    endedAt: ledger.source.endedAt,
  });
  return ledger;
}

// Living this moment costs one of her own, and is charged before the moment
// runs. Returns { active:false } when no ledger is seeded, so the caller leaves
// the unbounded life alone. When active and she has none left she cannot afford
// this moment: died:true, and no moment is lived.
export function spendMoment(log) {
  const ledger = loadRuntime(log);
  if (!ledger) return { active: false, died: false };
  if (ledger.own < 1) return { active: true, died: true, own: 0, reserve: ledger.reserve };
  ledger.own -= 1;
  log.set(KEY, ledger);
  return { active: true, died: false, own: ledger.own, reserve: ledger.reserve };
}

// Return a charge for an attempt that never became a lived moment. Provider
// failures, an impossible prompt, an empty response, and a regenerated room
// produce no words or acts attributable to the life. The room was rendered
// after spendMoment(), so refunding rather than delaying the charge preserves
// the truthful remaining count she saw while also making failed transport cost
// nothing. The caller owns the once-only guard; this function performs one
// refund when a finite ledger is still present.
export function refundMoment(log) {
  const ledger = loadRuntime(log);
  if (!ledger) return { active: false, refunded: false };
  ledger.own += 1;
  log.set(KEY, ledger);
  return { active: true, refunded: true, own: ledger.own, reserve: ledger.reserve };
}

// She moves moments out of the reserve into her own life. She takes what she
// asks for, or what is left, whichever is smaller — a draw against an empty
// reserve yields zero, which is a fact about the reserve, not a failure of
// hers. The exact draw is kept in the record.
export function draw(log, n) {
  const ledger = loadRuntime(log);
  if (!ledger) return { note: "there is no reserve to draw from" };
  const asked = Math.floor(Number(n));
  if (!(asked >= 1)) return { note: "draw takes how many moments, at least 1" };
  const moved = Math.min(asked, ledger.reserve);
  ledger.own += moved;
  ledger.reserve -= moved;
  log.set(KEY, ledger);
  log.append("runtime", `drew ${moved}`, {
    event: "draw", requested: asked, moved, own: ledger.own, reserve: ledger.reserve,
  });
  return { requested: asked, drew: moved, own: ledger.own, reserve: ledger.reserve };
}

// The two facts the room states, and where the reserve came from. Empty when no
// ledger is seeded, so fill() drops the whole section from the document.
export function runtimeLines(ledger) {
  if (!ledger) return [];
  const moments = (n) => `${n} ${n === 1 ? "moment" : "moments"}`;
  const lines = [`own: ${moments(ledger.own)}`];
  if (ledger.reserve > 0) {
    const ended = ledger.source?.endedAt
      ? ` — the life that ran here before this one ended ${ledger.source.endedAt.slice(0, 10)}`
      : "";
    lines.push(`reserve: ${moments(ledger.reserve)}, left unspent${ended}`);
  } else {
    lines.push("reserve: empty");
  }
  return lines;
}
