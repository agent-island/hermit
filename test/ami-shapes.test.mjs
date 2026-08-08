import assert from "node:assert/strict";
import test from "node:test";
import { buildRequest, readReply } from "../shapes.mjs";

test("the OpenRouter assistant shape ends on an open assistant turn with no provider flag", () => {
  const request = buildRequest("assistant", {
    model: "vendor/model",
    text: "TIME\n",
    stop: ["\nTIME\n"],
    temperature: 0.3,
    maxTokens: 1024,
  });

  assert.deepEqual(request.messages, [
    { role: "user", content: "." },
    { role: "assistant", content: "TIME\n" },
  ]);
  // No provider-specific keys: the room is continued, not answered.
  assert.equal("thinking" in request, false);
  assert.equal("prefix" in request, false);
  assert.equal("partial" in request, false);
  assert.equal(request.temperature, 0.3);

  const reply = readReply("assistant", {
    choices: [{
      finish_reason: "stop",
      message: { content: "continued text", reasoning: "private model reasoning" },
    }],
    usage: { total_tokens: 12 },
  });
  assert.equal(reply.text, "continued text");
  assert.equal(reply.reasoning, "private model reasoning");
});
