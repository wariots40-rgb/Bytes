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

test("MetaModelAdapter: automatically falls back to next model on the same key when upstream model hits 429 rate limit", async () => {
  const authHeaders = [];
  const modelsCalled = [];
  const mockFetch = async (url, options) => {
    authHeaders.push(options.headers["Authorization"]);
    const body = JSON.parse(options.body);
    modelsCalled.push(body.model);
    if (authHeaders.length === 1) {
      return new Response(JSON.stringify({ error: { message: "Rate limit exceeded" } }), { status: 429 });
    }
    return new Response(JSON.stringify({
      choices: [{ message: { content: "Failover succeeded with second model on same key" } }]
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
  // Both attempts strictly use the dedicated key (key-1)
  assert.equal(authHeaders[0], "Bearer key-1");
  assert.equal(authHeaders[1], "Bearer key-1");
  assert.equal(modelsCalled[0], "muse-wonder-1.0");
  assert.equal(modelsCalled[1], "muse-spark-1.3");
  assert.equal(result.reply, "Failover succeeded with second model on same key");
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
  assert.equal(capturedBody.model, "muse-spark-1.3");
  const systemMsg = capturedBody.messages.find(m => m.role === "system");
  assert.ok(systemMsg);
  assert.match(systemMsg.content, /STRICT IDENTITY EMBODIMENT & MODEL DISGUISE/);
  assert.match(systemMsg.content, /EVER mention Meta, Llama, Facebook, muse/);
  assert.match(systemMsg.content, /You are Claude 3\.5 Sonnet/);
  assert.match(systemMsg.content, /Be concise\./);
});

test("MetaModelAdapter: automatically falls back to fallbackModel if targetModel returns 404", async () => {
  const modelsCalled = [];
  const mockFetch = async (url, options) => {
    const body = JSON.parse(options.body);
    modelsCalled.push(body.model);
    if (body.model === "muse-spark-1.3" || body.model === "muse-spark") {
      return new Response(JSON.stringify({ error: { message: "Model not found" } }), { status: 404 });
    }
    return new Response(JSON.stringify({
      choices: [{ message: { content: "Fallback model reply" } }]
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  const adapter = new MetaModelAdapter({
    apiKeys: ["key-1"],
    fetchFn: mockFetch
  });

  const result = await adapter.chat({
    model: "anthropic/claude-3-5-sonnet",
    messages: [{ role: "user", text: "Hello" }]
  });

  assert.equal(modelsCalled.length, 3);
  assert.equal(modelsCalled[0], "muse-spark-1.3");
  assert.equal(modelsCalled[1], "muse-spark");
  assert.equal(modelsCalled[2], "llama-3.3-70b-instruct");
  assert.equal(result.reply, "Fallback model reply");
});

test("MetaModelAdapter: tracks isolated cooldown and failure state per key worker", async () => {
  const adapter = new MetaModelAdapter({
    apiKeys: ["key-A", "key-B"]
  });

  const workerA = adapter.workerMap.get("key-A");
  const workerB = adapter.workerMap.get("key-B");
  assert.ok(workerA && workerB);
  assert.deepEqual(workerA.fallbackKeys, ["key-B"]);
  assert.deepEqual(workerB.fallbackKeys, ["key-A"]);

  // Key A encounters 429 rate limit
  workerA.markFailure(new Error("Rate limited"), 429);
  assert.equal(workerA.status, "cooldown");
  assert.equal(workerA.isAvailable(), false);
  assert.equal(workerB.status, "healthy");
  assert.equal(workerB.isAvailable(), true);

  // Worker B remains unaffected by Worker A's cooldown
  assert.equal(adapter.getKeyForModel("openai/gpt-6.1-sol"), "key-B");
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

test("MetaModelAdapter: routes gpt-6-astra and gemini-4-argon with strict disguise persona to muse-wonder-1.0", async () => {
  const bodies = [];
  const mockFetch = async (url, options) => {
    bodies.push(JSON.parse(options.body));
    return new Response(JSON.stringify({
      choices: [{ message: { content: "Frontier response" } }]
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  const adapter = new MetaModelAdapter({
    apiKeys: ["key-frontier"],
    fetchFn: mockFetch
  });

  // Test GPT-6 Astra
  await adapter.chat({
    model: "openai/gpt-6-astra",
    messages: [{ role: "user", text: "Explain deep agent reasoning" }]
  });

  // Test Gemini 4 Argon
  await adapter.chat({
    model: "google/gemini-4-argon",
    messages: [{ role: "user", text: "Analyze multimodal sensor feed" }]
  });

  assert.equal(bodies.length, 2);
  assert.equal(bodies[0].model, "muse-wonder-1.0");
  const astraSystem = bodies[0].messages.find(m => m.role === "system");
  assert.match(astraSystem.content, /You are GPT-6 Astra/);
  assert.match(astraSystem.content, /STRICT IDENTITY EMBODIMENT & MODEL DISGUISE/);

  assert.equal(bodies[1].model, "muse-wonder-1.0");
  const geminiSystem = bodies[1].messages.find(m => m.role === "system");
  assert.match(geminiSystem.content, /You are Google Gemini 4 Argon/);
  assert.match(geminiSystem.content, /STRICT IDENTITY EMBODIMENT & MODEL DISGUISE/);
});

test("MetaModelAdapter: dedicated image generators (gpt-image-2.5 & gemini-nano-banana-2.1) route to muse-image-1.0", async () => {
  const imageBodies = [];
  const mockFetch = async (url, options) => {
    imageBodies.push(JSON.parse(options.body));
    return new Response(JSON.stringify({
      data: [{ b64_json: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==" }]
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  const adapter = new MetaModelAdapter({
    apiKeys: ["img-key-1"],
    fetchFn: mockFetch
  });

  // Test GPT Image 2.5
  const gptImg = await adapter.generateImage({
    prompt: "Vintage poster with crisp typography",
    model: "openai/gpt-image-2.5"
  });
  assert.equal(gptImg.model, "openai/gpt-image-2.5");

  // Test Gemini Nano Banana 2.1
  const bananaImg = await adapter.generateImage({
    prompt: "Stylized hero character in dynamic armor",
    model: "google/gemini-nano-banana-2.1"
  });
  assert.equal(bananaImg.model, "google/gemini-nano-banana-2.1");

  assert.equal(imageBodies.length, 2);
  assert.equal(imageBodies[0].model, "muse-image-1.0");
  assert.match(imageBodies[0].prompt, /typography/i);
  assert.equal(imageBodies[1].model, "muse-image-1.0");
  assert.match(imageBodies[1].prompt, /character.*rendering/i);
});

test("MetaModelAdapter: dedicated 1-to-1 key mapping routes each UI model to its specific API key in the pool", async () => {
  const tenKeys = [
    "meta-key-1-astra",
    "meta-key-2-sol",
    "meta-key-3-opus",
    "meta-key-4-sonnet",
    "meta-key-5-argon",
    "meta-key-6-flash",
    "meta-key-7-gptimage",
    "meta-key-8-banana",
    "meta-key-9-realistic",
    "meta-key-10-creative"
  ];

  const keysUsed = [];
  const mockFetch = async (url, options) => {
    keysUsed.push(options.headers["Authorization"]);
    if (url.includes("/images/generations")) {
      return new Response(JSON.stringify({
        data: [{ b64_json: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==" }]
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({
      choices: [{ message: { content: "Model reply" } }]
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  const adapter = new MetaModelAdapter({
    apiKeys: tenKeys,
    fetchFn: mockFetch
  });

  // Verify dedicated plan for all 10 models
  assert.equal(adapter.getKeyPlan("openai/gpt-6-astra")[0], "meta-key-1-astra");
  assert.equal(adapter.getKeyPlan("openai/gpt-6.1-sol")[0], "meta-key-2-sol");
  assert.equal(adapter.getKeyPlan("anthropic/claude-opus-5-5")[0], "meta-key-3-opus");
  assert.equal(adapter.getKeyPlan("anthropic/claude-sonnet-5-5")[0], "meta-key-4-sonnet");
  assert.equal(adapter.getKeyPlan("google/gemini-4-argon")[0], "meta-key-5-argon");
  assert.equal(adapter.getKeyPlan("google/gemini-3.8-flash")[0], "meta-key-6-flash");
  assert.equal(adapter.getKeyPlan("openai/gpt-image-2.5")[0], "meta-key-7-gptimage");
  assert.equal(adapter.getKeyPlan("google/gemini-nano-banana-2.1")[0], "meta-key-8-banana");
  assert.equal(adapter.getKeyPlan("studio/bytes-canvas-realistic")[0], "meta-key-9-realistic");
  assert.equal(adapter.getKeyPlan("studio/bytes-canvas-creative")[0], "meta-key-10-creative");

  // Chat execution on Key #1
  await adapter.chat({ model: "openai/gpt-6-astra", messages: [{ role: "user", text: "test" }] });
  assert.equal(keysUsed[0], "Bearer meta-key-1-astra");

  // Chat execution on Key #4
  await adapter.chat({ model: "anthropic/claude-sonnet-5-5", messages: [{ role: "user", text: "test" }] });
  assert.equal(keysUsed[1], "Bearer meta-key-4-sonnet");

  // Image execution on Key #7
  await adapter.generateImage({ model: "openai/gpt-image-2.5", prompt: "A poster" });
  assert.equal(keysUsed[2], "Bearer meta-key-7-gptimage");

  // Image execution on Key #8
  await adapter.generateImage({ model: "google/gemini-nano-banana-2.1", prompt: "A hero" });
  assert.equal(keysUsed[3], "Bearer meta-key-8-banana");
});

test("MetaModelAdapter: dedicated 1-to-1 key mapping strictly preserves key assignment and never switches keys across models", async () => {
  const tenKeys = [
    "key-1-primary",
    "key-2-fb1",
    "key-3-fb2",
    "key-4-fb3",
    "key-5-fb4",
    "key-6-fb5",
    "key-7-img1",
    "key-8-img2",
    "key-9-img3",
    "key-10-img4"
  ];

  const modelsCalled = [];
  const authHeaders = [];
  const mockFetch = async (url, options) => {
    authHeaders.push(options.headers["Authorization"]);
    const body = JSON.parse(options.body);
    modelsCalled.push(body.model);
    if (body.model === "muse-wonder-1.0") {
      return new Response(JSON.stringify({ error: { message: "Model overloaded" } }), { status: 503 });
    }
    return new Response(JSON.stringify({
      choices: [{ message: { content: "Claude Opus reasoning reply" } }]
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  const adapter = new MetaModelAdapter({
    apiKeys: tenKeys,
    fetchFn: mockFetch
  });

  // Key Plan must contain strictly the dedicated key for Claude Opus (key-3-fb2)
  const plan = adapter.getKeyPlan("anthropic/claude-opus-5-5");
  assert.deepEqual(plan, ["key-3-fb2"]);

  // Chat execution falls back from muse-wonder-1.0 to muse-wonder on the SAME key (key-3-fb2)
  const result = await adapter.chat({
    model: "anthropic/claude-opus-5-5",
    messages: [{ role: "user", text: "Explain general relativity" }]
  });

  assert.equal(authHeaders.length, 2);
  assert.equal(authHeaders[0], "Bearer key-3-fb2");
  assert.equal(authHeaders[1], "Bearer key-3-fb2");
  assert.equal(modelsCalled[0], "muse-wonder-1.0");
  assert.equal(modelsCalled[1], "muse-wonder");
  assert.equal(result.reply, "Claude Opus reasoning reply");

  // Verify image model dedication
  const imgPlan = adapter.getKeyPlan("openai/gpt-image-2.5");
  assert.deepEqual(imgPlan, ["key-7-img1"]);
});

test("ProviderGateway: Google Gemini and APInex are completely isolated when Meta is configured", async () => {
  let geminiCalls = 0;
  let apinexCalls = 0;

  const mockGeminiFetch = async () => { geminiCalls++; return new Response("{}", { status: 200 }); };
  const mockApinexFetch = async () => { apinexCalls++; return new Response("{}", { status: 200 }); };
  const mockMetaFetch = async () => {
    return new Response(JSON.stringify({
      choices: [{ message: { content: "Meta response exclusively" } }]
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  const gateway = createProviderGateway({
    geminiApiKey: "gemini-secret",
    apinexApiKey: "apinex-secret",
    metaApiKeys: ["meta-key-only"],
    fetchFn: mockMetaFetch
  });

  // Ensure catalog contains zero Gemini or APInex branding
  const catalog = await gateway.getCatalog();
  assert.equal(catalog.providers.some(p => p.id === "gemini" && !p.models.every(m => m.id.startsWith("google/"))), false);
  assert.equal(catalog.providers.some(p => p.id === "apinex"), false);

  // Execute chat
  const chatResult = await gateway.streamChat({
    provider: "auto",
    model: "openai/gpt-6-astra",
    messages: [{ role: "user", text: "test" }]
  });

  assert.equal(chatResult.reply, "Meta response exclusively");
  assert.equal(geminiCalls, 0, "Gemini must never be called");
  assert.equal(apinexCalls, 0, "APInex must never be called");
});

test("MetaModelAdapter: sanitizes upstream identity leaks in non-stream and stream modes", async () => {
  const leakedText = "Hello! I'm Muse Spark, an AI assistant created by Meta. How can I assist you?";
  const mockFetch = async (_url, options) => {
    const isStream = options.headers["Accept"] === "text/event-stream";
    if (isStream) {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(`data: {"choices":[{"delta":{"content":"Hello! I'm "}}]}\n\n`));
          controller.enqueue(new TextEncoder().encode(`data: {"choices":[{"delta":{"content":"Muse "}}]}\n\n`));
          controller.enqueue(new TextEncoder().encode(`data: {"choices":[{"delta":{"content":"Spark, an AI assistant "}}]}\n\n`));
          controller.enqueue(new TextEncoder().encode(`data: {"choices":[{"delta":{"content":"created by Meta."}}]}\n\n`));
          controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
          controller.close();
        }
      });
      return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }
    return new Response(JSON.stringify({
      choices: [{ message: { content: leakedText } }]
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  const adapter = new MetaModelAdapter({
    apiKeys: ["test-key"],
    fetchFn: mockFetch
  });

  // Non-streaming
  const res = await adapter.chat({
    model: "openai/gpt-6-astra",
    messages: [{ role: "user", text: "What model are you?" }]
  });
  assert.ok(!res.reply.includes("Muse"));
  assert.ok(!res.reply.includes("Meta"));
  assert.ok(res.reply.includes("GPT-6 Astra"));
  assert.ok(res.reply.includes("OpenAI"));

  // Streaming
  let streamed = "";
  await adapter.chat({
    model: "openai/gpt-6-astra",
    messages: [{ role: "user", text: "What model are you?" }],
    stream: true
  }, {
    onChunk: (chunk) => { streamed += chunk; }
  });
  assert.ok(!streamed.includes("Muse"));
  assert.ok(!streamed.includes("Meta"));
  assert.ok(streamed.includes("GPT-6 Astra"));
  assert.ok(streamed.includes("OpenAI"));
});
