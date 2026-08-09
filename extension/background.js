// Optional bridge between Project AA and the operator's ordinary Chrome.
// It performs only search-result collection and page reads. It has no posting,
// messaging, cookie-export, typing, or form-submission route.
const HOME = "http://127.0.0.1:7717";
const BUILD = "0.2.0";
let browserSessionToken = null;
let followTabId = null;
let looping = false;

async function browserSession() {
  if (browserSessionToken) return browserSessionToken;
  const response = await fetch(`${HOME}/browser-search/session`, {
    headers: { "x-ami-extension": BUILD },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.token) {
    throw new Error(body?.note || `Project AA is not answering (${response.status})`);
  }
  browserSessionToken = body.token;
  return browserSessionToken;
}

async function browserRequest(path, options = {}) {
  const token = await browserSession();
  const response = await fetch(`${HOME}${path}`, {
    ...options,
    headers: {
      "x-ami-extension": BUILD,
      "x-ami-session": token,
      ...(options.body ? { "content-type": "application/json" } : {}),
    },
  });
  const body = await response.json().catch(() => null);
  if (response.status === 403) browserSessionToken = null;
  if (!response.ok) throw new Error(body?.note || `Project AA returned ${response.status}`);
  return body;
}

function waitForTab(tabId, timeoutMs = 45_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error("the page timed out")), timeoutMs);
    const changed = (id, info) => {
      if (id === tabId && info.status === "complete") finish();
    };
    const removed = (id) => {
      if (id === tabId) finish(new Error("the tab closed before it loaded"));
    };
    function finish(error) {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(changed);
      chrome.tabs.onRemoved.removeListener(removed);
      if (error) reject(error);
      else resolve();
    }
    chrome.tabs.onUpdated.addListener(changed);
    chrome.tabs.onRemoved.addListener(removed);
  });
}

async function showPage(url) {
  if (followTabId != null) {
    try {
      await chrome.tabs.update(followTabId, { url, active: true });
      await waitForTab(followTabId);
      return followTabId;
    } catch {
      followTabId = null;
    }
  }
  const window = await chrome.windows.create({ url, focused: true, width: 1200, height: 860 });
  followTabId = window.tabs?.[0]?.id ?? null;
  if (followTabId == null) throw new Error("Chrome did not create a readable tab");
  await waitForTab(followTabId);
  return followTabId;
}

async function google(job) {
  const tabId = await showPage(`https://www.google.com/search?q=${encodeURIComponent(job.query)}&hl=en&num=20`);
  const [{ result } = {}] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const seen = new Set();
      const results = [];
      for (const heading of document.querySelectorAll("a h3")) {
        const anchor = heading.closest("a");
        if (!anchor?.href || seen.has(anchor.href)) continue;
        if (/google\.[a-z.]+\/|\/search\?/.test(anchor.href)) continue;
        seen.add(anchor.href);
        const block = anchor.closest("div[data-hveid], div.MjjYud, div.g") || anchor.parentElement;
        const text = String(block?.innerText || "").replace(String(heading.textContent || ""), "").trim();
        results.push({
          title: String(heading.textContent || "").trim(),
          url: anchor.href,
          snippet: text.replace(/\s+/g, " ").slice(0, 600),
        });
      }
      const page = String(document.body?.innerText || "").slice(0, 1_000);
      const blocked = /unusual traffic|not a robot|verify you are human|recaptcha/i.test(page);
      return {
        results,
        note: blocked ? "google is waiting for human verification" : results.length ? "" : "google returned nothing",
      };
    },
  });
  return { query: job.query, ...(result || { note: "google returned no page" }) };
}

async function settleAndCapture() {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  if (document.readyState !== "complete") {
    await new Promise((resolve) => {
      window.addEventListener("load", resolve, { once: true });
      setTimeout(resolve, 8_000);
    });
  }
  let previousLength = -1;
  const deadline = Date.now() + 8_000;
  while (Date.now() <= deadline) {
    const length = String(document.body?.innerText || "").length;
    if (length > 0 && length === previousLength) break;
    previousLength = length;
    await sleep(500);
  }
  return { title: document.title, html: document.documentElement.outerHTML };
}

async function readPage(job) {
  const tabId = await showPage(job.url);
  const [{ result } = {}] = await chrome.scripting.executeScript({
    target: { tabId },
    func: settleAndCapture,
  });
  return { url: job.url, ...(result || { note: "the page returned nothing" }) };
}

const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function searchLoop() {
  if (looping) return;
  looping = true;
  try {
    for (;;) {
      try {
        const { job } = await browserRequest("/browser-search/next");
        if (!job) continue;
        let result;
        try {
          result = job.kind === "read" ? await readPage(job) : await google(job);
        } catch (error) {
          result = {
            ...(job.kind === "read" ? { url: job.url } : { query: job.query }),
            note: String(error.message || error).slice(0, 200),
          };
        }
        await browserRequest("/browser-search/result", {
          method: "POST",
          body: JSON.stringify({ id: job.id, result }),
        });
      } catch {
        await pause(2_000);
      }
    }
  } finally {
    looping = false;
  }
}

chrome.runtime.onMessage.addListener((message, _sender, reply) => {
  if (!message?.state) return false;
  browserSession()
    .then(() => reply({ reachable: true, note: "browser-search bridge connected" }))
    .catch((error) => reply({ reachable: false, note: String(error.message || error) }));
  return true;
});

chrome.tabs.onRemoved.addListener((id) => {
  if (id === followTabId) {
    followTabId = null;
  }
});

function armKeepalive() {
  try {
    chrome.alarms.create("project-aa-keepalive", { delayInMinutes: 0.5 });
  } catch {}
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== "project-aa-keepalive") return;
  searchLoop();
  armKeepalive();
});
chrome.runtime.onStartup.addListener(searchLoop);
chrome.runtime.onInstalled.addListener(searchLoop);

armKeepalive();
searchLoop();
