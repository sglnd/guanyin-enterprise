import test from "node:test";
import assert from "node:assert/strict";
import { knowledgeModels } from "../knowledge-models.mjs";
const cfg = {
  chatProvider: "p",
  chatModel: "model",
  draftMaxTokens: 5000,
  draftRetryMaxTokens: 10000,
};
const valid = JSON.stringify({ content: "操作正文", quotes: ["原文"] });
async function withResponses(responses, run, extra = {}) {
  const original = globalThis.fetch,
    calls = [];
  globalThis.fetch = async (_url, input) => {
    if (extra.authMode === "none") assert.equal(input.headers.authorization, undefined);
    else assert.equal(input.headers.authorization, "Bearer test");
    calls.push(JSON.parse(input.body));
    const data = responses.shift();
    assert(data, "unexpected extra request");
    return { ok: true, json: async () => data };
  };
  try {
    const models = knowledgeModels(async () => ({
      enabled: true,
      apiKey: "test",
      config: {
        api: "openai-completions",
        authMode: extra.authMode,
        baseURL: "http://test.invalid/v1",
        compat: extra.compat || {},
        models: [{ id: "model", ...extra.model }],
      },
    }));
    await run(models, calls);
  } finally {
    globalThis.fetch = original;
  }
}
const response = (content, reason = "stop", other = {}) => ({
  choices: [{ finish_reason: reason, message: { content, ...other } }],
  usage: {
    completion_tokens: 4500,
    completion_tokens_details: { reasoning_tokens: 2000 },
  },
});
test("Wiki handles whitespace and JSON fences without retrying or reading reasoning text", async () => {
  await withResponses(
    [response(" \n```json\n" + valid + "\n```  ")],
    async (m, calls) => {
      const r = await m.draft(cfg, "原文");
      assert.equal(r.content, "操作正文");
      assert.equal(calls.length, 1);
      assert.equal(r._diagnostics.attempts[0].finishReason, "stop");
    },
  );
  await withResponses([response([{ type: "text", text: valid }])], async (m) =>
    assert.equal((await m.draft(cfg, "原文")).content, "操作正文"),
  );
});
test("length-truncated Wiki retries once with a larger bounded budget and concise JSON request", async () => {
  await withResponses(
    [
      response('{"content":"incomplete', "length", {
        reasoning_content: "private reasoning",
      }),
      response(valid),
    ],
    async (m, calls) => {
      const r = await m.draft(cfg, "原文");
      assert.equal(calls.length, 2);
      assert.equal(calls[0].max_tokens, 5000);
      assert.equal(calls[1].max_tokens, 10000);
      assert.equal(r._diagnostics.attempts[0].problem, "truncated");
      assert(!JSON.stringify(r._diagnostics).includes("private reasoning"));
    },
  );
});
test("malformed JSON retry respects registered output limit and alternate token field", async () => {
  await withResponses(
    [response("invalid"), response("still invalid")],
    async (m, calls) => {
      await assert.rejects(m.draft(cfg, "sensitive source"), (error) => {
        assert.match(error.message, /JSON 格式不正确/);
        assert.equal(error.diagnostics.attempts.length, 2);
        assert(!JSON.stringify(error.diagnostics).includes("sensitive source"));
        return true;
      });
      assert.equal(calls[0].max_completion_tokens, 5000);
      assert.equal(calls[1].max_completion_tokens, 6000);
      assert(!Object.hasOwn(calls[1], "max_tokens"));
    },
    {
      model: { maxTokens: 6000 },
      compat: { maxTokensField: "max_completion_tokens" },
    },
  );
});
test("reasoning-only responses stay failures; refusals are never retried as formatting errors", async () => {
  await withResponses(
    [
      response(null, "stop", { reasoning_content: valid }),
      response(null, "stop", { reasoning_content: valid }),
    ],
    async (m) => assert.rejects(m.draft(cfg, "原文"), /只返回了推理过程/),
  );
  await withResponses(
    [response(null, "content_filter", { refusal: "blocked" })],
    async (m, calls) => {
      await assert.rejects(m.draft(cfg, "原文"), /未提供可用正文/);
      assert.equal(calls.length, 1);
    },
  );
});

test("production budgets are configurable beyond the former hardcoded cap and honor model ceilings", async () => {
  await withResponses(
    [response("partial", "length"), response(valid)],
    async (m, calls) => {
      await m.draft(
        { ...cfg, draftMaxTokens: 12000, draftRetryMaxTokens: 24000 },
        "原文",
      );
      assert.equal(calls[0].max_tokens, 12000);
      assert.equal(calls[1].max_tokens, 18000);
    },
    { model: { maxTokens: 18000 } },
  );
  await withResponses([response(valid)], async (m, calls) => {
    await m.draft({ chatProvider: "p", chatModel: "model" }, "原文");
    assert.equal(calls[0].max_tokens, 16000);
  });
});
test("production HTTP errors explain a recovery path without exposing response bodies", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 429,
    json: async () => ({ secret: "must not be exposed" }),
  });
  try {
    const models = knowledgeModels(async () => ({
      enabled: true,
      config: {
        api: "openai-completions",
        baseURL: "http://test.invalid",
        models: [{ id: "model" }],
      },
    }));
    await assert.rejects(models.draft(cfg, "原文"), (error) => {
      assert.match(error.message, /429/);
      assert.match(error.message, /限流或额度/);
      assert(!error.message.includes("must not"));
      return true;
    });
  } finally {
    globalThis.fetch = original;
  }
});

test("enterprise models without credentials omit authorization during Wiki generation", async () => {
  await withResponses(
    [response(valid)],
    async (models) => {
      const result = await models.draft(cfg, "原文");
      assert.ok(result);
    },
    { authMode: "none" },
  );
});
