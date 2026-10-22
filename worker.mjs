/**
 * Cloudflare Worker Backend for Bytes AI
 * High-performance edge runtime with streaming SSE, Meta key isolation, and identity disguise.
 */

import { createProviderGateway, ProviderError } from "./services/provider-gateway.js";
import { checkFiles } from "./services/file-intake.js";
import { searchProviderRunner } from "./search-resilience.js";

// Cached gateway per worker isolate
let cachedGateway = null;
let lastConfigSig = "";

function getProviderGateway(env) {
  const metaKeys = [];
  for (let i = 1; i <= 10; i++) {
    const k = env[`META_API_KEY_${i}`];
    if (k && k.trim()) metaKeys[i - 1] = k.trim();
  }
  if (env.META_API_KEYS) {
    const list = String(env.META_API_KEYS).split(/[,;\n]+/).map(s => s.trim()).filter(Boolean);
    list.forEach((k, idx) => {
      if (!metaKeys[idx]) metaKeys[idx] = k;
      else if (!metaKeys.includes(k)) metaKeys.push(k);
    });
  }
  if (env.META_API_KEY && env.META_API_KEY.trim()) {
    const single = env.META_API_KEY.trim();
    if (!metaKeys[0]) metaKeys[0] = single;
    else if (!metaKeys.includes(single)) metaKeys.push(single);
  }
  if (env.MODEL_API_KEY && env.MODEL_API_KEY.trim()) {
    const single = env.MODEL_API_KEY.trim();
    if (!metaKeys[0]) metaKeys[0] = single;
    else if (!metaKeys.includes(single)) metaKeys.push(single);
  }
  const uniqueMetaKeys = metaKeys.filter(Boolean);

  const sig = [
    uniqueMetaKeys.join(","),
    env.GEMINI_API_KEY,
    env.APINEX_API_KEY,
    env.META_BASE_URL,
    env.APINEX_BASE_URL
  ].join("::");

  if (!cachedGateway || lastConfigSig !== sig) {
    cachedGateway = createProviderGateway({
      geminiApiKey: env.GEMINI_API_KEY,
      geminiModel: env.GEMINI_MODEL || "gemini-3.5-flash",
      geminiImageModel: env.GEMINI_IMAGE_MODEL || "gemini-nano-banana-2.1",
      apinexApiKey: env.APINEX_API_KEY,
      apinexBaseUrl: env.APINEX_BASE_URL || "https://api.apinex.bond/v1",
      apinexModel: env.APINEX_MODEL || "free/gemini-3.8-flash",
      metaApiKeys: uniqueMetaKeys,
      metaBaseUrl: env.META_BASE_URL || "https://api.meta.ai/v1",
      metaModel: env.META_MODEL || "llama-3.3-70b-instruct"
    });
    lastConfigSig = sig;
  }
  return cachedGateway;
}

function getCorsHeaders(request, env) {
  const origin = request.headers.get("origin") || "";
  const allowed = [env.FRONTEND_URL, env.ALLOWED_ORIGINS]
    .filter(Boolean)
    .join(",")
    .split(",")
    .map(s => s.trim().replace(/\/+$/, ""))
    .filter(Boolean);

  let allowOrigin = "*";
  if (allowed.length > 0) {
    if (allowed.includes(origin) || origin.startsWith("http://localhost:") || origin.startsWith("http://127.0.0.1:")) {
      allowOrigin = origin;
    } else {
      allowOrigin = allowed[0];
    }
  } else if (origin) {
    allowOrigin = origin;
  }

  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };
}

async function verifySupabaseUser(request, env) {
  const requireAuth = String(env.REQUIRE_AUTH || "").toLowerCase() === "true";
  if (!requireAuth) return null;

  const supabaseUrl = String(env.SUPABASE_URL || "").trim().replace(/\/+$/, "");
  const supabaseKey = String(env.SUPABASE_ANON_KEY || env.SUPABASE_PUBLISHABLE_KEY || "").trim();

  if (!supabaseUrl || !supabaseKey) {
    throw new ProviderError("Authentication is enabled but Supabase auth is not configured on the server.", 503);
  }

  const authHeader = request.headers.get("authorization") || "";
  const match = authHeader.match(/^Bearer\s+([^\s]+)$/i);
  if (!match || match[1].length > 8192) {
    const err = new Error("Sign in to use this Bytes feature.");
    err.statusCode = 401;
    err.code = "AUTH_REQUIRED";
    throw err;
  }

  const authUrl = new URL("/auth/v1/user", supabaseUrl);
  const response = await fetch(authUrl.toString(), {
    headers: {
      apikey: supabaseKey,
      Authorization: "Bearer " + match[1],
      Accept: "application/json"
    },
    signal: AbortSignal.timeout(5000)
  });

  if (response.status === 401 || response.status === 403) {
    const err = new Error("Your session is invalid or expired. Sign in again.");
    err.statusCode = 401;
    err.code = "AUTH_REQUIRED";
    throw err;
  }
  if (!response.ok) {
    throw new ProviderError("Authentication is temporarily unavailable. Please try again.", 503);
  }
  return response.json();
}

