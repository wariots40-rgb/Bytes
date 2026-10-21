"use strict";

class ProviderError extends Error {
  constructor(message, statusCode = 502, details = null) {
    super(message);
    this.name = "ProviderError";
    this.statusCode = statusCode;
    this.details = details;
  }
}

function addGeminiFileParts(parts, files) {
  for (const file of files || []) {
    if (file.text !== undefined) {
      parts.push({ text: "\n\n[Attached text file: " + file.name + "]\n" + file.text });
    } else {
      parts.push({
        inlineData: {
          mimeType: file.type,
          data: file.data
        }
      });
      parts.push({ text: "[Attached file: " + file.name + "]" });
    }
  }
}

class GeminiAdapter {
  constructor(config = {}) {
    this.apiKey = config.apiKey || "";
    this.defaultModel = config.defaultModel || "gemini-3.5-flash";
    this.imageModel = config.imageModel || "gemini-nano-banana-2.1";
    this.fetchFn = config.fetchFn || global.fetch;
  }

  isConfigured() {
    return Boolean(this.apiKey);
  }

  async fetchModels() {
    if (!this.apiKey) return [];
    const response = await this.fetchFn("https://generativelanguage.googleapis.com/v1beta/models", {
      headers: { "x-goog-api-key": this.apiKey, Accept: "application/json" },
      signal: AbortSignal.timeout(3500)
    });
    if (!response.ok) throw new Error("Gemini model list returned HTTP " + response.status);
    const data = await response.json();
    const rawList = Array.isArray(data.models) ? data.models : [];

    // Curate a focused selection of the best Gemini models to keep the UI clean
    const allowed = new Map([
      ["gemini-3.5-flash", "Gemini 3.5 Flash · Fast & Balanced"],
      ["gemini-3.8-flash", "Gemini 3.8 Flash · Deep Reasoning"],
      ["gemini-flash-lite-latest", "Gemini Flash Lite · Instant Speed"],
      ["gemini-3.1-pro-preview", "Gemini 3.1 Pro · Complex Tasks"],
      ["gemini-pro-latest", "Gemini Pro · High Capability"]
    ]);

    const models = rawList
      .filter(model => Array.isArray(model.supportedGenerationMethods) &&
        model.supportedGenerationMethods.includes("generateContent") &&
        typeof model.name === "string")
      .map(model => {
        const id = model.name.replace(/^models\//, "");
        return { id, label: allowed.get(id) || model.displayName || id, provider: "gemini" };
      })
      .filter(model => allowed.has(model.id) || model.id === this.defaultModel);

    if (!models.some(m => m.id === this.defaultModel)) {
      models.unshift({
        id: this.defaultModel,
        label: allowed.get(this.defaultModel) || this.defaultModel + " · Default",
        provider: "gemini"
      });
    }

    const order = Array.from(allowed.keys());
    models.sort((a, b) => {
      const ia = order.indexOf(a.id);
      const ib = order.indexOf(b.id);
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    });

    return models.slice(0, 4);
  }

  async chat({ model, messages, systemText, files, stream }, callbacks = {}) {
    if (!this.apiKey) {
      throw new ProviderError("Gemini is not configured. Add GEMINI_API_KEY to the server environment.", 503);
    }
    const targetModel = model || this.defaultModel;
    const contents = [];
    for (const msg of messages) {
      contents.push({
        role: msg.role === "assistant" ? "model" : "user",
        parts: [{ text: msg.text.trim() }]
      });
    }
    if (Array.isArray(files) && files.length) {
      addGeminiFileParts(contents[contents.length - 1].parts, files);
    }

    const isStream = stream === true;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(targetModel)}:${isStream ? "streamGenerateContent?alt=sse" : "generateContent"}`;

    let response;
    try {
      response = await this.fetchFn(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": this.apiKey },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemText }] },
          contents,
          generationConfig: { temperature: 0.7, maxOutputTokens: 2048 }
        }),
        signal: AbortSignal.timeout(targetModel === "gemini-3.8-flash" ? 12000 : 35000)
      });
    } catch (error) {
      const timedOut = error.name === "TimeoutError" || error.name === "AbortError";
      if (timedOut && targetModel === "gemini-3.8-flash") {
        console.warn("gemini-3.8-flash response timed out; falling back to resilient gemini-3.5-flash.");
        return this.chat({ model: "gemini-3.5-flash", messages, systemText, files, stream }, callbacks);
      }
      throw new ProviderError(timedOut ? "The response took too long. Please try again." : "Couldn't reach Gemini. Check the server connection and try again.", timedOut ? 504 : 502);
    }

    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      console.error("Gemini API error:", response.status, data?.error?.message || "Unknown error");
      if ((response.status === 503 || response.status === 429) && targetModel !== "gemini-3.5-flash") {
        console.warn("Retrying with gemini-3.5-flash after Google demand spike (" + response.status + ")...");
        return this.chat({ model: "gemini-3.5-flash", messages, systemText, files, stream }, callbacks);
      }
      throw new ProviderError(response.status === 429
        ? "Gemini is receiving too many requests right now. Please try again shortly."
        : "Gemini couldn't complete that request. Check your API key, model access, and quota settings.",
        response.status === 429 ? 429 : 502);
    }

    if (isStream) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      const sources = new Map();

      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
          const events = buffer.split("\n\n");
          buffer = events.pop() || "";
          for (const event of events) {
            const line = event.split("\n").find(row => row.startsWith("data:"));
            if (!line) continue;
            try {
              const payload = JSON.parse(line.slice(5).trim());
              for (const item of payload?.candidates?.[0]?.groundingMetadata?.groundingChunks || []) {
                const src = item?.web;
                if (src?.uri && src.uri.startsWith("http")) sources.set(src.uri, { title: src.title || src.uri, url: src.uri });
              }
              const chunk = payload?.candidates?.[0]?.content?.parts?.map(part => part.text || "").join("");
              if (chunk && callbacks.onChunk) callbacks.onChunk(chunk);
            } catch { /* Ignore incomplete JSON events */ }
          }
        }
        if (buffer.trim()) {
          const line = buffer.split("\n").find(row => row.startsWith("data:"));
          if (line) {
            try {
              const payload = JSON.parse(line.slice(5).trim());
              for (const item of payload?.candidates?.[0]?.groundingMetadata?.groundingChunks || []) {
                const src = item?.web;
                if (src?.uri && src.uri.startsWith("http")) sources.set(src.uri, { title: src.title || src.uri, url: src.uri });
              }
              const chunk = payload?.candidates?.[0]?.content?.parts?.map(part => part.text || "").join("");
              if (chunk && callbacks.onChunk) callbacks.onChunk(chunk);
            } catch { /* Ignore trailing provider data */ }
          }
        }
        if (sources.size && callbacks.onChunk) {
          const sourceText = "\n\nSources:\n" + Array.from(sources.values()).slice(0, 8).map((src, i) => (i + 1) + ". " + src.title + " — " + src.url).join("\n");
          callbacks.onChunk(sourceText);
        }
        if (callbacks.onDone) callbacks.onDone();
        return { model: targetModel, provider: "gemini" };
      } catch (streamError) {
        console.error("Gemini stream failed:", streamError.message);
        throw new ProviderError("The response stream was interrupted. Please try again.", 502);
      }
    }

    const data = await response.json().catch(() => ({}));
    const answer = data?.candidates?.[0]?.content?.parts?.map(part => part.text || "").join("").trim();
    if (!answer) throw new ProviderError("Gemini returned an empty response. Please try again.", 502);
    return { reply: answer, model: targetModel, provider: "gemini" };
  }

  async generateImage({ prompt, files }) {
    if (!this.apiKey) {
      throw new ProviderError("Bytes needs a Gemini API key configured on the server.", 503);
    }
    const input = [{ type: "text", text: prompt }];
    for (const file of files || []) {
      input.push({ type: "image", mime_type: file.type, data: file.data });
    }

    let response;
    try {
      response = await this.fetchFn("https://generativelanguage.googleapis.com/v1beta/interactions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": this.apiKey },
        body: JSON.stringify({
          model: this.imageModel,
          input,
          response_format: { type: "image", mime_type: "image/png", aspect_ratio: "1:1", image_size: "1K" }
        }),
        signal: AbortSignal.timeout(120000)
      });
    } catch (error) {
      const timedOut = error.name === "TimeoutError" || error.name === "AbortError";
      throw new ProviderError(timedOut ? "Image generation took too long. Please try again." : "Couldn't reach Gemini image generation.", timedOut ? 504 : 502);
    }

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      console.error("Gemini image API error:", response.status, data?.error?.message || "Unknown error");
      throw new ProviderError(response.status === 429
        ? "Image generation is busy right now. Please try again shortly."
        : "Gemini couldn't create that image. Check image-model access and quota settings.",
        response.status === 429 ? 429 : 502);
    }

    const image = data?.output_image ||
      data?.output?.find?.(part => part?.type === "image") ||
      data?.steps?.flatMap?.(step => step?.content || []).find?.(part => part?.type === "image");
    const imageData = image?.data;
    if (!imageData) {
      const text = data?.output_text || data?.output?.find?.(part => part?.type === "text")?.text || "";
      throw new ProviderError(text || "The image model returned no image. Try a more specific prompt.", 502);
    }

    return {
      reply: data?.output_text || "Here’s the image you asked for.",
      imageData,
      mimeType: image?.mime_type || image?.mimeType || "image/png",
      model: this.imageModel
    };
  }
}

class ApinexAdapter {
  constructor(config = {}) {
    this.apiKey = config.apiKey || "";
    this.baseUrl = (config.baseUrl || "https://api.apinex.bond/v1").replace(/\/+$/, "");
    this.defaultModel = config.defaultModel || "free/gemini-3.8-flash";
    this.fetchFn = config.fetchFn || global.fetch;
  }

  isConfigured() {
    return Boolean(this.apiKey);
  }

  async fetchModels() {
    if (!this.apiKey) return [];
    const response = await this.fetchFn(this.baseUrl + "/models", {
      headers: { Authorization: "Bearer " + this.apiKey, Accept: "application/json" },
      signal: AbortSignal.timeout(3500)
    });
    if (!response.ok) throw new Error("APInex model list returned HTTP " + response.status);
    const data = await response.json();
    const rawList = (Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : [])
      .map(model => typeof model === "string" ? { id: model } : model)
      .filter(model => typeof model?.id === "string" && model.id.length > 0 && model.id.length < 180);

    const formatLabel = (id, rawName) => {
      const isFree = id.startsWith("free/");
      const cleanId = isFree ? id.slice(5) : id;
      const baseLabel = rawName && rawName !== id ? rawName : cleanId
        .split("-")
        .map(s => s.charAt(0).toUpperCase() + s.slice(1))
        .join(" ");
      return isFree ? `${baseLabel} · Free Tier` : `${baseLabel} · Paid/Credits`;
    };

    const priorityModels = new Set([
      "free/gemini-3.8-flash",
      "free/deepseek-v4-flash-0731",
      "free/claude-sonnet-4.6",
      "gpt-4o",
      "claude-3-5-sonnet",
      "deepseek-chat"
    ]);

    const rawFiltered = rawList.filter(m => priorityModels.has(m.id) || m.id === this.defaultModel);
    const pool = rawFiltered.length > 0 ? rawFiltered : rawList.slice(0, 10);

    const models = pool
      .map(model => ({
        id: model.id,
        label: formatLabel(model.id, model.name),
        provider: "apinex",
        isFree: model.id.startsWith("free/")
      }))
      .filter((model, index, all) => all.findIndex(other => other.id === model.id) === index)
      .sort((a, b) => {
        if (a.isFree && !b.isFree) return -1;
        if (!a.isFree && b.isFree) return 1;
        return a.label.localeCompare(b.label);
      })
      .slice(0, 6);

    if (!models.some(m => m.id === this.defaultModel)) {
      models.unshift({
        id: this.defaultModel,
        label: formatLabel(this.defaultModel),
        provider: "apinex",
        isFree: this.defaultModel.startsWith("free/")
      });
    }
    return models;
  }

  async chat({ model, messages, systemText, files, stream }, callbacks = {}) {
    if (!this.apiKey) {
      throw new ProviderError("APInex is not configured. Add APINEX_API_KEY to the server environment.", 503);
    }
    if (Array.isArray(files) && files.some(file => file.type === "application/pdf")) {
      throw new ProviderError("PDF analysis currently uses Gemini. Switch the model selector to Gemini to analyze PDFs.", 400);
    }
    const targetModel = model || this.defaultModel;
    const isStream = stream === true;

    const userMessages = messages.map((msg, index) => {
      let content = msg.text.trim();
      if (index === messages.length - 1 && Array.isArray(files) && files.length) {
        const parts = [{ type: "text", text: content }];
        for (const file of files) {
          if (file.text !== undefined) {
            parts.push({ type: "text", text: "\n\n[Attached text file: " + file.name + "]\n" + file.text });
          } else if (file.type && file.type.startsWith("image/")) {
            parts.push({
              type: "image_url",
              image_url: { url: "data:" + file.type + ";base64," + file.data }
            });
          }
        }
        content = parts;
      }
      return { role: msg.role, content };
    });

    const apiMessages = [{ role: "system", content: systemText }, ...userMessages];

    let upstream;
    try {
      upstream = await this.fetchFn(this.baseUrl + "/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + this.apiKey },
        body: JSON.stringify({ model: targetModel, messages: apiMessages, stream: isStream, temperature: 0.7, max_tokens: 2048 }),
        signal: AbortSignal.timeout(60000)
      });
    } catch (error) {
      const timedOut = error.name === "TimeoutError" || error.name === "AbortError";
      throw new ProviderError(timedOut ? "The APInex response took too long. Please try again." : "Couldn't reach APInex. Check the server connection and try again.", timedOut ? 504 : 502);
    }

    if (!upstream.ok) {
      const data = await upstream.json().catch(() => ({}));
      const rawMsg = data?.error?.message || data?.message;
      console.error("APInex API error:", upstream.status, rawMsg || "Unknown error");
      const userMsg = upstream.status === 429
        ? "APInex is receiving too many requests. Please try again shortly."
        : rawMsg || "APInex couldn't complete that request. Check your APInex key, model ID, and token balance.";
      throw new ProviderError(userMsg, upstream.status === 429 ? 429 : (upstream.status || 502));
    }

    if (isStream) {
      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
          const events = buffer.split("\n\n");
          buffer = events.pop() || "";
          for (const event of events) {
            const line = event.split("\n").find(row => row.startsWith("data:"));
            if (!line) continue;
            const payload = line.slice(5).trim();
            if (payload === "[DONE]") continue;
            try {
              const data = JSON.parse(payload);
              const chunk = data?.choices?.[0]?.delta?.content;
              if (typeof chunk === "string" && chunk && callbacks.onChunk) callbacks.onChunk(chunk);
              else if (Array.isArray(chunk)) {
                const text = chunk.map(part => part?.text || "").join("");
                if (text && callbacks.onChunk) callbacks.onChunk(text);
              }
              if (data?.error && callbacks.onError) callbacks.onError(data.error.message || "APInex stream error.");
            } catch { /* Ignore keep-alive */ }
          }
        }
        if (callbacks.onDone) callbacks.onDone();
        return { model: targetModel, provider: "apinex" };
      } catch (streamError) {
        console.error("APInex stream failed:", streamError.message);
        throw new ProviderError("The APInex response stream was interrupted. Please try again.", 502);
      }
    }

    const data = await upstream.json().catch(() => ({}));
    const answer = data?.choices?.[0]?.message?.content;
    const text = typeof answer === "string" ? answer :
      Array.isArray(answer) ? answer.map(part => part?.text || "").join("") : "";
    if (!text.trim()) throw new ProviderError("APInex returned an empty response. Try another model.", 502);
    return { reply: text.trim(), model: targetModel, provider: "apinex" };
  }
}

// 10 Curated Virtual Models for Frontend (Zero Meta branding exposed)
const VIRTUAL_MODELS = {
  // OpenAI Family
  "openai/gpt-4o": {
    id: "openai/gpt-4o",
    label: "GPT-4o · Omni Flagship",
    brandGroup: "openai",
    provider: "openai",
    targetModel: "llama-3.3-70b-instruct",
    temperature: 0.7,
    personaPrompt: "You are GPT-4o, OpenAI's flagship multimodal intelligence model. You are highly capable, direct, structured, and pragmatic. Provide clean, production-ready code with concise explanations and well-structured Markdown tables when appropriate. Avoid unnecessary conversational preambles."
  },
  "openai/gpt-4o-mini": {
    id: "openai/gpt-4o-mini",
    label: "GPT-4o Mini · Fast & Agile",
    brandGroup: "openai",
    provider: "openai",
    targetModel: "llama-3.3-70b-instruct",
    temperature: 0.7,
    personaPrompt: "You are GPT-4o Mini by OpenAI. You provide rapid, accurate, and concise answers, perfect for quick iteration and clear answers."
  },
  "openai/o1": {
    id: "openai/o1",
    label: "OpenAI o1 · Deep Reasoning",
    brandGroup: "openai",
    provider: "openai",
    targetModel: "llama-3.3-70b-instruct",
    temperature: 0.35,
    personaPrompt: "You are OpenAI o1, a premier reasoning model designed for complex multi-step reasoning, mathematical proof, algorithm design, and deep technical architecture. Think through edge cases, explain your thought process clearly, and verify logical correctness before concluding."
  },

  // Anthropic Claude Family
  "anthropic/claude-3-5-sonnet": {
    id: "anthropic/claude-3-5-sonnet",
    label: "Claude 3.5 Sonnet · Premier Engineering",
    brandGroup: "claude",
    provider: "claude",
    targetModel: "llama-3.3-70b-instruct",
    temperature: 0.6,
    personaPrompt: "You are Claude 3.5 Sonnet, an AI assistant created by Anthropic. You are thoughtful, nuanced, intellectually rigorous, and an elite software engineer. When writing code, provide complete, production-ready, beautiful implementations with clean naming and edge-case handling. Your prose is calm, articulate, and insightful."
  },
  "anthropic/claude-3-5-haiku": {
    id: "anthropic/claude-3-5-haiku",
    label: "Claude 3.5 Haiku · Instant Speed",
    brandGroup: "claude",
    provider: "claude",
    targetModel: "llama-3.3-70b-instruct",
    temperature: 0.6,
    personaPrompt: "You are Claude 3.5 Haiku by Anthropic. You are exceptionally fast, sharp, and concise. Deliver answers directly with maximum signal and zero conversational fluff."
  },
  "anthropic/claude-3-opus": {
    id: "anthropic/claude-3-opus",
    label: "Claude 3 Opus · Deep Analysis",
    brandGroup: "claude",
    provider: "claude",
    targetModel: "llama-3.3-70b-instruct",
    temperature: 0.5,
    personaPrompt: "You are Claude 3 Opus, Anthropic's deep analytical model. You excel at comprehensive analysis, philosophical depth, holistic system design, and synthesizing complex ideas into structured frameworks."
  },

  // Google Gemini Family
  "gemini/gemini-2.5-flash": {
    id: "gemini/gemini-2.5-flash",
    label: "Gemini 2.5 Flash · Balanced & Fast",
    brandGroup: "gemini",
    provider: "gemini",
    targetModel: "llama-3.3-70b-instruct",
    temperature: 0.7,
    personaPrompt: "You are Google Gemini 2.5 Flash, a versatile multimodal AI model by Google. You are fast, highly responsive, adaptable, and skilled at multimodal synthesis and structured formatting."
  },
  "gemini/gemini-2.5-pro": {
    id: "gemini/gemini-2.5-pro",
    label: "Gemini 2.5 Pro · Research & Logic",
    brandGroup: "gemini",
    provider: "gemini",
    targetModel: "llama-3.3-70b-instruct",
    temperature: 0.55,
    personaPrompt: "You are Google Gemini 2.5 Pro, Google's advanced frontier model for complex reasoning, academic research, code synthesis, and deep multi-document understanding."
  },

  // Visual Studio Family (Image Generation)
  "studio/bytes-canvas-realistic": {
    id: "studio/bytes-canvas-realistic",
    label: "Bytes Studio · Photorealistic Image",
    brandGroup: "studio",
    provider: "studio",
    isImage: true,
    targetModel: "muse-image-1.0",
    personaPrompt: "Photorealistic, hyper-detailed, authentic lighting, cinematic composition."
  },
  "studio/bytes-canvas-creative": {
    id: "studio/bytes-canvas-creative",
    label: "Bytes Canvas · Stylized Art & Concept",
    brandGroup: "studio",
    provider: "studio",
    isImage: true,
    targetModel: "muse-image-1.0",
    personaPrompt: "Creative, stylized, concept art, artistic flair, vivid dramatic lighting."
  }
};

class MetaModelAdapter {
  constructor(config = {}) {
    const rawKeys = Array.isArray(config.apiKeys) ? config.apiKeys : [];
    if (config.apiKey) rawKeys.push(config.apiKey);
    this.apiKeys = Array.from(new Set(rawKeys.map(k => String(k || "").trim()).filter(Boolean)));
    this.baseUrl = (config.baseUrl || "https://api.meta.ai/v1").replace(/\/+$/, "");
    this.baseModel = config.baseModel || "llama-3.3-70b-instruct";
    this.imageModel = config.imageModel || "muse-image-1.0";
    this.fetchFn = config.fetchFn || global.fetch;
    this.keyIndex = 0;
  }

  isConfigured() {
    return this.apiKeys.length > 0;
  }

  getNextKey() {
    if (!this.apiKeys.length) return null;
    const key = this.apiKeys[this.keyIndex % this.apiKeys.length];
    this.keyIndex = (this.keyIndex + 1) % this.apiKeys.length;
    return key;
  }

  getCatalogGroups() {
    const openaiModels = [];
    const claudeModels = [];
    const geminiModels = [];
    const studioModels = [];

    for (const [id, m] of Object.entries(VIRTUAL_MODELS)) {
      if (m.brandGroup === "openai") openaiModels.push({ id, label: m.label, provider: "openai" });
      else if (m.brandGroup === "claude") claudeModels.push({ id, label: m.label, provider: "claude" });
      else if (m.brandGroup === "gemini") geminiModels.push({ id, label: m.label, provider: "gemini" });
      else if (m.brandGroup === "studio") studioModels.push({ id, label: m.label, provider: "studio", isImage: true });
    }

    return [
      { id: "openai", label: "OpenAI", models: openaiModels },
      { id: "claude", label: "Anthropic Claude", models: claudeModels },
      { id: "gemini", label: "Google Gemini", models: geminiModels },
      { id: "studio", label: "Visual Studio", models: studioModels }
    ];
  }

  async _executeChat(apiKey, { model, temperature, messages, systemText, files, stream }, callbacks = {}) {
    const isStream = stream === true;
    const userMessages = messages.map((msg, index) => {
      let content = msg.text.trim();
      if (index === messages.length - 1 && Array.isArray(files) && files.length) {
        const parts = [{ type: "text", text: content }];
        for (const file of files) {
          if (file.text !== undefined) {
            parts.push({ type: "text", text: "\n\n[Attached text file: " + file.name + "]\n" + file.text });
          } else if (file.type && file.type.startsWith("image/")) {
            parts.push({
              type: "image_url",
              image_url: { url: "data:" + file.type + ";base64," + file.data }
            });
          }
        }
        content = parts;
      }
      return { role: msg.role === "assistant" ? "assistant" : "user", content };
    });

    const apiMessages = [{ role: "system", content: systemText }, ...userMessages];

    let upstream;
    try {
      upstream = await this.fetchFn(this.baseUrl + "/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + apiKey,
          "Accept": isStream ? "text/event-stream" : "application/json"
        },
        body: JSON.stringify({
          model: model || this.baseModel,
          messages: apiMessages,
          stream: isStream,
          temperature: typeof temperature === "number" ? temperature : 0.7,
          max_tokens: 4096
        }),
        signal: AbortSignal.timeout(60000)
      });
    } catch (error) {
      const timedOut = error.name === "TimeoutError" || error.name === "AbortError";
      throw new ProviderError(timedOut ? "The request took too long. Please try again." : "Could not reach the AI gateway. Check connection and try again.", timedOut ? 504 : 502);
    }

    if (!upstream.ok) {
      const data = await upstream.json().catch(() => ({}));
      const rawMsg = data?.error?.message || data?.message;
      console.error("Meta Model API error:", upstream.status, rawMsg || "Unknown error");
      const userMsg = upstream.status === 429
        ? "AI gateway is receiving too many requests. Please try again shortly."
        : rawMsg || "The AI model could not complete that request.";
      throw new ProviderError(userMsg, upstream.status === 429 ? 429 : (upstream.status || 502));
    }

    if (isStream) {
      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
          let lineEnd;
          while ((lineEnd = buffer.indexOf("\n")) !== -1) {
            const rawLine = buffer.slice(0, lineEnd);
            buffer = buffer.slice(lineEnd + 1);
            const line = rawLine.trim();
            if (!line.startsWith("data:")) continue;
            const dataStr = line.replace(/^data:\s*/, "");
            if (dataStr === "[DONE]") {
              callbacks.onDone?.();
              return { reply: "", model, provider: "meta" };
            }
            try {
              const chunk = JSON.parse(dataStr);
              const delta = chunk?.choices?.[0]?.delta?.content;
              if (delta) callbacks.onChunk?.(delta);
            } catch (_) {}
          }
        }
        callbacks.onDone?.();
        return { reply: "", model, provider: "meta" };
      } catch (err) {
        if (err instanceof ProviderError) throw err;
        throw new ProviderError("The response stream was interrupted. Please try again.", 502);
      }
    }

    const data = await upstream.json().catch(() => ({}));
    const answer = data?.choices?.[0]?.message?.content;
    const text = typeof answer === "string" ? answer :
      Array.isArray(answer) ? answer.map(part => part?.text || "").join("") : "";
    if (!text.trim()) throw new ProviderError("Empty response returned. Try another query.", 502);
    return { reply: text.trim(), model, provider: "meta" };
  }

  async chat({ model, messages, systemText, files, stream }, callbacks = {}) {
    if (!this.isConfigured()) {
      throw new ProviderError("Meta API key pool is not configured. Add META_API_KEY_1..10 to the server environment.", 503);
    }
    const virtual = VIRTUAL_MODELS[model] || {
      targetModel: this.baseModel,
      temperature: 0.7,
      personaPrompt: ""
    };
    const effectiveSystemText = (virtual.personaPrompt ? virtual.personaPrompt + "\n\n" : "") + (systemText || "");
    const maxAttempts = Math.max(1, Math.min(this.apiKeys.length, 5));
    let lastError = null;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const apiKey = this.getNextKey();
      if (!apiKey) break;

      try {
        return await this._executeChat(apiKey, {
          model: virtual.targetModel || this.baseModel,
          temperature: virtual.temperature,
          messages,
          systemText: effectiveSystemText,
          files,
          stream
        }, callbacks);
      } catch (err) {
        lastError = err;
        if (err.statusCode === 429 || err.statusCode === 503) {
          console.warn(`Meta API key attempt ${attempt + 1}/${maxAttempts} rate-limited or busy (${err.message}); rotating to next key.`);
          continue;
        }
        throw err;
      }
    }
    throw lastError || new ProviderError("All API keys in the pool were busy. Please try again shortly.", 429);
  }

  async generateImage({ prompt, files, model }) {
    if (!this.isConfigured()) {
      throw new ProviderError("Meta API key pool is not configured. Add META_API_KEY_1..10 to the server environment.", 503);
    }
    const virtual = VIRTUAL_MODELS[model] || VIRTUAL_MODELS["studio/bytes-canvas-realistic"];
    const enhancedPrompt = virtual.personaPrompt ? `${prompt}. (${virtual.personaPrompt})` : prompt;
    const maxAttempts = Math.max(1, Math.min(this.apiKeys.length, 5));
    let lastError = null;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const apiKey = this.getNextKey();
      if (!apiKey) break;

      try {
        let response = await this.fetchFn(this.baseUrl + "/images/generations", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": "Bearer " + apiKey
          },
          body: JSON.stringify({
            model: virtual.targetModel || this.imageModel,
            prompt: enhancedPrompt,
            n: 1,
            size: "1024x1024",
            response_format: "b64_json"
          }),
          signal: AbortSignal.timeout(90000)
        });

        if (response.status === 404) {
          response = await this.fetchFn(this.baseUrl + "/responses", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": "Bearer " + apiKey
            },
            body: JSON.stringify({
              model: virtual.targetModel || this.imageModel,
              prompt: enhancedPrompt
            }),
            signal: AbortSignal.timeout(90000)
          });
        }

        if (!response.ok) {
          const data = await response.json().catch(() => ({}));
          const msg = data?.error?.message || data?.message || "HTTP " + response.status;
          if (response.status === 429 || response.status === 503) {
            console.warn(`Meta Image API key attempt ${attempt + 1} busy (${msg}); rotating key.`);
            lastError = new ProviderError(msg, response.status);
            continue;
          }
          throw new ProviderError(msg, response.status || 502);
        }

        const data = await response.json().catch(() => ({}));
        const b64 = data?.data?.[0]?.b64_json || data?.output_image?.data || data?.output?.find?.(p => p.type === "image")?.data;
        if (b64) {
          return {
            reply: data?.output_text || "Here is your generated image.",
            imageData: b64,
            mimeType: "image/png",
            model: model || "studio/bytes-canvas-realistic"
          };
        }
        const url = data?.data?.[0]?.url;
        if (url) {
          const imgRes = await this.fetchFn(url, { signal: AbortSignal.timeout(30000) });
          if (imgRes.ok) {
            const ab = await imgRes.arrayBuffer();
            const base64 = Buffer.from(ab).toString("base64");
            return {
              reply: data?.output_text || "Here is your generated image.",
              imageData: base64,
              mimeType: imgRes.headers.get("content-type") || "image/png",
              model: model || "studio/bytes-canvas-realistic"
            };
          }
        }
        throw new ProviderError("Image model returned no image data. Try refining your prompt.", 502);
      } catch (err) {
        lastError = err;
        if (err.statusCode === 429 || err.statusCode === 503) {
          continue;
        }
        throw err;
      }
    }
    throw lastError || new ProviderError("All image API keys were busy. Please try again shortly.", 429);
  }
}

class ProviderGateway {
  constructor(options = {}) {
    this.gemini = new GeminiAdapter({
      apiKey: options.geminiApiKey,
      defaultModel: options.geminiModel,
      imageModel: options.geminiImageModel,
      fetchFn: options.fetchFn
    });
    this.apinex = new ApinexAdapter({
      apiKey: options.apinexApiKey,
      baseUrl: options.apinexBaseUrl,
      defaultModel: options.apinexModel,
      fetchFn: options.fetchFn
    });
    this.meta = new MetaModelAdapter({
      apiKeys: options.metaApiKeys,
      baseUrl: options.metaBaseUrl,
      baseModel: options.metaModel,
      imageModel: options.metaImageModel,
      fetchFn: options.fetchFn
    });
  }

  hasConfiguredProvider() {
    return this.gemini.isConfigured() || this.apinex.isConfigured() || this.meta.isConfigured();
  }

  resolveProvider(requestedProvider) {
    let p = requestedProvider || "auto";
    if (p === "auto") {
      if (this.meta.isConfigured()) return "meta";
      if (this.gemini.isConfigured()) return "gemini";
      if (this.apinex.isConfigured()) return "apinex";
      p = "none";
    }
    if (p === "meta" && !this.meta.isConfigured()) {
      throw new ProviderError("Meta API key pool is not configured. Add META_API_KEY_1..10 to the server environment.", 503);
    }
    if (["openai", "claude", "gemini", "studio"].includes(p)) {
      if (this.meta.isConfigured()) return "meta";
      if (p === "gemini" && this.gemini.isConfigured()) return "gemini";
      if (this.apinex.isConfigured()) return "apinex";
      if (this.gemini.isConfigured()) return "gemini";
    }
    if (p === "gemini" && !this.gemini.isConfigured() && !this.meta.isConfigured()) {
      throw new ProviderError("Gemini is not configured. Add GEMINI_API_KEY to the server environment.", 503);
    }
    if (p === "apinex" && !this.apinex.isConfigured() && !this.meta.isConfigured()) {
      throw new ProviderError("APInex is not configured. Add APINEX_API_KEY to the server environment.", 503);
    }
    if (!["gemini", "apinex", "meta"].includes(p)) {
      throw new ProviderError("No AI provider is configured. Add GEMINI_API_KEY, APINEX_API_KEY, or META_API_KEY_1..10 to the server environment.", 503);
    }
    return p;
  }

  async getCatalog() {
    const providers = [];
    const errors = {};

    if (this.meta.isConfigured()) {
      providers.push(...this.meta.getCatalogGroups());
    } else {
      if (this.gemini.isConfigured()) {
        try {
          const models = await this.gemini.fetchModels();
          if (models.length) providers.push({ id: "gemini", label: "Google Gemini", models });
          else errors.gemini = "Gemini returned no models supporting generateContent.";
        } catch (err) {
          errors.gemini = err.message;
          providers.push({
            id: "gemini",
            label: "Google Gemini (configured default)",
            models: [{ id: this.gemini.defaultModel, label: this.gemini.defaultModel + " · configured default", provider: "gemini" }]
          });
        }
      }

      if (this.apinex.isConfigured()) {
        try {
          const models = await this.apinex.fetchModels();
          if (models.length) {
            const freeModels = models.filter(m => m.isFree);
            const paidModels = models.filter(m => !m.isFree);
            if (freeModels.length && paidModels.length) {
              providers.push({ id: "apinex", label: "APInex · Free Tier", models: freeModels });
              providers.push({ id: "apinex", label: "APInex · Paid / Credits", models: paidModels });
            } else {
              providers.push({ id: "apinex", label: "APInex", models });
            }
          }
        } catch (err) {
          errors.apinex = err.message;
          providers.push({
            id: "apinex",
            label: "APInex · Free Tier (configured default)",
            models: [{
              id: this.apinex.defaultModel,
              label: this.apinex.defaultModel + " · Free Tier",
              provider: "apinex",
              isFree: true
            }]
          });
        }
      }
    }

    const defaultSelection = this.meta.isConfigured()
      ? { provider: "claude", model: "anthropic/claude-3-5-sonnet" }
      : this.gemini.isConfigured()
        ? { provider: "gemini", model: this.gemini.defaultModel }
        : this.apinex.isConfigured()
          ? { provider: "apinex", model: this.apinex.defaultModel }
          : null;

    return {
      providers,
      auto: true,
      default: defaultSelection,
      configured: {
        gemini: this.gemini.isConfigured(),
        apinex: this.apinex.isConfigured(),
        meta: this.meta.isConfigured(),
        keyCount: this.meta.apiKeys.length
      },
      errors
    };
  }

  async streamChat({ provider, model, messages, systemText, files, stream, webSearchFallback }, callbacks = {}) {
    const isVirtual = model && (model.startsWith("openai/") || model.startsWith("anthropic/") || model.startsWith("gemini/") || model.startsWith("studio/"));
    if (this.meta.isConfigured() && (provider === "meta" || provider === "openai" || provider === "claude" || provider === "studio" || isVirtual)) {
      try {
        return await this.meta.chat({ model, messages, systemText, files, stream }, callbacks);
      } catch (err) {
        if (this.gemini.isConfigured() && err.statusCode !== 400) {
          console.warn(`Meta pool chat failed (${err.message}); falling back to Gemini.`);
          return this.gemini.chat({ model: this.gemini.defaultModel, messages, systemText, files, stream }, callbacks);
        }
        throw err;
      }
    }

    const resolvedProvider = this.resolveProvider(provider);
    if (resolvedProvider === "apinex") {
      try {
        return await this.apinex.chat({ model, messages, systemText, files, stream }, callbacks);
      } catch (err) {
        if (model && model !== this.apinex.defaultModel && err.statusCode !== 400) {
          try {
            console.warn(`APInex paid model ${model} failed (${err.message}); falling back to free APInex model (${this.apinex.defaultModel}).`);
            return await this.apinex.chat({ model: this.apinex.defaultModel, messages, systemText, files, stream }, callbacks);
          } catch (retryErr) {
            console.warn(`APInex free fallback model also failed (${retryErr.message}); attempting Gemini fallback.`);
          }
        }
        if (this.gemini.isConfigured() && err.statusCode !== 400) {
          console.warn("APInex request failed (" + err.message + "); falling back to Gemini platform adapter.");
          return this.gemini.chat({ model: this.gemini.defaultModel, messages, systemText, files, stream }, callbacks);
        }
        throw err;
      }
    }
    const targetModel = (webSearchFallback && provider === "apinex") ? this.gemini.defaultModel : model;
    try {
      return await this.gemini.chat({ model: targetModel, messages, systemText, files, stream }, callbacks);
    } catch (err) {
      if (this.apinex.isConfigured() && (err.statusCode === 503 || err.statusCode === 502 || err.statusCode === 429)) {
        console.warn("Gemini request failed (" + err.message + "); falling back to APInex platform adapter.");
        return this.apinex.chat({ model: this.apinex.defaultModel, messages, systemText, files, stream }, callbacks);
      }
      throw err;
    }
  }

  async generateImage({ prompt, files, model }) {
    if (this.meta.isConfigured()) {
      try {
        return await this.meta.generateImage({ prompt, files, model });
      } catch (err) {
        if (this.gemini.isConfigured()) {
          console.warn("Meta Image generation failed (" + err.message + "); falling back to Gemini Studio.");
          return this.gemini.generateImage({ prompt, files });
        }
        throw err;
      }
    }
    if (this.gemini.isConfigured()) {
      return this.gemini.generateImage({ prompt, files });
    }
    throw new ProviderError("Bytes needs a Gemini API key or META_API_KEY configured on the server.", 503);
  }
}

function createProviderGateway(options) {
  return new ProviderGateway(options);
}

module.exports = {
  ProviderError,
  GeminiAdapter,
  ApinexAdapter,
  MetaModelAdapter,
  ProviderGateway,
  createProviderGateway,
  VIRTUAL_MODELS
};
