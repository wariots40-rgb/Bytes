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
    this.defaultModel = config.defaultModel || "gemini-3.8-flash";
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
    return (Array.isArray(data.models) ? data.models : [])
      .filter(model => Array.isArray(model.supportedGenerationMethods) &&
        model.supportedGenerationMethods.includes("generateContent") &&
        typeof model.name === "string")
      .map(model => {
        const id = model.name.replace(/^models\//, "");
        return { id, label: model.displayName || id, provider: "gemini" };
      })
      .filter(model => /^[a-zA-Z0-9._-]{1,180}$/.test(model.id))
      .sort((a, b) => {
        const score = m => /flash/i.test(m.id) ? 0 : /pro/i.test(m.id) ? 1 : 2;
        return score(a) - score(b) || a.label.localeCompare(b.label);
      })
      .slice(0, 100);
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
        signal: AbortSignal.timeout(60000)
      });
    } catch (error) {
      const timedOut = error.name === "TimeoutError" || error.name === "AbortError";
      throw new ProviderError(timedOut ? "The response took too long. Please try again." : "Couldn't reach Gemini. Check the server connection and try again.", timedOut ? 504 : 502);
    }

    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      console.error("Gemini API error:", response.status, data?.error?.message || "Unknown error");
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
    const models = (Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : [])
      .map(model => typeof model === "string" ? { id: model } : model)
      .filter(model => typeof model.id === "string" && model.id.length > 0 && model.id.length < 180)
      .map(model => ({ id: model.id, label: model.name || model.id, provider: "apinex" }))
      .filter((model, index, all) => all.findIndex(other => other.id === model.id) === index)
      .slice(0, 150);

    if (!models.some(m => m.id === this.defaultModel)) {
      models.unshift({ id: this.defaultModel, label: this.defaultModel, provider: "apinex" });
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
      console.error("APInex API error:", upstream.status, data?.error?.message || data?.message || "Unknown error");
      throw new ProviderError(upstream.status === 429
        ? "APInex is receiving too many requests. Please try again shortly."
        : "APInex couldn't complete that request. Check your APInex key, model ID, and token balance.",
        upstream.status === 429 ? 429 : 502);
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
  }

  hasConfiguredProvider() {
    return this.gemini.isConfigured() || this.apinex.isConfigured();
  }

  resolveProvider(requestedProvider) {
    let p = requestedProvider || "auto";
    if (p === "auto") {
      p = this.gemini.isConfigured() ? "gemini" : this.apinex.isConfigured() ? "apinex" : "none";
    }
    if (p === "gemini" && !this.gemini.isConfigured()) {
      throw new ProviderError("Gemini is not configured. Add GEMINI_API_KEY to the server environment.", 503);
    }
    if (p === "apinex" && !this.apinex.isConfigured()) {
      throw new ProviderError("APInex is not configured. Add APINEX_API_KEY to the server environment.", 503);
    }
    if (!["gemini", "apinex"].includes(p)) {
      throw new ProviderError("No AI provider is configured. Add GEMINI_API_KEY or APINEX_API_KEY to the server environment.", 503);
    }
    return p;
  }

  async getCatalog() {
    const providers = [];
    const errors = {};

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
        if (models.length) providers.push({ id: "apinex", label: "APInex", models });
      } catch (err) {
        errors.apinex = err.message;
      }
    }

    return {
      providers,
      auto: true,
      default: this.gemini.isConfigured() ? { provider: "gemini", model: this.gemini.defaultModel } :
        this.apinex.isConfigured() ? { provider: "apinex", model: this.apinex.defaultModel } : null,
      configured: { gemini: this.gemini.isConfigured(), apinex: this.apinex.isConfigured() },
      errors
    };
  }

  async streamChat({ provider, model, messages, systemText, files, stream, webSearchFallback }, callbacks = {}) {
    const resolvedProvider = this.resolveProvider(provider);
    if (resolvedProvider === "apinex") {
      try {
        return await this.apinex.chat({ model, messages, systemText, files, stream }, callbacks);
      } catch (err) {
        if (this.gemini.isConfigured() && err.statusCode !== 400) {
          console.warn("APInex request failed (" + err.message + "); falling back to Gemini platform adapter.");
          return this.gemini.chat({ model: this.gemini.defaultModel, messages, systemText, files, stream }, callbacks);
        }
        throw err;
      }
    }
    const targetModel = (webSearchFallback && provider === "apinex") ? this.gemini.defaultModel : model;
    return this.gemini.chat({ model: targetModel, messages, systemText, files, stream }, callbacks);
  }

  async generateImage({ prompt, files }) {
    if (!this.gemini.isConfigured()) {
      throw new ProviderError("Bytes needs a Gemini API key configured on the server.", 503);
    }
    return this.gemini.generateImage({ prompt, files });
  }
}

function createProviderGateway(options) {
  return new ProviderGateway(options);
}

module.exports = {
  ProviderError,
  GeminiAdapter,
  ApinexAdapter,
  ProviderGateway,
  createProviderGateway
};
