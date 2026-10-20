# Bytes Domain & Architecture Glossary

This glossary defines the ubiquitous language and architectural seams for the Bytes workspace.

## Core Concepts

### ProviderGateway
The central boundary module that mediates all AI interactions in Bytes. It hides provider-specific HTTP transports, payload serializations, streaming SSE dialects, and error formats behind a cohesive interface.

* **Seam**: `streamChat(options, onChunk)`, `generateImage(options)`, `listModels()`
* **Depth**: Deep module. Hides hundreds of lines of Google Gemini REST schemas, OpenAI-compatible APInex conventions, and network streaming protocols.

### ProviderAdapter
A vendor-specific implementation encapsulated behind the ProviderGateway seam.
* `GeminiAdapter`: Translates domain messages into Gemini `contents`/`parts`/`inlineData` objects, parses Google SSE streaming chunks, and handles Gemini Nano Banana image generation.
* `ApinexAdapter`: Translates domain messages into OpenAI-compatible chat completion payloads with `image_url` data URIs, and handles standard SSE chunk decoding.

### ModelDescriptor
A normalized description of an AI model available for routing.
* Fields: `{ id: string, label: string, provider: 'gemini' | 'apinex' }`

### SearchProviderRunner
The resilient circuit-breaker and latency-tracking wrapper that isolates search engines (FreeSerp, SearXNG, FreeNewsAPI, Google News RSS) from cascading failures.

### FileIntakeValidator
An isolated input validation module that inspects, sanitizes, and bounds multimodal attachments (images, PDFs, text, markdown, CSV, JSON).
* **Seam**: `validate(raw, options)`
* **Depth**: Enforces file-count caps, base64 data encoding integrity, individual and aggregate memory/character budgets, and media-type restrictions for chat vs. image generation.

### MemoryNote
User-controlled persistent context stored client-side in local storage (or synchronized profile) and injected as prompt guidance across conversations.
