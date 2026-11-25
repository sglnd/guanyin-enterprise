import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import {
  processingOptions,
  splitContent,
  cleanContent,
  savedOptions,
  metadataFields,
  generationPolicy,
} from "../knowledge-processing.mjs";
import {
  validateUploadFile,
  uploadKnowledgeFile,
  newUploadId,
} from "../public/app-knowledge-upload.js";
import { knowledgeHttp } from "../knowledge-http.mjs";
import { KnowledgeError } from "../knowledge.mjs";
test("processing settings validate limits, preserve old defaults and split with real overlap", () => {
  assert.throws(() => processingOptions({ chunkSize: 199 }));
  assert.throws(() => processingOptions({ chunkSize: 500, overlap: 126 }));
  assert.throws(() => processingOptions({ cleanText: "false" }));
  assert.throws(() => processingOptions({ unknown: true }));
  assert.equal(savedOptions({}).chunkSize, 1600);
  assert.equal(savedOptions({}).generateMetadata, false);
  const text = "0123456789".repeat(100),
    parts = splitContent(text, {
      strategy: "fixed",
      chunkSize: 200,
      overlap: 20,
      cleanText: false,
      generateMetadata: false,
    });
  assert.equal(parts[0].slice(-20), parts[1].slice(0, 20));
  assert.equal(parts.map((p, i) => (i ? p.slice(20) : p)).join(""), text);
  const structured =
    "# 标题\n\n" + "段落".repeat(70) + "。\n\n" + "另段".repeat(80) + "。";
  const sections = splitContent(structured, {
    strategy: "structured",
    chunkSize: 200,
    overlap: 0,
    cleanText: false,
    generateMetadata: false,
  });
  assert(sections[0].endsWith("\n\n"));
  assert.equal(sections.join(""), structured);
  assert(sections.every((x) => x.length <= 200));
  const emoji = splitContent("中文🙂".repeat(500), {
    strategy: "fixed",
    chunkSize: 201,
    overlap: 20,
    cleanText: false,
    generateMetadata: false,
  });
  assert(emoji.every((p) => !/^\p{Surrogate}|\p{Surrogate}$/u.test(p)));
  assert.equal(
    cleanContent("正文\u0000\n\n\n\n后文\n```\n\n\n\ncode\n```"),
    "正文\n\n后文\n```\n\n\n\ncode\n```",
  );
  assert.deepEqual(metadataFields(" 摘要 ", ["磁盘", "磁盘", "日志"]), {
    summary: "摘要",
    keywords: ["磁盘", "日志"],
  });
  assert.throws(() => metadataFields("", ["词"]));
});
test("upload preflight rejects invalid files and creates valid browser request IDs", () => {
  assert.match(newUploadId(), /^[a-f0-9-]{36}$/i);
  assert.equal(validateUploadFile({ name: "资料.docx", size: 100 }), "");
  assert(validateUploadFile({ name: "资料.docx", size: 0 }));
  assert(validateUploadFile({ name: "x.exe", size: 10 }));
  assert(validateUploadFile({ name: "x.txt", size: 10485761 }));
  assert(validateUploadFile({ name: "../x.txt", size: 10 }));
});
test("XHR progress does not confirm persistence until the server response arrives; retries preserve ID", async () => {
  const original = globalThis.XMLHttpRequest,
    instances = [];
  class FakeXHR {
    constructor() {
      this.upload = {};
      this.headers = {};
      instances.push(this);
    }
    open(m, url) {
      this.url = url;
    }
    setRequestHeader(k, v) {
      this.headers[k] = v;
    }
    send(body) {
      this.body = body;
    }
    abort() {
      this.onabort();
    }
  }
  globalThis.XMLHttpRequest = FakeXHR;
  try {
    const events = [],
      file = { name: "资料.md", size: 100 },
      requestId = newUploadId();
    let saved = false;
    const promise = uploadKnowledgeFile("/upload", {
      file,
      requestId,
      options: processingOptions(),
      onProgress: (n) => events.push(n),
      onTransferred: () => events.push("transferred"),
    }).then((v) => {
      saved = true;
      return v;
    });
    const x = instances[0];
    x.upload.onprogress({ lengthComputable: true, loaded: 60, total: 100 });
    x.upload.onload();
    await Promise.resolve();
    assert.equal(saved, false);
    assert.deepEqual(events, [60, "transferred"]);
    assert.equal(x.body, file);
    x.status = 201;
    x.responseText = JSON.stringify({ id: "doc", version: 1 });
    x.onload();
    assert.equal((await promise).version, 1);
    const retry = uploadKnowledgeFile("/upload", {
      file,
      requestId,
      options: processingOptions(),
    });
    const second = instances[1];
    assert.equal(second.headers["x-upload-id"], x.headers["x-upload-id"]);
    second.status = 403;
    second.responseText = '{"error":"无知识库权限"}';
    second.onload();
    await assert.rejects(retry, (e) => e.status === 403);
    const controller = new AbortController();
    const aborted = uploadKnowledgeFile("/upload", {
      file,
      requestId,
      options: {},
      signal: controller.signal,
    });
    controller.abort();
    await assert.rejects(aborted, { name: "AbortError" });
  } finally {
    globalThis.XMLHttpRequest = original;
  }
});
test("upload HTTP route checks maintenance before reading bytes and forwards options and idempotency ID", async () => {
  const path = "/api/knowledge/11111111-1111-4111-8111-111111111111/documents",
    user = { id: "user" },
    calls = [];
  let response;
  const request = () => {
    const req = Readable.from([Buffer.from("文档")]);
    req.method = "POST";
    req.url = path;
    req.headers = {
      "x-file-name": encodeURIComponent("资料.md"),
      "x-upload-id": "22222222-2222-4222-8222-222222222222",
      "x-knowledge-options": encodeURIComponent(
        JSON.stringify({ strategy: "fixed", chunkSize: 500, overlap: 50 }),
      ),
    };
    return req;
  };
  const context = {
    user,
    bodyJson: () => {},
    sendJson: (_r, status, value) => (response = { status, value }),
    sync: () => {},
  };
  await knowledgeHttp(request(), {}, path, {
    ...context,
    k: {
      library: async () => {
        throw new KnowledgeError(403, "无知识库权限");
      },
      upload: async () => assert.fail(),
    },
  });
  assert.equal(response.status, 403);
  await knowledgeHttp(request(), {}, path, {
    ...context,
    k: {
      library: async () => {},
      upload: async (...args) => {
        calls.push(args);
        return { id: "doc", version: 1 };
      },
    },
  });
  assert.equal(response.status, 201);
  assert.equal(calls[0][2], "资料.md");
  assert.equal(calls[0][5].chunkSize, 500);
  assert.equal(calls[0][6], "22222222-2222-4222-8222-222222222222");
  const bad = request();
  bad.headers["x-knowledge-options"] = "%invalid";
  await knowledgeHttp(bad, {}, path, {
    ...context,
    k: { library: async () => {} },
  });
  assert.equal(response.status, 400);
});

