# Deploy the Bytes backend to Cloudflare Workers

This is an isolated migration branch. It keeps the existing Express API and the
Netlify frontend/Supabase database architecture intact. Do not merge this branch
into `main` until the Worker is deployed and its API endpoints are verified.

## 1. Deploy

From the repository root:

```sh
npm install
npx wrangler login
npx wrangler deploy
```

The Worker will be published at a `workers.dev` address shown by Wrangler.
Use that address as the backend API base URL in the Netlify frontend configuration.

## 2. Add secrets

Use Wrangler's interactive secret prompt for each secret (never commit values):

```sh
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put APINEX_API_KEY
npx wrangler secret put SUPABASE_URL
npx wrangler secret put SUPABASE_ANON_KEY
```

Add any other keys used by your existing deployment, including `META_API_KEY_1`
through `META_API_KEY_10` if applicable. Add non-sensitive configuration as
Worker variables in Cloudflare Settings > Variables and Secrets:

- `GEMINI_MODEL`
- `GEMINI_IMAGE_MODEL`
- `APINEX_BASE_URL`
- `APINEX_MODEL`
- `META_BASE_URL`
- `META_MODEL`
- `FRONTEND_URL` (the exact Netlify site origin)
- `ALLOWED_ORIGINS` (comma-separated origins, if needed)
- `REQUIRE_AUTH` (`true` only if Supabase authentication is configured)

Treat all API keys and tokens as secrets. Do not put secrets in `wrangler.toml`,
GitHub, Netlify frontend variables, or client-side code.

## 3. Verify before switching the frontend

1. Open `https://<your-worker>.workers.dev/api/health`.
2. Confirm the health response is successful.
3. Test model listing, a non-streaming chat request, streaming chat, web search,
   image generation, CORS from the Netlify origin, and Supabase auth if enabled.
4. Only after those pass, update the frontend's API base URL in Netlify and test
   the deployed site.

## Compatibility notes

The Worker uses Cloudflare's Node.js HTTP server integration to preserve the
current Express routes. Cloudflare's Node compatibility is not identical to a
full Node.js server, so this is a migration candidate—not a claim that production
behavior has already been verified. In particular, test SSE streaming, rate
limiting, provider SDK/API calls, and any code that relies on process-level state.
Cloudflare Workers' free plan currently has a 10 ms CPU time limit per request;
network wait time does not count toward CPU time. Check current platform limits
before production use.
