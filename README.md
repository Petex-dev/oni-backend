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

## Known issues / backlog

- **FIXED 2026-09-23 — Re-up credits now survive renewal resets.** Re-up grants
  go to a separate `profiles.bonus_credits` column (via the service-role-only
  `increment_bonus_credits` RPC) that the `invoice.paid` renewal reset never
  touches. `deduct_credits` spends subscription credits first, then bonus;
  `get_my_credits` returns the combined total as `credits` (plus the split).
  Schema/function changes: `migrations/2026-09-23_migration1_bonus_credits.sql`
  (also locked `increment_credits` to service_role — it was callable by
  anon/authenticated — and made `deduct_credits` reject amounts <= 0).
  Verified with `scripts/18-bonus-credits-verify.js`.
  **Still to do:** Migration 2 (drop the now-unused `increment_credits`).

- **FIXED 2026-09-26 — credit prices set server-side.** `deduct_credits`
  used to take a browser-chosen `p_amount` (a user could pay 1 credit for a
  5-credit master). New overload `deduct_credits(p_operation, p_quantity)` looks
  the price up in `credit_prices` and logs every charge to `credit_ledger`
  (user, operation, quantity, cost, and which pool paid — for future refunds).
  `migrations/2026-09-26_migration3_server_side_pricing.sql` adds it alongside the
  old version; `..._migration4_drop_client_priced_deduct.sql` drops the old
  `p_amount` version. All three migrations have been run; only
  `deduct_credits(p_operation, p_quantity)` remains. Verified with
  `scripts/20-server-side-pricing-verify.js` and
  `scripts/21-pricing-frontend-e2e.js`. Frontend: oni-frontend `b287917`
  (also caps batch export at 50 files to match the RPC's quantity cap).

- **Known architectural limit — payment is enforced in the browser, not the
  server.** Mastering, voice cleanup, stems and export all run client-side. The
  "already paid" flags (`_masterCreditsCharged` etc. in `index.html`) are plain
  globals, so a technical user can set one from the console, or call the
  unwrapped export functions, and export without `deduct_credits` ever running.
  Batch `p_quantity` is also the browser's word. Server-side pricing stops
  underpaying, not skipping payment. Real enforcement needs the server in the
  output path: server-side rendering, or a server-issued signed unlock token
  that the download requires. Accepted as a small risk at launch scale
  (2026-09-26); revisit when scale or observed abuse justifies it.
