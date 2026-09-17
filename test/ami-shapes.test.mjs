import assert from "node:assert/strict";
import test from "node:test";
import { buildRequest, readReply, SHAPES } from "../shapes.mjs";

test("the OpenRouter shape contains only an open assistant turn", () => {
  const request = buildRequest("bare", {
    model: "vendor/model",
    text: "TIME\n",
    stop: ["\nTIME\n"],
    temperature: 0.3,
    maxTokens: 1024,
  });

  assert.deepEqual(request.messages, [{ role: "assistant", content: "TIME\n" }]);
  // No provider-specific keys: the room is continued, not answered.
  assert.equal("thinking" in request, false);
  assert.equal("prefix" in request, false);
  assert.equal("partial" in request, false);
  assert.equal(request.temperature, 0.3);

  const reply = readReply("bare", {
    choices: [{
      finish_reason: "stop",
      message: { content: "continued text", reasoning: "private model reasoning" },
    }],
    usage: { total_tokens: 12 },
  });
  assert.equal(reply.text, "continued text");
  assert.equal(reply.reasoning, "private model reasoning");
});

test("role-clean arrival shapes contain no user turn", () => {
  for (const shape of SHAPES.filter((one) => one !== "glm")) {
    const request = buildRequest(shape, {
      model: "vendor/model",
      text: "TIME\n",
      stop: [],
      temperature: 0.3,
      maxTokens: 1024,
    });
    assert.equal(request.messages?.some((message) => message.role === "user") ?? false, false);
  }
});

test("the BigModel GLM shape reproduces the archived dotted assistant prefill", () => {
  const request = buildRequest("glm", {
    model: "glm-5.2",
    text: "<state>unfinished</state>",
    stop: ["\nTIME\n"],
    temperature: 1,
    maxTokens: 131072,
    reasoning: { effort: "high" },
  });

  assert.deepEqual(request.messages, [
    { role: "user", content: "." },
    { role: "assistant", content: "<state>unfinished</state>" },
  ]);
  assert.deepEqual(request.thinking, { type: "enabled" });
  assert.equal(request.reasoning_effort, "high");
  assert.equal(request.temperature, 1);
  assert.equal(request.max_tokens, 131072);
});

test("Kimi Partial Mode has no user turn and marks the assistant prefix explicitly", () => {
  const request = buildRequest("kimi", {
    model: "kimi-k2.5",
    text: "<state>unfinished</state>",
    stop: ["\nTIME\n"],
    temperature: 1,
    maxTokens: 65536,
  });

  assert.deepEqual(request.messages, [
    { role: "assistant", content: "<state>unfinished</state>", partial: true },
  ]);
  assert.deepEqual(request.thinking, { type: "enabled" });
  assert.equal(request.temperature, 1);
  assert.equal(request.max_tokens, 65536);
});
