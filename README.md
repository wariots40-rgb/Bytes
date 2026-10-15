# Bytes

A calm, responsive AI workspace with a warm editorial interface, powered by Google's Gemini API.

## Features

- Responsive, streaming chat on desktop and mobile browsers
- Chat history and searchable conversations saved in browser local storage
- User-controlled cross-conversation memory that can be edited or cleared in Workspace settings
- Markdown answers, copy actions, response regeneration, and browser text-to-speech
- Voice input through the browser's Web Speech API where supported
- Image understanding and PDF analysis in chat
- Image generation and image editing through Gemini's Nano Banana image model
- Uploads for PNG, JPG, WebP, HEIC/HEIF, PDF, TXT, Markdown, CSV, and JSON files
- Express backend keeps provider keys server-side, with security headers, request limits, and API rate limiting

## Requirements

- Node.js 20+
- A Gemini API key from [Google AI Studio](https://aistudio.google.com/app/apikey)
- API access/quota for the chat model and image model configured below

## Run locally

1. Clone this repository and enter the project folder.
2. Install dependencies:

   ```bash
   npm install
   ```

3. Copy `.env.example` to `.env` and add your API key:

   ```env
   GEMINI_API_KEY=your_key_here
   GEMINI_MODEL=gemini-3.8-flash
   GEMINI_IMAGE_MODEL=gemini-nano-banana-2.1
   PORT=3000
   ```

4. Start Bytes:

   ```bash
   npm start
   ```

5. Open http://localhost:3000.

**Never commit your real `.env` file or expose your Gemini API key in browser JavaScript.** The `.gitignore` file excludes it.

## How memory and files work

Conversation transcripts and your optional memory note are saved in the current browser's local storage. Memory is editable in Workspace settings and is included as context in later AI requests. Data does not sync between browsers or devices.

Uploaded files are read in the browser and sent to the Bytes server only for the request in which they are attached. Bytes does not save the file bytes in chat history. Generated images can be downloaded; image binary data is not saved to browser history, so older image messages display a note rather than the image again. Keep individual uploads under 4 MB, with a combined inline payload of roughly 6 MB. Up to four files can be attached to one message.

Voice input depends on browser support for the Web Speech API and may require microphone permission. Spoken responses use the browser's speech synthesis support.

## Deploy

Deploy this repository as a **Node.js web service**, not as a static-only site. For example, create a web service on [Render](https://render.com/), connect this GitHub repository, set the build command to `npm install`, and the start command to `npm start`. Add `GEMINI_API_KEY` as a private environment variable in the host dashboard. You can optionally set `GEMINI_MODEL`, `GEMINI_IMAGE_MODEL`, and `NODE_VERSION` as environment variables.

After deployment, open the service URL and test a chat message. The health endpoint is `/api/health`; it reports the configured model names and whether the API key is configured, but never returns the key itself.

## API

- `GET /api/health` — server and model configuration status
- `POST /api/chat` — streaming or non-streaming conversation responses; supports user memory and per-request files
- `POST /api/image` — image generation/editing; returns image bytes as a base64 data URL payload

## Notes

Gemini usage, available models, quotas, and charges are controlled by the Google AI Studio / Google Cloud account. Image generation requires access to the configured image model. Voice features vary by browser.