test("generation budget settings reject invalid and reversed production limits", () => {
  assert.deepEqual(generationPolicy(), {
    draftMaxTokens: 16000,
    draftRetryMaxTokens: 32000,
  });
  assert.throws(() => generationPolicy({ draftMaxTokens: 0 }));
  assert.throws(() => generationPolicy({ draftRetryMaxTokens: 64001 }));
  assert.throws(() =>
    generationPolicy({ draftMaxTokens: 16000, draftRetryMaxTokens: 8000 }),
  );
  assert.throws(() => generationPolicy({ draftMaxTokens: "16000" }));
});

test("parsed source preview reuses source authorization and never returns storage or model internals", async () => {
  const path =
    "/api/knowledge/11111111-1111-4111-8111-111111111111/documents/22222222-2222-4222-8222-222222222222/source-text";
  const user = { id: "reader" };
  const req = { method: "GET", url: path + "?version=2" };
  let response, args;
  const context = {
    user,
    sendJson: (_res, status, value) => (response = { status, value }),
  };
  await knowledgeHttp(req, {}, path, {
    ...context,
    k: {
      source: async (...a) => {
        args = a;
        return {
          row: {
            title: "手册",
            source: "原文",
            file_key: "private",
            model_info: { secret: "private" },
          },
        };
      },
    },
  });
  assert.deepEqual(args, [
    { user },
    "11111111-1111-4111-8111-111111111111",
    "22222222-2222-4222-8222-222222222222",
    2,
    { readBytes: false },
  ]);
  assert.deepEqual(response, {
    status: 200,
    value: { version: 2, title: "手册", content: "原文" },
  });
  await knowledgeHttp(req, {}, path, {
    ...context,
    k: {
      source: async () => {
        throw new KnowledgeError(403, "无知识库权限");
      },
    },
  });
  assert.equal(response.status, 403);
});

