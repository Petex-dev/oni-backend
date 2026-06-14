# Oni Backend

Node.js/Express backend for the Oni AI Mastering studio. Proxies requests to the Anthropic API so API keys are never exposed to the frontend.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | Health check — returns `{ status: "ok" }` |
| POST | `/api/chat` | Send a message to Claude. Body: `{ "message": "..." }`. Returns `{ "reply": "..." }` |

## Local Setup

**1. Install dependencies**
```bash
npm install
```

**2. Create a `.env` file** (never commit this)
```
ANTHROPIC_API_KEY=your-api-key-here
```

**3. Start the server**
```bash
npm start
```

Server runs on `http://localhost:3000` by default.

## Deployment (Railway)

Set the `ANTHROPIC_API_KEY` environment variable in Railway's dashboard under **Variables**. Railway automatically reads `process.env.PORT`, so no port config is needed.

## Stack

- Node.js + Express
- Anthropic SDK (`claude-opus-4-8`)
- dotenv for local environment variables
