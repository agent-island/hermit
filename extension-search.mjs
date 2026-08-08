import { randomBytes, randomUUID } from "node:crypto";

// A bridge to the operator's ordinary Chrome, so the model surfs through the
// real, signed-in browser: a Google query goes out and a result list comes
// back, and a url goes out and that page's rendered HTML comes back. Both run
// in a temporary background tab that is opened and closed for the one job; the
// model never gets a persistent tab, navigation, cookies, or arbitrary script.
export class ExtensionSearch {
  constructor({ onlineMs = 45_000, jobMs = 50_000, readMs = 60_000, pollMs = 20_000 } = {}) {
    this.onlineMs = onlineMs;
    this.jobMs = jobMs;
    this.readMs = readMs;
    this.pollMs = pollMs;
    this.token = null;
    this.lastPoll = 0;
    this.jobs = [];
    this.pending = new Map();
    this.pollers = [];
  }

  issueSession() {
    this.token = randomBytes(24).toString("base64url");
    return { token: this.token };
  }

  authorized(token) {
    return Boolean(this.token && token === this.token);
  }

  online() {
    return Date.now() - this.lastPoll < this.onlineMs;
  }

  async next() {
    this.lastPoll = Date.now();
    const ready = this.jobs.shift();
    if (ready) return { job: ready };
    return new Promise((resolve) => {
      const poller = { resolve, timer: null };
      poller.timer = setTimeout(() => {
        this.pollers = this.pollers.filter((one) => one !== poller);
        resolve({ job: null });
      }, this.pollMs);
      this.pollers.push(poller);
    });
  }

  search(query) {
    const wanted = String(query || "").trim();
    if (!wanted || !this.online()) return Promise.resolve(null);
    return this.enqueue({ id: randomUUID(), kind: "search", query: wanted }, this.jobMs);
  }

  // A page read carried out in the real Chrome: it renders JavaScript and uses
  // the signed-in session, so it reaches pages a bare fetch cannot. The tab
  // returns its own HTML and the runtime turns that into Markdown.
  read(url) {
    const target = String(url || "").trim();
    if (!target || !this.online()) return Promise.resolve(null);
    return this.enqueue({ id: randomUUID(), kind: "read", url: target }, this.readMs);
  }

  enqueue(job, ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(job.id);
        this.jobs = this.jobs.filter((one) => one.id !== job.id);
        resolve(null);
      }, ms);
      this.pending.set(job.id, { resolve, timer });

      const poller = this.pollers.shift();
      if (poller) {
        clearTimeout(poller.timer);
        poller.resolve({ job });
      } else {
        this.jobs.push(job);
      }
    });
  }

  complete(id, result) {
    const pending = this.pending.get(String(id || ""));
    if (!pending) return { accepted: false };
    this.pending.delete(String(id));
    clearTimeout(pending.timer);
    pending.resolve(clean(result));
    return { accepted: true };
  }
}

function clean(value) {
  const result = value && typeof value === "object" ? value : {};
  const note = String(result.note || "").slice(0, 300);
  // A page read: the tab hands back the page's own HTML for the runtime to
  // render. Capped generously; a whole page is fine, a whole site dump is not.
  if (typeof result.html === "string" || typeof result.content === "string") {
    const html = String(result.html || result.content || "").slice(0, 3_000_000);
    return {
      url: String(result.url || "").slice(0, 4_000),
      title: String(result.title || "").slice(0, 500),
      ...(html ? { html } : {}),
      ...(note ? { note } : {}),
    };
  }
  const query = String(result.query || "").slice(0, 1_000);
  const rows = Array.isArray(result.results) ? result.results : [];
  const results = rows.slice(0, 20).flatMap((row) => {
    const url = String(row?.url || "").slice(0, 4_000);
    if (!/^https?:\/\//i.test(url)) return [];
    return [{
      title: String(row?.title || "").slice(0, 500),
      url,
      snippet: String(row?.snippet || "").replace(/\s+/g, " ").trim().slice(0, 1_000),
    }];
  });
  return {
    query,
    ...(results.length ? { results } : {}),
    ...(!results.length && note ? { note } : {}),
  };
}

export const extensionSearch = new ExtensionSearch();