test("binding candidates are obtained through library authorization rather than the general space list", async () => {
  const id = "11111111-1111-4111-8111-111111111111",
    path = "/api/knowledge/" + id + "/spaces",
    user = { id: "reader" };
  let response;
  const context = {
    user,
    sendJson: (_res, status, value) => (response = { status, value }),
  };
  await knowledgeHttp({ method: "GET", url: path }, {}, path, {
    ...context,
    k: {
      bindingSpaces: async (u, lib) => {
        assert.equal(u, user);
        assert.equal(lib, id);
        return [
          {
            id: "space",
            name: "仅普通成员",
            accessRole: "member",
            canConfigure: false,
          },
        ];
      },
    },
  });
  assert.equal(response.status, 200);
  assert.equal(response.value.spaces[0].canConfigure, false);
  await knowledgeHttp({ method: "GET", url: path }, {}, path, {
    ...context,
    k: {
      bindingSpaces: async () => {
        throw new KnowledgeError(403, "无知识库权限");
      },
    },
  });
  assert.equal(response.status, 403);
});

test("member preview checks both library maintenance and space configuration through bindingScope", async () => {
  const lib = "11111111-1111-4111-8111-111111111111",
    space = "22222222-2222-4222-8222-222222222222",
    path = "/api/knowledge/scope",
    user = { id: "maintainer" };
  let response;
  const context = {
    user,
    sendJson: (_res, status, value) => (response = { status, value }),
  };
  const req = {
    method: "GET",
    url: path + "?spaceId=" + space + "&libraryId=" + lib,
  };
  await knowledgeHttp(req, {}, path, {
    ...context,
    k: {
      bindingScope: async (u, l, s) => {
        assert.equal(u, user);
        assert.equal(l, lib);
        assert.equal(s, space);
        return {
          space,
          epoch: "2",
          members: [
            {
              id: "member",
              access_role: "member",
              enabled: false,
              canRead: false,
            },
          ],
        };
      },
      spaceLibraries: async () => [
        { id: lib, name: "公共库", reason: "空间存在未授权成员" },
      ],
    },
  });
  assert.equal(response.status, 200);
  assert.equal(response.value.members[0].canRead, false);
  assert.equal(response.value.members[0].enabled, false);
  await knowledgeHttp(req, {}, path, {
    ...context,
    k: {
      bindingScope: async () => {
        throw new KnowledgeError(403, "无空间配置权限");
      },
    },
  });
  assert.equal(response.status, 403);
});

test("cancelling an absent binding does not synchronize an unrelated space", async () => {
  const path = "/api/knowledge/11111111-1111-4111-8111-111111111111/bindings";
  let response;
  await knowledgeHttp({ method: "PUT", url: path }, {}, path, {
    user: { id: "maintainer" },
    bodyJson: async () => ({
      spaceId: "22222222-2222-4222-8222-222222222222",
      remove: true,
    }),
    sendJson: (_res, status, value) => (response = { status, value }),
    k: {
      bind: async () => ({
        space: "22222222-2222-4222-8222-222222222222",
        removed: false,
      }),
    },
    sync: async () => assert.fail("must not sync absent binding"),
  });
  assert.equal(response.status, 200);
  assert.equal(response.value.removed, false);
});
