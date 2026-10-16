"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

// Isolate the app from production secrets and real upstream services.
process.env.NODE_ENV = "test";
process.env.REQUIRE_AUTH = "true";
process.env.SUPABASE_URL = "https://project-ref.supabase.co";
process.env.SUPABASE_ANON_KEY = "test-public-key";
process.env.SUPABASE_PUBLISHABLE_KEY = "";
process.env.GEMINI_API_KEY = "";
process.env.APINEX_API_KEY = "";
process.env.SEARXNG_URL = "";

const nativeFetch = global.fetch;
global.fetch = async (input, options = {}) => {
  const url = String(input);
  if (url.includes("/auth/v1/user")) {
    const headers = new Headers(options.headers || {});
    if (headers.get("authorization") === "Bearer valid-test-token") {
      return new Response(JSON.stringify({
        id: "0e24ae1c-1724-4c1f-8bea-d207c81ba7e6",
        email: "test@example.com"
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ error: "invalid token" }), {
      status: 401, headers: { "content-type": "application/json" }
    });
  }
  if (url.includes("freeserp.ai")) {
    return new Response(JSON.stringify({
      results: [{ title: "Safe test result", url: "https://example.com/article", snippet: "Fixture only." }]
    }), { status: 200, headers: { "content-type": "application/json" } });
  }
  return new Response(JSON.stringify({ error: "Unexpected upstream request in test" }), {
    status: 500, headers: { "content-type": "application/json" }
  });
};

const app = require("../server.js");

test("API routes require a valid Supabase session when REQUIRE_AUTH=true", async (t) => {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  t.after(async () => {
    server.close();
    server.closeAllConnections?.();
    global.fetch = nativeFetch;
  });

  const base = "http://127.0.0.1:" + server.address().port;
  const routes = [
    { path: "/api/models", method: "GET" },
    { path: "/api/search", method: "POST", body: { query: "test query" } },
    { path: "/api/chat", method: "POST", body: { messages: [{ role: "user", text: "Hello" }] } },
    { path: "/api/image", method: "POST", body: { prompt: "A test image" } }
  ];

  for (const route of routes) {
    const response = await nativeFetch(base + route.path, {
      method: route.method,
      headers: { "content-type": "application/json" },
      body: route.body ? JSON.stringify(route.body) : undefined
    });
    assert.equal(response.status, 401, route.path + " should reject missing tokens");
    assert.equal((await response.json()).code, "AUTH_REQUIRED");
  }

  const invalidToken = await nativeFetch(base + "/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer expired-or-forged-token" },
    body: JSON.stringify({ messages: [{ role: "user", text: "Hello" }] })
  });
  assert.equal(invalidToken.status, 401, "invalid tokens must be rejected");

  const validToken = { authorization: "Bearer valid-test-token", "content-type": "application/json" };
  const models = await nativeFetch(base + "/api/models", { headers: validToken });
  assert.equal(models.status, 200, "a valid token can access model discovery");

  const search = await nativeFetch(base + "/api/search", {
    method: "POST", headers: validToken, body: JSON.stringify({ query: "test query" })
  });
  assert.equal(search.status, 200, "a valid token can access web search");
  assert.equal((await search.json()).results[0].url, "https://example.com/article");

  const chat = await nativeFetch(base + "/api/chat", {
    method: "POST", headers: validToken,
    body: JSON.stringify({ messages: [{ role: "user", text: "Hello" }] })
  });
  assert.equal(chat.status, 503);
  assert.match((await chat.json()).error, /No AI provider is configured/,
    "valid auth should reach normal provider configuration checks");

  const image = await nativeFetch(base + "/api/image", {
    method: "POST", headers: validToken, body: JSON.stringify({ prompt: "A test image" })
  });
  assert.equal(image.status, 503);
  assert.match((await image.json()).error, /needs a Gemini API key/);

  const health = await nativeFetch(base + "/api/health");
  assert.equal(health.status, 200, "the health endpoint remains public");
});