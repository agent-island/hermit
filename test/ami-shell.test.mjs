import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";
import { Body } from "../body.mjs";
import { guestShellRunner, limaShellCommand } from "../shell.mjs";

test("guest shell spools the script and output away from transport descriptors", () => {
  const runner = guestShellRunner(17);
  assert.match(runner, /cat >"\$ami_script"/);
  assert.match(runner, /bash "\$ami_script" >"\$ami_output" 2>&1/);
  assert.match(runner, /timeout 17/);

  const command = limaShellCommand({ user: "zero", timeoutSeconds: 17, timezone: "UTC" });
  assert.match(command, /sudo -u zero -H --/);
  assert.match(command, /sh -c/);
  assert.match(command, /TZ=UTC/);
  assert.throws(() => limaShellCommand({ user: "zero; reboot" }), /invalid VM account/);
});

test("run shell has a local transport deadline", async () => {
  const previous = {
    host: process.env.AMI_SHELL_SSH,
    exec: process.env.AMI_SHELL_EXEC,
    timeout: process.env.AMI_SHELL_TRANSPORT_TIMEOUT_MS,
  };
  process.env.AMI_SHELL_SSH = "example.invalid";
  process.env.AMI_SHELL_EXEC = "remote shell";
  process.env.AMI_SHELL_TRANSPORT_TIMEOUT_MS = "10";

  let child;
  const spawnProcess = () => {
    child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new Writable({ write(_chunk, _encoding, done) { done(); } });
    child.kill = (signal) => { child.killedWith = signal; return true; };
    return child;
  };
  const body = new Body({ log: {}, workspace: "", spawnProcess });

  try {
    const result = await body.runShell("echo hello");
    assert.equal(result.status, "failed");
    assert.match(result.reason, /transport did not close/);
    assert.equal(child.killedWith, "SIGTERM");
  } finally {
    if (previous.host === undefined) delete process.env.AMI_SHELL_SSH;
    else process.env.AMI_SHELL_SSH = previous.host;
    if (previous.exec === undefined) delete process.env.AMI_SHELL_EXEC;
    else process.env.AMI_SHELL_EXEC = previous.exec;
    if (previous.timeout === undefined) delete process.env.AMI_SHELL_TRANSPORT_TIMEOUT_MS;
    else process.env.AMI_SHELL_TRANSPORT_TIMEOUT_MS = previous.timeout;
  }
});
