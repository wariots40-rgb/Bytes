const test = require("node:test");
const assert = require("node:assert/strict");

test("Cloudflare Worker: exports fetch handler", async () => {
  const workerModule = await import("../worker.mjs");
  assert.equal(typeof workerModule.default.fetch, "function");
});

test("Cloudflare Worker: handles CORS preflight OPTIONS request", async () => {
  const workerModule = await import("../worker.mjs");
  const worker = workerModule.default;

  const request = new Request("https://bytes-api.workers.dev/api/health", {
    method: "OPTIONS",
    headers: {
      origin: "https://bytes-ai.netlify.app"
    }
  });

  const response = await worker.fetch(request, {
    FRONTEND_URL: "https://bytes-ai.netlify.app"
  });

  assert.equal(response.status, 204);
  assert.equal(response.headers.get("access-control-allow-origin"), "https://bytes-ai.netlify.app");
  assert.match(response.headers.get("access-control-allow-methods"), /GET, POST, OPTIONS/);
});

test("Cloudflare Worker: GET /api/health returns worker runtime info", async () => {
  const workerModule = await import("../worker.mjs");
  const worker = workerModule.default;

  const request = new Request("https://bytes-api.workers.dev/api/health", {
    method: "GET"
  });

  const response = await worker.fetch(request, {
    META_API_KEY_1: "test-meta-key"
  });

  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.ok, true);
  assert.equal(data.runtime, "cloudflare-workers");
  assert.equal(data.providers.meta, true);
});

test("Cloudflare Worker: GET /api/models returns 10 frontier models", async () => {
  const workerModule = await import("../worker.mjs");
  const worker = workerModule.default;

  const request = new Request("https://bytes-api.workers.dev/api/models", {
    method: "GET"
  });

  const response = await worker.fetch(request, {
    META_API_KEY_1: "key-1",
    META_API_KEY_2: "key-2",
    META_API_KEY_3: "key-3",
    META_API_KEY_4: "key-4",
    META_API_KEY_5: "key-5",
    META_API_KEY_6: "key-6",
    META_API_KEY_7: "key-7",
    META_API_KEY_8: "key-8",
    META_API_KEY_9: "key-9",
    META_API_KEY_10: "key-10"
  });

  assert.equal(response.status, 200);
  const data = await response.json();
  assert.ok(Array.isArray(data.providers));
  const totalModels = data.providers.reduce((sum, p) => sum + p.models.length, 0);
  assert.equal(totalModels, 10);
});

test("Cloudflare Worker: POST /api/chat validates payload", async () => {
  const workerModule = await import("../worker.mjs");
  const worker = workerModule.default;

  // Empty messages
  const req1 = new Request("https://bytes-api.workers.dev/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: [] })
  });
  const res1 = await worker.fetch(req1, { META_API_KEY_1: "key-1" });
  assert.equal(res1.status, 400);

  // Invalid JSON
  const req2 = new Request("https://bytes-api.workers.dev/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "invalid-json"
  });
  const res2 = await worker.fetch(req2, { META_API_KEY_1: "key-1" });
  assert.equal(res2.status, 400);
});

test("Cloudflare Worker: POST /api/chat streams SSE response", async () => {
  const workerModule = await import("../worker.mjs");
  const worker = workerModule.default;

  const mockFetch = async (url) => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"Edge "}}]}\n\n'));
        controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"Worker"}}]}\n\n'));
        controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
        controller.close();
      }
    });
    return new Response(stream, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" }
    });
  };

  const req = new Request("https://bytes-api.workers.dev/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages: [{ role: "user", text: "Hello" }],
      model: "openai/gpt-6-astra",
      stream: true
    })
  });

  // Temporarily substitute global fetch for the upstream call
  const origFetch = globalThis.fetch;
  globalThis.fetch = mockFetch;

  try {
    const res = await worker.fetch(req, {
      META_API_KEY_1: "test-meta-key-1"
    });

    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/event-stream; charset=utf-8");

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let text = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }

    assert.ok(text.includes('data: {"text":"Edge "}'));
    assert.ok(text.includes('data: {"text":"Worker"}'));
    assert.ok(text.includes("data: [DONE]"));
  } finally {
    globalThis.fetch = origFetch;
  }
});

