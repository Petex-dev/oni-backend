# Oni Backend

Node.js/Express backend for the Oni AI Mastering studio. Proxies requests to Anthropic (chat) and OpenAI (TTS, transcription) so API keys are never exposed to the frontend, handles Stripe checkout/payments, and manages user credits via Supabase.

## What it does

- Proxies chat requests to Claude (Anthropic API)
- Proxies text-to-speech requests to OpenAI TTS
- Proxies audio transcription requests to OpenAI Whisper
- Creates Stripe Checkout sessions for subscriptions and one-time credit re-ups
- Handles Stripe webhooks to update user plan/credits in Supabase after successful payment

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | Health check — returns `{ status: "ok", message: "Oni backend is alive" }` |
| POST | `/api/chat` | Send a message (or message history) to Claude. Body: `{ message }` or `{ messages, system?, model?, max_tokens? }`. Returns the Anthropic response object. Rate-limited. |
| POST | `/api/tts` | Convert text to speech via OpenAI TTS. Body: `{ text, voice? }` (voice defaults to `echo`). Returns audio/mpeg. Rate-limited. |
| POST | `/api/transcribe` | Transcribe an uploaded audio file via OpenAI Whisper. Multipart form, field `file`. Returns Whisper's JSON response. Rate-limited. |
| POST | `/api/create-checkout-session` | Create a Stripe Checkout session. Body: `{ priceId, userId, userEmail }`. `priceId` must be one of the configured plan/re-up price IDs. Returns `{ url }`. Rate-limited. |
| POST | `/api/webhook` | Stripe webhook receiver. On `checkout.session.completed`, updates the user's plan/credits (subscriptions) or increments credits (re-up) in Supabase. |
| POST | `/api/support-chat` | FAQ-only customer support chat, separate from `/api/chat`'s mastering AI Engineer. Requires `Authorization: Bearer <Supabase access token>` — the user is derived server-side via `supabase.auth.getUser()`, never trusted from the request body. Body: `{ messages, lang? }`. Logs each conversation to the `support_chat_logs` table. Rate-limited. |

Rate limit: 200 requests per 15 minutes per IP, applied to `/api/chat`, `/api/tts`, `/api/transcribe`, `/api/create-checkout-session`, and `/api/support-chat`.

## Local Setup

**1. Install dependencies**
```bash
npm install
```

**2. Configure environment variables**

Copy `.env.example` to `.env` and fill in the values:

```bash
cp .env.example .env
```

Required variables:

| Variable | Purpose |
|----------|---------|
| `ANTHROPIC_API_KEY` | Claude API access for `/api/chat` |
| `OPENAI_API_KEY` | OpenAI API access for `/api/tts` and `/api/transcribe` |
| `STRIPE_SECRET_KEY` | Stripe API access for checkout sessions |
| `STRIPE_WEBHOOK_SECRET` | Verifies incoming Stripe webhook signatures |
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key (used to update user credits/plan) |

`PORT` is also in `.env.example` but optional — defaults to `3000` if unset.

**3. Start the server**
```bash
npm start
```

Server runs on `http://localhost:3000` by default.

## Deployment

Deployed on Railway, connected to this GitHub repo for auto-deploy on push to `main`. Environment variables are set in Railway's dashboard under **Variables**. Railway automatically provides `process.env.PORT`, so no port config is needed there.

## Stack

- Node.js + Express
- Anthropic SDK (Claude)
- OpenAI TTS + Whisper (via `fetch`, no SDK)
- Stripe SDK
- Supabase JS client
- dotenv for local environment variables