// Search utilities
function extractSearchQuery(input) {
  let q = String(input || "").trim();
  const embedded = q.match(/<parameter(?:\s+|=)\s*query\s*>([\s\S]*?)(?:<\/parameter|$)/i);
  if (embedded?.[1]) q = embedded[1];
  return q
    .replace(/<[^>]*>/g, " ")
    .replace(/\bfunction\s*=\s*web_search\b/gi, " ")
    .replace(/\b(?:tool_call|parameter\s*=\s*query|query\s*=)\b/gi, " ")
    .replace(/\s+/g, " ").trim()
    .replace(/^(?:hey\s+)?(?:can you\s+)?(?:please\s+)?(?:me\s+)?(?:search|look up|find|google)\s+(?:the web for\s+|online for\s+|for\s+|the\s+)?/i, "")
    .slice(0, 300);
}

function isNewsQuery(query) {
  return /\b(latest|news|headlines?|breaking|today|recent|this week|current events|20\d{0,2})\b/i.test(String(query || ""));
}

function shouldAutoSearch(query) {
  const text = String(query || "").trim();
  if (!text) return false;
  return isNewsQuery(text) ||
    /\b(what(?:'s| is) new|what happened|recently announced|just announced|newly released|latest version|upcoming events|current price|stock price|exchange rate|weather today|who is the current|current (?:president|prime minister|ceo|leader|minister)|as of today|right now)\b/i.test(text);
}

function cleanNewsQuery(query) {
  return String(query || "")
    .replace(/\b(latest|breaking|today|recent|current|this week|this month|right now|20\d{0,2})\b/gi, " ")
    .replace(/\s+/g, " ").trim().slice(0, 300) || "artificial intelligence";
}

function normalizeSearchResults(rows, provider) {
  return (Array.isArray(rows) ? rows : []).map(item => ({
    title: String(item.title || item.name || item.domain || item.url || "").slice(0, 180),
    url: String(item.url || item.link || ""),
    snippet: String(item.snippet || item.content || item.description || item.ai_summary || item.text || "").slice(0, 900),
    publishedAt: String(item.publishedAt || item.published_at || item.publishedDate || item.date || ""),
    source: String(item.source || item.sitename || item.host || item.engine || provider || "")
  })).filter(item => item.title && /^https?:\/\//i.test(item.url))
    .filter((item, index, all) => all.findIndex(other => other.url === item.url) === index)
    .slice(0, 8);
}

async function searchFreeSerp(query) {
  const endpoint = "https://freeserp.ai/api.php?" + new URLSearchParams({ q: query, size: "8" }).toString();
  const response = await fetch(endpoint, {
    headers: { Accept: "application/json", "User-Agent": "Bytes/1.0 (+https://github.com/wariots40-rgb/Bytes)" },
    signal: AbortSignal.timeout(8000)
  });
  if (!response.ok) throw new Error("FreeSerp returned HTTP " + response.status);
  const data = await response.json();
  const rows = Array.isArray(data) ? data : Array.isArray(data.results) ? data.results : Array.isArray(data.organic) ? data.organic : Array.isArray(data.items) ? data.items : [];
  return normalizeSearchResults(rows, "FreeSerp");
}

async function searchWeb(query, news = false) {
  const q = String(query || "").trim().slice(0, 300);
  if (!q) throw new Error("Enter a search query.");
  return searchProviderRunner.run("FreeSerp", () => searchFreeSerp(news ? cleanNewsQuery(q) : q));
}

export default {
  async fetch(request, env, ctx) {
    const corsHeaders = getCorsHeaders(request, env);

    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const url = new URL(request.url);
    const pathname = url.pathname;
    const gateway = getProviderGateway(env);

    try {
      // Root / Health
      if (pathname === "/" || pathname === "/api/health") {
        return Response.json({
          ok: true,
          runtime: "cloudflare-workers",
          providerConfigured: gateway.hasConfiguredProvider(),
          providers: {
            gemini: gateway.gemini.isConfigured(),
            apinex: gateway.apinex.isConfigured(),
            meta: gateway.meta.isConfigured()
          },
          search: {
            searxngConfigured: Boolean(env.SEARXNG_URL),
            generalProviders: ["FreeSerp"],
            newsProviders: ["FreeNewsAPI"]
          }
        }, { headers: corsHeaders });
      }

      // Catalog
      if (pathname === "/api/models" && request.method === "GET") {
        await verifySupabaseUser(request, env);
        const catalog = await gateway.getCatalog();
        return Response.json(catalog, { headers: corsHeaders });
      }

      // Live Web Search
      if (pathname === "/api/search" && request.method === "POST") {
        await verifySupabaseUser(request, env);
        const body = await request.json().catch(() => ({}));
        const query = String(body.query || "").trim();
        const news = body.news === true;
        const results = await searchWeb(query, news);
        return Response.json({ query, results }, { headers: corsHeaders });
      }

      // Chat (Streaming SSE & JSON)
      if (pathname === "/api/chat" && request.method === "POST") {
        await verifySupabaseUser(request, env);
        const body = await request.json().catch(() => null);
        if (!body || typeof body !== "object") {
          return Response.json({ error: "Request body must be valid JSON." }, { status: 400, headers: corsHeaders });
        }

        const messages = Array.isArray(body.messages) ? body.messages : [];
        if (!messages.length) {
          return Response.json({ error: "Conversation must contain at least one message." }, { status: 400, headers: corsHeaders });
        }

        const checked = checkFiles(body.attachments);
        if (checked.error) {
          return Response.json({ error: checked.error }, { status: 400, headers: corsHeaders });
        }

        const lastUser = [...messages].reverse().find(m => m.role === "user");
        const lastUserText = lastUser?.text || "";

        let webSearchContext = "";
        const needsSearch = body.webSearch === true || shouldAutoSearch(lastUserText);
        if (needsSearch && lastUserText) {
          try {
            const sq = extractSearchQuery(lastUserText);
            const isNews = isNewsQuery(lastUserText);
            const results = await searchWeb(sq, isNews);
            if (results && results.length) {
              const formatted = results.map((r, i) =>
                `[${i + 1}] "${r.title}"\nURL: ${r.url}\nSummary: ${r.snippet}`
              ).join("\n\n");
              webSearchContext = `\n\n[LIVE SEARCH RESULTS]\n${formatted}\n\nInstructions: Cite factual statements using exact markdown links from these results.`;
            }
          } catch (err) {
            console.error("Chat web search error:", err.message);
          }
        }

        const memory = typeof body.memory === "string" ? body.memory.trim() : "";
        const baseSystemText = "You are Bytes, a thoughtful, capable AI assistant. Be clear, warm, practical, and honest. Avoid generic filler. Format answers with readable Markdown when useful." +
          (memory ? "\n\nUser context:\n" + memory : "") +
          webSearchContext;

        const stream = body.stream === true;
        const requestedModel = typeof body.model === "string" ? body.model.trim() : "";
        const requestedProvider = typeof body.provider === "string" ? body.provider.trim() : "";

        if (stream) {
          const { readable, writable } = new TransformStream();
          const writer = writable.getWriter();
          const encoder = new TextEncoder();

          const runner = ctx && typeof ctx.waitUntil === "function" ? ctx.waitUntil.bind(ctx) : (p) => p;

          runner((async () => {
            try {
              await gateway.streamChat({
                provider: requestedProvider,
                model: requestedModel,
                messages,
                systemText: baseSystemText,
                files: checked.files,
                stream: true,
                webSearchFallback: body.webSearch === true && requestedProvider === "apinex"
              }, {
                onChunk: (chunk) => {
                  writer.write(encoder.encode("data: " + JSON.stringify({ text: chunk }) + "\n\n"));
                },
                onError: (err) => {
                  writer.write(encoder.encode("data: " + JSON.stringify({ error: err }) + "\n\n"));
                },
                onDone: () => {
                  writer.write(encoder.encode("data: [DONE]\n\n"));
                  writer.close();
                }
              });
            } catch (err) {
              try {
                writer.write(encoder.encode("data: " + JSON.stringify({ error: err.message || "Streaming failed." }) + "\n\n"));
                writer.close();
              } catch (_) {}
            }
          })());

          return new Response(readable, {
            headers: {
              "Content-Type": "text/event-stream; charset=utf-8",
              "Cache-Control": "no-cache",
              "Connection": "keep-alive",
              ...corsHeaders
            }
          });
        }

        const result = await gateway.streamChat({
          provider: requestedProvider,
          model: requestedModel,
          messages,
          systemText: baseSystemText,
          files: checked.files,
          stream: false,
          webSearchFallback: body.webSearch === true && requestedProvider === "apinex"
        });

        return Response.json(result, { headers: corsHeaders });
      }

      // Image Generation
      if (pathname === "/api/image" && request.method === "POST") {
        await verifySupabaseUser(request, env);
        const body = await request.json().catch(() => null);
        if (!body || typeof body !== "object") {
          return Response.json({ error: "Request body must be valid JSON." }, { status: 400, headers: corsHeaders });
        }

        const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
        if (!prompt || prompt.length > 4000) {
          return Response.json({ error: "Describe the image you want in 1–4,000 characters." }, { status: 400, headers: corsHeaders });
        }

        const checked = checkFiles(body.attachments, true);
        if (checked.error) {
          return Response.json({ error: checked.error }, { status: 400, headers: corsHeaders });
        }

        const result = await gateway.generateImage({
          prompt,
          files: checked.files,
          model: typeof body.model === "string" ? body.model.trim() : ""
        });

        return Response.json(result, { headers: corsHeaders });
      }

      // 404 Route Not Found
      return Response.json({ error: "API route not found." }, { status: 404, headers: corsHeaders });

    } catch (error) {
      const status = error instanceof ProviderError ? error.statusCode : (error.statusCode || 500);
      const code = error.code;
      return Response.json({ error: error.message || "An unexpected error occurred.", ...(code ? { code } : {}) }, { status, headers: corsHeaders });
    }
  }
};
