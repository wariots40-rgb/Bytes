# Bytes

A calm, responsive AI workspace with a warm editorial interface, supporting Google Gemini and APInex's OpenAI-compatible model gateway.

## Features

- Responsive, streaming chat on desktop and mobile browsers
- Chat history and searchable conversations saved in browser local storage
- User-controlled cross-conversation memory that can be edited or cleared in Workspace settings
- Markdown answers, copy actions, response regeneration, and browser text-to-speech
- Voice input through the browser's Web Speech API where supported
- Image understanding and PDF analysis in chat
- Image generation and image editing through Gemini's Nano Banana image model
- Uploads for PNG, JPG, WebP, HEIC/HEIF, PDF, TXT, Markdown, CSV, and JSON files
- Auto model routing plus a top-bar model selector for Gemini and the live APInex model catalog
- Resilient live search: SearXNG (optional) and FreeSerp run as parallel general-web providers; news queries combine FreeNewsAPI, Google News RSS, optional SearXNG, and FreeSerp in parallel, deduplicate results, and report partial-provider failures. Identical queries are cached briefly to reduce provider load.
- Express backend keeps provider keys server-side, with security headers, request limits, and API rate limiting

## Requirements

- Node.js 20+
- At least one provider key: a Gemini key from [Google AI Studio](https://aistudio.google.com/app/apikey) or an APInex key from [APInex](https://apinex.bond/)
- Gemini API access/quota for image generation and PDF analysis; APInex for OpenAI-compatible chat models

## Run locally

1. Clone this repository and enter the project folder.
2. Install dependencies:

   ```bash
   npm install
   ```

3. Copy `.env.example` to `.env` and add one or both provider keys:

   ```env
   GEMINI_API_KEY=your_gemini_key_here
   GEMINI_MODEL=gemini-3.8-flash
   GEMINI_IMAGE_MODEL=gemini-nano-banana-2.1
   APINEX_API_KEY=your_apinex_key_here
   APINEX_BASE_URL=https://api.apinex.bond/v1
   APINEX_MODEL=free/gemini-3.8-flash
   PORT=3000
   # Optional open-source metasearch: set this to your SearXNG instance URL
   # SEARXNG_URL=http://localhost:8080
   ```

4. Start Bytes:

   ```bash
   npm start
   ```

5. Open http://localhost:3000.

**Never commit your real `.env` file or expose provider keys in browser JavaScript.** The `.gitignore` file excludes it. Auto chooses Gemini when its key is configured; otherwise it uses APInex. You can override this with the top-bar model selector.

## How memory and files work

Conversation transcripts and your optional memory note are saved in the current browser's local storage. Memory is editable in Workspace settings and is included as context in later AI requests. Data does not sync between browsers or devices.

Uploaded files are read in the browser and sent to the Bytes server only for the request in which they are attached. Bytes does not save the file bytes in chat history. Generated images can be downloaded; image binary data is not saved to browser history, so older image messages display a note rather than the image again. Keep individual uploads under 4 MB, with a combined inline payload of roughly 6 MB. Up to four files can be attached to one message.

Voice input depends on browser support for the Web Speech API and may require microphone permission. Spoken responses use the browser's speech synthesis support.

## Deploy

Deploy this repository as a **Node.js web service**, not as a static-only site. For example, create a web service on [Render](https://render.com/), connect this GitHub repository, set the build command to `npm install`, and the start command to `npm start`. Add `GEMINI_API_KEY` and/or `APINEX_API_KEY` as private environment variables in the host dashboard. You can optionally set `GEMINI_MODEL`, `GEMINI_IMAGE_MODEL`, `APINEX_BASE_URL`, `APINEX_MODEL`, and `NODE_VERSION` as environment variables.

After deployment, open the service URL and test a chat message. The health endpoint is `/api/health`; it reports the configured model names and whether the API key is configured, but never returns the key itself.

## API

- `GET /api/health` — server/provider configuration plus configured search routes and cache TTL (no API keys exposed)
- `GET /api/models` — configured providers and APInex model catalog
- `POST /api/chat` — streaming or non-streaming conversation responses; supports user memory, per-request files, and optional `webSearch: true` grounding (news-intent queries use the recent-news index)
- `POST /api/search` — direct search endpoint; general providers run in parallel, news queries aggregate FreeNewsAPI, Google News RSS, optional SearXNG, and FreeSerp. Errors include sanitized provider diagnostics; results are cached for 90 seconds. SearXNG must have JSON output enabled. Time-sensitive chat questions trigger search automatically, even if the Web toggle is off.
- `POST /api/image` — image generation/editing; returns image bytes as a base64 data URL payload

## Notes

Gemini usage, models, quotas, and charges are controlled by Google AI Studio / Google Cloud. APInex usage and billing follow the APInex account. Image generation and PDF analysis currently use Gemini; APInex chat supports text and compatible image inputs. Voice features vary by browser.
