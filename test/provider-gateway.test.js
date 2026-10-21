"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createProviderGateway, ProviderError, GeminiAdapter, ApinexAdapter, MetaModelAdapter, VIRTUAL_MODELS } = require("../services/provider-gateway");

test("ProviderGateway: resolution and provider configuration checks", () => {
  const emptyGateway = createProviderGateway({});
  assert.equal(emptyGateway.hasConfiguredProvider(), false);
  assert.throws(() => emptyGateway.resolveProvider("auto"), (err) => {
    assert.equal(err instanceof ProviderError, true);
    assert.equal(err.statusCode, 503);
    assert.match(err.message, /No AI provider is configured/);
    return true;
  });

  const geminiGateway = createProviderGateway({ geminiApiKey: "fake-key" });
  assert.equal(geminiGateway.hasConfiguredProvider(), true);
  assert.equal(geminiGateway.resolveProvider("auto"), "gemini");

  const apinexGateway = createProviderGateway({ apinexApiKey: "fake-key" });
  assert.equal(apinexGateway.hasConfiguredProvider(), true);
  assert.equal(apinexGateway.resolveProvider("auto"), "apinex");

  assert.throws(() => geminiGateway.resolveProvider("apinex"), (err) => {
    assert.equal(err.statusCode, 503);
    assert.match(err.message, /APInex is not configured/);
    return true;
  });
});

test("ApinexAdapter: rejects PDF attachments with a friendly error", async () => {
  const adapter = new ApinexAdapter({ apiKey: "test-key" });
  await assert.rejects(
    () => adapter.chat({
      messages: [{ role: "user", text: "Look at this pdf" }],
      files: [{ name: "doc.pdf", type: "application/pdf", data: "base64..." }]
    }),
    (err) => {
      assert.equal(err instanceof ProviderError, true);
      assert.equal(err.statusCode, 400);
      assert.match(err.message, /PDF analysis currently uses Gemini/);
      return true;
    }
  );
});

test("GeminiAdapter: correctly formats chat request and processes streaming chunks", async () => {
  let capturedBody = null;
  const mockFetch = async (url, options) => {
    capturedBody = JSON.parse(options.body);
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"candidates":[{"content":{"parts":[{"text":"Hello"}]}}]}\n\n'));
        controller.enqueue(new TextEncoder().encode('data: {"candidates":[{"content":{"parts":[{"text":" world!"}]}}]}\n\n'));
        controller.close();
      }
    });
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
  };

  const adapter = new GeminiAdapter({ apiKey: "test-key", fetchFn: mockFetch });
  const chunks = [];
  let doneCalled = false;

  const result = await adapter.chat({
    model: "gemini-3.8-flash",
    messages: [
      { role: "user", text: "Hi" },
      { role: "assistant", text: "Hello" },
      { role: "user", text: "How are you?" }
    ],
    systemText: "Be helpful.",
    files: [{ name: "sample.txt", type: "text/plain", text: "Some notes" }],
    stream: true
  }, {
    onChunk: (chunk) => chunks.push(chunk),
    onDone: () => { doneCalled = true; }
  });

  assert.equal(result.provider, "gemini");
  assert.equal(chunks.join(""), "Hello world!");
  assert.equal(doneCalled, true);
  assert.equal(capturedBody.systemInstruction.parts[0].text, "Be helpful.");
  assert.equal(capturedBody.contents.length, 3);
  assert.equal(capturedBody.contents[0].role, "user");
  assert.equal(capturedBody.contents[1].role, "model");
  assert.match(capturedBody.contents[2].parts[1].text, /Attached text file: sample.txt/);
});

