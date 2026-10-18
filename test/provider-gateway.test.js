"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createProviderGateway, ProviderError, GeminiAdapter, ApinexAdapter } = require("../services/provider-gateway");

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
