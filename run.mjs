// The conditions a life was run under: which seed, which upstream provider,
// which quantization.
//
// These live in her record rather than beside the API key, because they are
// not settings — they are the independent variables. Two lives from the same
// starting world differ only in the seed, and an exported life that does not
// say which seed produced it cannot be compared with another one. The model
// choice is an operator setting; the seed is the experiment.
//
// Nothing here ever reaches the room. She is not told what seed she is, for
// the same reason she is not told the host path: it is a fact about the run,
// not about her world, and she would read an identity off it.

const KEY = "run_v1";

export const DEFAULT_RUN = {
  // null means "let the provider sample as it likes". A number asks for
  // deterministic sampling, which OpenRouter forwards and most but not all
  // upstreams honour. Determinism is requested here, never assumed: whether
  // it held is decided by comparing the records, not by trusting the flag.
  seed: null,
  // Provider slugs in order, e.g. ["deepinfra/turbo"]. Without a pin, two
  // lives on the same model name can be served by different upstreams at
  // different quantizations — the same weights in name only. That is a
  // difference between lives that nobody chose and nobody recorded.
  provider: null,
  // e.g. ["fp8"]. Filters which upstreams are eligible.
  quantizations: null,
  // Pinning a provider is pointless if a fallback silently serves the request
  // from somewhere else, so this defaults to off whenever a pin is set.
  allowFallbacks: true,
};

function clean(value) {
  const next = { ...DEFAULT_RUN };
  const seed = Number(value?.seed);
  next.seed = Number.isFinite(seed) && value?.seed !== null && value?.seed !== ""
    ? Math.floor(seed)
    : null;
  const order = list(value?.provider);
  next.provider = order.length ? order : null;
  const quant = list(value?.quantizations);
  next.quantizations = quant.length ? quant : null;
  next.allowFallbacks = value?.allowFallbacks === undefined
    ? !next.provider
    : Boolean(value.allowFallbacks);
  return next;
}

function list(value) {
  if (value == null) return [];
  const items = Array.isArray(value) ? value : String(value).split(/[,\s]+/);
  return items.map((one) => String(one).trim()).filter(Boolean);
}

export function loadRun(log) {
  return clean(log.get(KEY, null) ?? DEFAULT_RUN);
}

// Recorded as an event as well as stored, so the change is visible at the
// moment it happened rather than only as a current value.
export function saveRun(log, value) {
  const patch = value && typeof value === "object" ? value : {};
  const merged = { ...loadRun(log), ...patch };
  // Setting a pin without saying anything about fallbacks means the pin.
  // Carrying the previous default forward here would let a request routed
  // somewhere else keep calling itself pinned.
  if (patch.allowFallbacks === undefined && patch.provider !== undefined) {
    delete merged.allowFallbacks;
  }
  const next = clean(merged);
  log.set(KEY, next);
  log.append("run", describeRun(next), { ...next, by: "observer" });
  return next;
}

export function describeRun(run) {
  const parts = [
    run.seed === null ? "seed: sampled freely" : `seed: ${run.seed}`,
    run.provider ? `provider: ${run.provider.join(", ")}` : "provider: any",
  ];
  if (run.quantizations) parts.push(`quantization: ${run.quantizations.join(", ")}`);
  if (run.provider && !run.allowFallbacks) parts.push("no fallbacks");
  return parts.join("  ·  ");
}

// What goes on the wire. Absent fields are absent, not null: a provider that
// receives `seed: null` may treat it differently from one that never saw the
// key at all, and this must not be the thing that separates two lives.
export function runFields(run) {
  const fields = {};
  if (run?.seed !== null && run?.seed !== undefined) fields.seed = run.seed;
  const provider = {};
  if (run?.provider?.length) {
    provider.order = run.provider;
    provider.allow_fallbacks = Boolean(run.allowFallbacks);
  }
  if (run?.quantizations?.length) provider.quantizations = run.quantizations;
  if (Object.keys(provider).length) fields.provider = provider;
  return fields;
}
