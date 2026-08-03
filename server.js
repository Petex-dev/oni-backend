require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const Anthropic = require('@anthropic-ai/sdk');
const multer = require('multer');
const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

const upload = multer({ storage: multer.memoryStorage() });

const app = express();
const port = process.env.PORT || 3000;

app.set('trust proxy', 1);

// Only allow requests from onimastering.com (and localhost for local dev)
// TEMP — iPhone TTS gain-boost listening test (2026-08-02). Remove 'http://192.168.1.152:8790'
// once Pete's confirmed the test result; not a permanent origin.
// TEMP — iPhone silent-playback/ducking diagnostic via Cloudflare quick tunnel (2026-08-03).
// Remove 'https://carpet-parameter-mumbai-patents.trycloudflare.com' once the investigation is done;
// this is a random per-session trycloudflare.com URL, not a permanent origin.
app.use(cors({
  origin: ['https://onimastering.com', 'https://www.onimastering.com', 'http://localhost:3000', 'http://192.168.1.152:8790', 'https://carpet-parameter-mumbai-patents.trycloudflare.com'],
}));

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

const PLAN_BY_PRICE_ID = {
  'price_1Tuf1XKjqIxiI4UrVsOeXrlQ': { plan: 'artist', credits: 50 }, // Artist monthly
  'price_1Tuf93KjqIxiI4UrzG26INfg': { plan: 'artist', credits: 50 }, // Artist yearly
  'price_1TufCGKjqIxiI4Ur7Z7aLSaS': { plan: 'pro', credits: 125 }, // Pro monthly
  'price_1TufD2KjqIxiI4UrEP8oGR4N': { plan: 'pro', credits: 125 }, // Pro yearly
  'price_1TufEGKjqIxiI4UrrgAIYRTf': { plan: 'studio', credits: 300 }, // Studio monthly
  'price_1TufExKjqIxiI4Ur0vsu2mLr': { plan: 'studio', credits: 300 }, // Studio yearly
};
const REUP_PRICE_ID = 'price_1TufHBKjqIxiI4UrGwz7YUg9'; // Credit Re-up (one-time)
const ALLOWED_PRICE_IDS = new Set([...Object.keys(PLAN_BY_PRICE_ID), REUP_PRICE_ID]);

// Stripe webhook needs the raw body to verify the signature, so this route
// must be registered before the global express.json() middleware.
app.post('/api/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      req.headers['stripe-signature'],
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (error) {
    console.error('Stripe webhook signature verification failed:', error.message);
    return res.status(400).json({ error: 'Invalid signature' });
  }

  if (event.type !== 'checkout.session.completed') {
    return res.status(200).json({ received: true });
  }

  const session = event.data.object;
  const userId = session.client_reference_id;
  // Set at checkout-session creation time (see /api/create-checkout-session) —
  // session.line_items is not present on this webhook payload by default.
  const priceId = session.metadata?.priceId;

  try {
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    if (priceId && PLAN_BY_PRICE_ID[priceId]) {
      const { plan, credits } = PLAN_BY_PRICE_ID[priceId];
      const { error } = await supabase
        .from('profiles')
        .update({
          plan,
          credits,
          credits_refreshed_at: new Date().toISOString(),
          stripe_customer_id: session.customer,
          stripe_subscription_id: session.subscription,
        })
        .eq('id', userId);

      if (error) throw error;
    } else if (priceId === REUP_PRICE_ID) {
      const { error } = await supabase.rpc('increment_credits', {
        p_user_id: userId,
        p_amount: 10,
      });

      if (error) throw error;
    }

    res.status(200).json({ received: true });
  } catch (error) {
    console.error('Stripe webhook handler error:', error.message);
    res.status(500).json({ error: 'Webhook handler failed' });
  }
});

app.use(express.json());

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// 20 requests per 15 minutes per IP address, applied only to /api/chat
const chatLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'Too many requests. You can send 200 messages every 15 minutes. Please wait and try again.',
  },
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'Oni backend is alive' });
});

app.post('/api/create-checkout-session', chatLimiter, async (req, res) => {
  const { priceId, userId, userEmail } = req.body;

  if (!ALLOWED_PRICE_IDS.has(priceId)) {
    return res.status(400).json({ error: 'Invalid priceId' });
  }

  try {
    const session = await stripe.checkout.sessions.create({
      mode: priceId === REUP_PRICE_ID ? 'payment' : 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      client_reference_id: userId,
      customer_email: userEmail,
      metadata: { priceId },
      success_url: 'https://onimastering.com/?checkout=success',
      cancel_url: 'https://onimastering.com/?checkout=cancel',
    });

    res.json({ url: session.url });
  } catch (error) {
    console.error('Stripe checkout session error:', error.message);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

app.post('/api/chat', chatLimiter, async (req, res) => {
  const { message, messages, system, model, max_tokens } = req.body;

  let resolvedMessages;
  if (messages) {
    resolvedMessages = messages;
  } else if (message) {
    resolvedMessages = [{ role: 'user', content: message }];
  } else {
    return res.status(400).json({ error: 'message or messages is required' });
  }

  const params = {
    model: model || 'claude-sonnet-4-5',
    max_tokens: max_tokens || 4096,
    messages: resolvedMessages,
  };

  if (system) params.system = system;

  try {
    const stream = anthropic.messages.stream(params);
    const response = await stream.finalMessage();
    res.json(response);
  } catch (error) {
    console.error('Anthropic API error:', error.message);
    res.status(500).json({ error: 'Failed to get response from Anthropic' });
  }
});

app.post('/api/tts', chatLimiter, async (req, res) => {
  const { text, voice = 'echo' } = req.body;

  if (!text) {
    return res.status(400).json({ error: 'text is required' });
  }

  try {
    const response = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: 'tts-1', input: text, voice }),
    });

    if (!response.ok) {
      const err = await response.json();
      return res.status(response.status).json({ error: err.error?.message || 'TTS failed' });
    }

    res.setHeader('Content-Type', 'audio/mpeg');
    const buffer = await response.arrayBuffer();
    res.send(Buffer.from(buffer));
  } catch (error) {
    console.error('OpenAI TTS error:', error.message);
    res.status(500).json({ error: 'Failed to generate speech' });
  }
});

app.post('/api/transcribe', chatLimiter, upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'audio file is required' });
  }

  try {
    const formData = new FormData();
    formData.append(
      'file',
      new Blob([req.file.buffer], { type: req.file.mimetype }),
      req.file.originalname
    );
    formData.append('model', 'whisper-1');

    const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` },
      body: formData,
    });

    if (!response.ok) {
      const err = await response.json();
      return res.status(response.status).json({ error: err.error?.message || 'Transcription failed' });
    }

    res.json(await response.json());
  } catch (error) {
    console.error('OpenAI Whisper error:', error.message);
    res.status(500).json({ error: 'Failed to transcribe audio' });
  }
});

app.listen(port, () => {
  console.log(`Server started on port ${port}`);
  console.log(`Health check available at http://localhost:${port}/api/health`);
});