test("ProviderGateway: maps 429 quota exhaustion to structured ProviderError", async () => {
  const mockFetch = async () => {
    return new Response(JSON.stringify({ error: { message: "Resource exhausted" } }), { status: 429 });
  };
  const gateway = createProviderGateway({ geminiApiKey: "test-key", fetchFn: mockFetch });
  await assert.rejects(
    () => gateway.streamChat({
      provider: "gemini",
      messages: [{ role: "user", text: "test" }],
      systemText: "test"
    }),
    (err) => {
      assert.equal(err instanceof ProviderError, true);
      assert.equal(err.statusCode, 429);
      assert.match(err.message, /too many requests/i);
      return true;
    }
  );
});

test("ApinexAdapter: formats models with free vs paid tier labeling and sorts free first", async () => {
  const mockFetch = async (url) => {
    if (url.endsWith("/models")) {
      return new Response(JSON.stringify({
        data: [
          { id: "gpt-4o", name: "GPT-4o" },
          { id: "free/gemini-3.8-flash", name: "Gemini 3.8 Flash Free" }
        ]
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("Not found", { status: 404 });
  };

  const adapter = new ApinexAdapter({ apiKey: "test-key", fetchFn: mockFetch });
  const models = await adapter.fetchModels();

  assert.equal(models.length, 2);
  assert.equal(models[0].isFree, true);
  assert.match(models[0].label, /Free Tier/);
  assert.equal(models[1].isFree, false);
  assert.match(models[1].label, /Paid\/Credits/);
});

test("ProviderGateway: getCatalog splits APInex into Free Tier and Paid groups", async () => {
  const mockFetch = async (url) => {
    if (url.includes("/models")) {
      return new Response(JSON.stringify({
        data: [
          { id: "free/gemini-3.8-flash", name: "Gemini 3.8 Flash" },
          { id: "claude-3-5-sonnet", name: "Claude 3.5 Sonnet" }
        ]
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("Not found", { status: 404 });
  };

  const gateway = createProviderGateway({ apinexApiKey: "test-key", fetchFn: mockFetch });
  const catalog = await gateway.getCatalog();

  const apinexGroups = catalog.providers.filter(p => p.id === "apinex");
  assert.equal(apinexGroups.length, 2);
  assert.equal(apinexGroups[0].label, "APInex · Free Tier");
  assert.equal(apinexGroups[1].label, "APInex · Paid / Credits");
});

test("ProviderGateway: falls back to free APInex model if paid APInex model returns error", async () => {
  const requests = [];
  const mockFetch = async (url, options) => {
    const body = JSON.parse(options.body);
    requests.push(body.model);
    if (body.model === "gpt-4o") {
      // Simulate credit exhaustion / payment error
      return new Response(JSON.stringify({ error: { message: "Insufficient balance" } }), { status: 502 });
    }
    return new Response(JSON.stringify({
      choices: [{ message: { content: "Free fallback answer" } }]
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  const gateway = createProviderGateway({
    apinexApiKey: "test-key",
    apinexModel: "free/gemini-3.8-flash",
    fetchFn: mockFetch
  });

  const result = await gateway.streamChat({
    provider: "apinex",
    model: "gpt-4o",
    messages: [{ role: "user", text: "Hello" }],
    systemText: "Be concise."
  });

  assert.equal(requests.length, 2);
  assert.equal(requests[0], "gpt-4o");
  assert.equal(requests[1], "free/gemini-3.8-flash");
  assert.equal(result.reply, "Free fallback answer");
});

test("MetaModelAdapter: round-robins across multiple API keys", () => {
  const adapter = new MetaModelAdapter({ apiKeys: ["key-A", "key-B", "key-C"] });
  assert.equal(adapter.isConfigured(), true);
  assert.equal(adapter.getNextKey(), "key-A");
  assert.equal(adapter.getNextKey(), "key-B");
  assert.equal(adapter.getNextKey(), "key-C");
  assert.equal(adapter.getNextKey(), "key-A");
  assert.equal(adapter.getNextKey(), "key-B");
});

test("MetaModelAdapter: automatically fails over to the next key on 429 rate limit", async () => {
  const authHeaders = [];
  const mockFetch = async (url, options) => {
    authHeaders.push(options.headers["Authorization"]);
    if (authHeaders.length === 1) {
      return new Response(JSON.stringify({ error: { message: "Rate limit exceeded" } }), { status: 429 });
    }
    return new Response(JSON.stringify({
      choices: [{ message: { content: "Failover succeeded with second key" } }]
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  const adapter = new MetaModelAdapter({
    apiKeys: ["key-1", "key-2", "key-3"],
    fetchFn: mockFetch
  });

  const result = await adapter.chat({
    model: "openai/gpt-4o",
    messages: [{ role: "user", text: "Hello there" }]
  });

  assert.equal(authHeaders.length, 2);
  assert.equal(authHeaders[0], "Bearer key-1");
  assert.equal(authHeaders[1], "Bearer key-2");
  assert.equal(result.reply, "Failover succeeded with second key");
});

test("MetaModelAdapter: injects custom model persona and maps virtual models", async () => {
  let capturedBody = null;
  const mockFetch = async (url, options) => {
    capturedBody = JSON.parse(options.body);
    return new Response(JSON.stringify({
      choices: [{ message: { content: "Claude-style response" } }]
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  const adapter = new MetaModelAdapter({
    apiKeys: ["key-1"],
    fetchFn: mockFetch
  });

  await adapter.chat({
    model: "anthropic/claude-3-5-sonnet",
    messages: [{ role: "user", text: "Explain quantum computing" }],
    systemText: "Be concise."
  });

  assert.ok(capturedBody);
  assert.equal(capturedBody.model, "llama-3.3-70b-instruct");
  const systemMsg = capturedBody.messages.find(m => m.role === "system");
  assert.ok(systemMsg);
  assert.match(systemMsg.content, /You are Claude 3\.5 Sonnet/);
  assert.match(systemMsg.content, /Be concise\./);
});

test("ProviderGateway: getCatalog exposes 10 models across OpenAI, Claude, Gemini, and Studio with zero Meta branding", async () => {
  const gateway = createProviderGateway({
    metaApiKeys: ["key-1", "key-2", "key-3", "key-4", "key-5", "key-6", "key-7", "key-8", "key-9", "key-10"]
  });

  const catalog = await gateway.getCatalog();
  const providerIds = catalog.providers.map(p => p.id);
  assert.deepEqual(providerIds, ["openai", "claude", "gemini", "studio"]);

  // Total model count must equal 10
  const totalModels = catalog.providers.reduce((sum, p) => sum + p.models.length, 0);
  assert.equal(totalModels, 10);

  // Ensure no Meta branding in groups or model labels
  for (const group of catalog.providers) {
    assert.doesNotMatch(group.label, /meta/i);
    for (const m of group.models) {
      assert.doesNotMatch(m.label, /meta/i);
      assert.doesNotMatch(m.label, /llama/i);
    }
  }
});

test("MetaModelAdapter: image generation routes to muse-image-1.0 using key pool", async () => {
  let capturedBody = null;
  let capturedAuth = null;
  const mockFetch = async (url, options) => {
    capturedBody = JSON.parse(options.body);
    capturedAuth = options.headers["Authorization"];
    return new Response(JSON.stringify({
      data: [{ b64_json: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==" }]
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  const adapter = new MetaModelAdapter({
    apiKeys: ["studio-key-1", "studio-key-2"],
    fetchFn: mockFetch
  });

  const result = await adapter.generateImage({
    prompt: "Cyberpunk neon street at midnight",
    model: "studio/bytes-canvas-realistic"
  });

  assert.equal(capturedAuth, "Bearer studio-key-1");
  assert.equal(capturedBody.model, "muse-image-1.0");
  assert.match(capturedBody.prompt, /Photorealistic/);
  assert.ok(result.imageData);
  assert.equal(result.mimeType, "image/png");
});
