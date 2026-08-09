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

test("no arrival shape contains a user turn", () => {
  for (const shape of SHAPES) {
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
