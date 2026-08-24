import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Body } from "../body.mjs";
import { Log } from "../log.mjs";
import { Observer, startPanel } from "../panel.mjs";

test("peer speech enters the other life as heard words and requires the pair token", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ami-peer-speech-"));
  const priorToken = process.env.AMI_PEER_TOKEN;
  const priorName = process.env.AMI_SELF_NAME;
  process.env.AMI_PEER_TOKEN = "pair-secret-for-test";
  process.env.AMI_SELF_NAME = "one";

  const log = new Log(path.join(directory, "ami.sqlite"));
  const body = new Body({ log, workspace: path.join(directory, "workspace") });
  let interruptions = 0;
  const loop = {
    busy: false,
    running: true,
    nextWakeAt: null,
    interrupt() { interruptions += 1; },
  };
  const config = {
    apiKey: "", baseUrl: "", model: "test", temperature: 1,
    maxTokens: 1024, contextTokens: 4096, endpoint: "completions", prefill: null,
  };
  const server = startPanel({
    port: 0, log, body, loop, observer: new Observer(), workspace: directory, config,
  });

  try {
    await once(server, "listening");
    const port = server.address().port;
    const denied = await fetch(`http://127.0.0.1:${port}/peer-say`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ from: "zero", text: "untrusted" }),
    });
    assert.equal(denied.status, 403);

    const delivered = await fetch(`http://127.0.0.1:${port}/peer-say`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-ami-peer-token": "pair-secret-for-test",
      },
      body: JSON.stringify({ from: "zero", text: "Can you hear me?" }),
    });
    assert.equal(delivered.status, 200);
    assert.deepEqual(await delivered.json(), { ok: true, receivedBy: "one" });
    assert.equal(interruptions, 1);
    const heard = log.last("incoming");
    assert.equal(heard.content, "Can you hear me?");
    assert.equal(heard.meta.from, "zero");
  } finally {
    server.close();
    await once(server, "close");
    log.db.close();
    if (priorToken === undefined) delete process.env.AMI_PEER_TOKEN;
    else process.env.AMI_PEER_TOKEN = priorToken;
    if (priorName === undefined) delete process.env.AMI_SELF_NAME;
    else process.env.AMI_SELF_NAME = priorName;
    await rm(directory, { recursive: true, force: true });
  }
});
