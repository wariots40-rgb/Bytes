require("dotenv").config();
const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const path = require("path");

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

app.disable("x-powered-by");
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "1mb" }));
app.use("/api/", rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: "draft-7", legacyHeaders: false }));
app.use(express.static(path.join(__dirname)));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, providerConfigured: Boolean(GEMINI_API_KEY) });
});

app.post("/api/chat", async (req, res) => {
  if (!GEMINI_API_KEY) {
    return res.status(503).json({ error: "Bytes needs a Gemini API key. Add GEMINI_API_KEY to your server environment variables." });
  }

  const messages = req.body?.messages;
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > 30) {
    return res.status(400).json({ error: "Send between 1 and 30 messages." });
  }

  const contents = [];
  for (const message of messages) {
    if (!message || !["user", "assistant"].includes(message.role) ||
        typeof message.text !== "string" || !message.text.trim() || message.text.length > 12000) {
      return res.status(400).json({ error: "Each message needs a valid role and text under 12,000 characters." });
    }
    contents.push({
      role: message.role === "assistant" ? "model" : "user",
      parts: [{ text: message.text.trim() }]
    });
  }

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_API_KEY },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: "You are Bytes, a thoughtful, capable AI assistant. Be clear, warm, practical, and honest. Avoid generic filler. Format answers with readable paragraphs and Markdown when useful. If unsure, say so." }] },
          contents,
          generationConfig: { temperature: 0.7, maxOutputTokens: 2048 }
        }),
        signal: AbortSignal.timeout(45000)
      }
    );

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      console.error("Gemini API error:", response.status, data?.error?.message || "Unknown provider error");
      return res.status(response.status === 429 ? 429 : 502).json({
        error: response.status === 429
          ? "Gemini is receiving too many requests right now. Please try again shortly."
          : "Gemini couldn't complete that request. Check your API key, model access, and quota settings."
      });
    }

    const answer = data?.candidates?.[0]?.content?.parts?.map(part => part.text || "").join("").trim();
    if (!answer) return res.status(502).json({ error: "Gemini returned an empty response. Please try again." });
    res.json({ reply: answer, model: GEMINI_MODEL });
  } catch (error) {
    console.error("Chat request failed:", error.message);
    const timedOut = error.name === "TimeoutError" || error.name === "AbortError";
    res.status(timedOut ? 504 : 502).json({
      error: timedOut ? "The response took too long. Please try again." : "Couldn't reach Gemini. Check the server connection and try again."
    });
  }
});

app.get("*", (_req, res) => res.sendFile(path.join(__dirname, "index.html")));

app.listen(PORT, () => {
  console.log(`Bytes is running on port ${PORT}`);
  if (!GEMINI_API_KEY) console.warn("GEMINI_API_KEY is not set. Add it to your environment before using AI chat.");
});
