import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("every affordance returns only the success-or-failed contract", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ami-action-results-"));
  process.env.AMI_MAIL_FILE = path.join(directory, "letters.json");
  const { Body } = await import(`../body.mjs?contract=${Date.now()}`);

  let nextSource = 100;
  const sources = new Map();
  const log = {
    append(kind, content, meta) {
      const row = { id: nextSource++, kind, content, meta };
      sources.set(row.id, row);
      return row;
    },
    byId(id) { return sources.get(Number(id)) || null; },
    search() { return []; },
    shelf(id) { return Number(id) === 7 ? { unit: 7, state: "shelved" } : { note: `there is no memory unit numbered ${id}` }; },
    consolidate(ids) { return { memory: 8, sources: ids }; },
    forget() { return 2; },
    units() { return []; },
    set() {},
    // affordances()/sleep() read setup, and shelve()/consolidate() ask for the
    // last world; a minimal log must answer both or the contract check throws.
    get(key, fallback) { return fallback; },
    last() { return null; },
    lastSpoke() { return { id: 1 }; },
    modelResult(unit) { return unit.result?.content || ""; },
  };
  const body = new Body({ log, workspace: path.join(directory, "workspace") });

  try {
    const results = [
      await body.run("speak", ["hello"]),
      await body.run("speak", [""]),
      await body.run("search", [""]),
      await body.run("open", ["not-a-url"]),
      await body.run("read_source", [999]),
      await body.run("recall", ["anything"]),
      await body.run("shelve", [7]),
      await body.run("shelve", [999]),
      await body.run("consolidate", [[7], "kept memory"]),
      await body.run("sleep", []),
      await body.run("ls", []),
      await body.run("write", ["note.txt", "hello"]),
      await body.run("read", ["note.txt"]),
      await body.run("read", ["missing.txt"]),
      await body.run("forget", ["old phrase"]),
      await body.run("email", ["nobody@example.com", "subject", "letter"]),
      await body.run("end", []),
      await body.run("not_a_form", []),
    ];

    for (const value of results) {
      assert.ok(["success", "failed"].includes(value.status), JSON.stringify(value));
      if (value.status === "failed") assert.equal(typeof value.reason, "string");
      assert.equal("note" in value, false);
    }

    const speech = results[0];
    assert.deepEqual(speech, { status: "success", characters: 5 });
    assert.equal("heard" in speech, false);

    const letter = results[15];
    assert.equal(letter.status, "success");
    assert.equal(letter.stored, "local");
    assert.equal("sent" in letter, false);
    assert.equal("delivered" in letter, false);

    // Nothing this body can do reaches outside the sandbox. Every affordance
    // it offers must be one it can actually carry out here, so a form that
    // used to send to a real account is not merely disabled — it is not a
    // form, and the room never lists it.
    assert.equal(body.formNames().includes("message"), false);
    assert.equal((await body.run("message", ["friend", "hi"])).status, "failed");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
