# Bytes

A calm, responsive AI workspace with a warm editorial interface, powered by Google's Gemini API.

## Features

- Responsive chat UI for desktop and mobile browsers
- Conversation history for the current browser session
- Suggested prompts for planning, writing, learning, and brainstorming
- Node.js/Express backend that keeps the Gemini API key on the server
- Basic security headers, JSON request limits, and API rate limiting

## Requirements

- Node.js 20+
- A Gemini API key from [Google AI Studio](https://aistudio.google.com/app/apikey)

## Run locally

1. Clone this repository and enter the project folder.
2. Install dependencies:

   ```bash
   npm install
   ```

3. Copy `.env.example` to `.env` and put your key in `GEMINI_API_KEY`:

   ```env
   GEMINI_API_KEY=your_key_here
   GEMINI_MODEL=gemini-3.8-flash
   PORT=3000
   ```

4. Start Bytes:

   ```bash
   npm start
   ```

5. Open http://localhost:3000.

**Never commit your real `.env` file or expose your Gemini API key in browser JavaScript.** The `.gitignore` file excludes it.

## Deploy

Deploy this repository as a **Node.js web service**, not as a static-only site. For example, create a web service on [Render](https://render.com/), connect this GitHub repository, set the build command to `npm install`, and the start command to `npm start`. Add `GEMINI_API_KEY` as a private environment variable in the host dashboard. You can optionally set `GEMINI_MODEL` and `NODE_VERSION` as environment variables.

After deployment, open the service URL and test a chat message. The health endpoint is `/api/health`; it reports whether the server has a key configured, but never returns the key itself.

## API

- `GET /api/health` — basic server/provider configuration status
- `POST /api/chat` — accepts `{ "messages": [{ "role": "user" | "assistant", "text": "..." }] }` and returns `{ "reply": "...", "model": "..." }`

## Current limitations

- Conversation history is held in memory in the browser and is not synced between devices.
- Login, persistent cloud history, file uploads, image generation, and native Android packaging are not implemented yet.
- Gemini usage, quotas, and charges are subject to your Google AI Studio / Google Cloud account settings.
