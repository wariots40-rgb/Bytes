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

test("Cloudflare Worker: GET / serves Bytes frontend HTML directly", async () => {
  const workerModule = await import("../worker.mjs");
  const worker = workerModule.default;

  const request = new Request("https://bytes.wariots40.workers.dev/", {
    method: "GET"
  });

  const response = await worker.fetch(request, {});
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/html/);
  const text = await response.text();
  assert.ok(text.includes("<title>Bytes — Thoughtful AI Workspace</title>"));
});

test("Cloudflare Worker: GET /runtime-config.js serves self-origin configuration", async () => {
  const workerModule = await import("../worker.mjs");
  const worker = workerModule.default;

  const request = new Request("https://bytes.wariots40.workers.dev/runtime-config.js", {
    method: "GET"
  });

  const response = await worker.fetch(request, {
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_ANON_KEY: "anon-key-123"
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /javascript/);
  const text = await response.text();
  assert.ok(text.includes('"API_BASE_URL":""'));
  assert.ok(text.includes("https://example.supabase.co"));
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
  assert.equal(data.status, "healthy");
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

test("Cloudflare Worker: Supabase & Clerk database endpoints enforce authentication and sync data", async () => {
  const workerModule = await import("../worker.mjs");
  const worker = workerModule.default;

  // 1. Rejects unauthenticated request
  const unauthReq = new Request("https://bytes.wariots40.workers.dev/api/conversations", {
    method: "GET"
  });
  const unauthRes = await worker.fetch(unauthReq, {});
  assert.equal(unauthRes.status, 401);

  // 2. Authenticated Clerk JWT request
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    sub: "user_clerk_test_456",
    email: "clerkuser@example.com",
    exp: Math.floor(Date.now() / 1000) + 3600
  })).toString("base64url");
  const dummyClerkToken = `${header}.${payload}.mockSignature`;

  const origFetch = globalThis.fetch;
  const mockDb = {
    conversations: [
      { id: "conv_1", user_id: "user_clerk_test_456", title: "Clerk Chat", messages: [] }
    ],
    memory: "Test Clerk memory"
  };

  globalThis.fetch = async (url, opts = {}) => {
    const urlStr = String(url);
    if (urlStr.includes("/rest/v1/conversations")) {
      if (opts.method === "POST") {
        const body = JSON.parse(opts.body);
        const rows = Array.isArray(body) ? body : [body];
        return new Response(JSON.stringify(rows), { status: 201, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify(mockDb.conversations), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (urlStr.includes("/rest/v1/user_memory")) {
      if (opts.method === "POST") {
        return new Response(JSON.stringify([{ user_id: "user_clerk_test_456" }]), { status: 201 });
      }
      return new Response(JSON.stringify([{ content: mockDb.memory }]), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return origFetch(url, opts);
  };

  try {
    const authHeaders = {
      Authorization: `Bearer ${dummyClerkToken}`
    };

    // GET /api/conversations
    const listReq = new Request("https://bytes.wariots40.workers.dev/api/conversations", {
      headers: authHeaders
    });
    const listRes = await worker.fetch(listReq, {
      SUPABASE_URL: "https://project-test.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "mock-key"
    });
    assert.equal(listRes.status, 200);
    const listData = await listRes.json();
    assert.equal(listData.length, 1);
    assert.equal(listData[0].title, "Clerk Chat");

    // PUT /api/conversations
    const saveReq = new Request("https://bytes.wariots40.workers.dev/api/conversations", {
      method: "PUT",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ id: "conv_2", title: "New Chat", messages: [] })
    });
    const saveRes = await worker.fetch(saveReq, {
      SUPABASE_URL: "https://project-test.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "mock-key"
    });
    assert.equal(saveRes.status, 200);
    const saveData = await saveRes.json();
    assert.equal(saveData.ok, true);

    // GET /api/memory
    const memReq = new Request("https://bytes.wariots40.workers.dev/api/memory", {
      headers: authHeaders
    });
    const memRes = await worker.fetch(memReq, {
      SUPABASE_URL: "https://project-test.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "mock-key"
    });
    assert.equal(memRes.status, 200);
    const memData = await memRes.json();
    assert.equal(memData.content, "Test Clerk memory");

    // POST /api/sync (Bulk migrate guest conversations into account)
    const syncReq = new Request("https://bytes.wariots40.workers.dev/api/sync", {
      method: "POST",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        conversations: [
          { id: "guest_conv_1", title: "Guest Chat 1", messages: [{ role: "user", text: "Hello from guest" }] },
          { id: "guest_conv_2", title: "Guest Chat 2", messages: [{ role: "user", text: "Another chat" }] }
        ]
      })
    });
    const syncRes = await worker.fetch(syncReq, {
      SUPABASE_URL: "https://project-test.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "mock-key"
    });
    assert.equal(syncRes.status, 200);
    const syncData = await syncRes.json();
    assert.equal(syncData.ok, true);
    assert.equal(syncData.synced, 2);
  } finally {
    globalThis.fetch = origFetch;
  }
});

