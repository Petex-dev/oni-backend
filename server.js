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
app.use(cors({
  origin: ['https://onimastering.com', 'https://www.onimastering.com', 'http://localhost:3000'],
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

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const userId = session.client_reference_id;
    // Set at checkout-session creation time (see /api/create-checkout-session) —
    // session.line_items is not present on this webhook payload by default.
    const priceId = session.metadata?.priceId;

    try {
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
  } else if (event.type === 'invoice.paid') {
    // Monthly/yearly renewal. billing_reason is 'subscription_create' for the
    // very first invoice — that one is already handled by checkout.session.completed
    // above, so only act on 'subscription_cycle' (recurring renewals) here.
    const invoice = event.data.object;

    const subscriptionId = invoice.parent?.subscription_details?.subscription;

    if (invoice.billing_reason !== 'subscription_cycle' || !subscriptionId) {
      return res.status(200).json({ received: true });
    }

    try {
      // Read the CURRENT active price off the subscription itself rather than
      // invoice.lines.data[0] — invoices with proration line items (from a
      // recent plan change) don't guarantee the first line is the recurring
      // charge, so line-based parsing can pick up a stale/wrong price.
      const subscription = await stripe.subscriptions.retrieve(subscriptionId);

      // The final invoice for a canceled subscription's last period can still
      // arrive as invoice.paid after customer.subscription.deleted has already
      // run — don't let it overwrite the plan='free' transition that handler
      // already applied.
      if (subscription.status === 'canceled') {
        return res.status(200).json({ received: true });
      }

      const priceId = subscription.items.data[0]?.price?.id;
      const periodStart = subscription.items.data[0]?.current_period_start;

      if (!priceId || !PLAN_BY_PRICE_ID[priceId] || !periodStart) {
        return res.status(200).json({ received: true });
      }

      const { plan, credits } = PLAN_BY_PRICE_ID[priceId];
      const periodStartIso = new Date(periodStart * 1000).toISOString();

      // Idempotent: only reset credits if we haven't already refreshed them
      // for this billing period (guards against duplicate webhook delivery).
      // This looks up the profile by stripe_customer_id — invoices have no
      // client_reference_id / userId, unlike checkout sessions.
      const { error } = await supabase
        .from('profiles')
        .update({
          plan,
          credits,
          credits_refreshed_at: new Date().toISOString(),
          payment_status: 'active',
        })
        .eq('stripe_customer_id', invoice.customer)
        .lt('credits_refreshed_at', periodStartIso);

      if (error) throw error;

      res.status(200).json({ received: true });
    } catch (error) {
      console.error('Stripe webhook handler error (invoice.paid):', error.message);
      res.status(500).json({ error: 'Webhook handler failed' });
    }
  } else if (event.type === 'invoice.payment_failed') {
    // A renewal payment failed. Stripe's own retry schedule (dunning) will keep
    // trying for a few days — we just flag the account as not in good standing
    // so paid-tier access can be gated on this. We do NOT touch credits/plan
    // here: no invoice.paid means no new credits get granted while failing.
    const invoice = event.data.object;

    try {
      const { error } = await supabase
        .from('profiles')
        .update({ payment_status: 'past_due' })
        .eq('stripe_customer_id', invoice.customer);

      if (error) throw error;

      res.status(200).json({ received: true });
    } catch (error) {
      console.error('Stripe webhook handler error (invoice.payment_failed):', error.message);
      res.status(500).json({ error: 'Webhook handler failed' });
    }
  } else if (event.type === 'customer.subscription.updated') {
    // Plan change (upgrade/downgrade) via the customer portal. Only sync when
    // the active price actually maps to a different plan than what's stored —
    // subscription.updated also fires for unrelated changes (e.g. toggling
    // cancel_at_period_end, payment method updates) and we don't want those to
    // reset credits_refreshed_at / re-grant credits.
    const subscription = event.data.object;
    const priceId = subscription.items.data[0]?.price?.id;

    if (!priceId || !PLAN_BY_PRICE_ID[priceId] || subscription.status !== 'active') {
      return res.status(200).json({ received: true });
    }

    try {
      const { plan, credits } = PLAN_BY_PRICE_ID[priceId];
      const { data: existing, error: fetchError } = await supabase
        .from('profiles')
        .select('plan, credits')
        .eq('stripe_customer_id', subscription.customer)
        .single();

      if (fetchError) throw fetchError;

      if (existing && existing.plan !== plan) {
        // Upgrade vs downgrade is decided against the user's CURRENT credits
        // balance, not the old plan's nominal amount — someone who's already
        // used most of their credits shouldn't be treated as "downgrading"
        // just because their remaining balance happens to be low.
        const isUpgrade = credits > existing.credits;
        const update = {
          plan,
          stripe_subscription_id: subscription.id,
          payment_status: 'active',
        };
        if (isUpgrade) {
          // Upgrade: unlock the new plan's full credit amount immediately.
          update.credits = credits;
          update.credits_refreshed_at = new Date().toISOString();
        }
        // Downgrade: only `plan` changes here. Credits stay as-is until the
        // next invoice.paid renewal resets them to the new (lower) amount.
        const { error } = await supabase
          .from('profiles')
          .update(update)
          .eq('stripe_customer_id', subscription.customer);

        if (error) throw error;
      }

      res.status(200).json({ received: true });
    } catch (error) {
      console.error('Stripe webhook handler error (customer.subscription.updated):', error.message);
      res.status(500).json({ error: 'Webhook handler failed' });
    }
  } else if (event.type === 'customer.subscription.deleted') {
    // Subscription actually ended (cancellation reached period end, or Stripe
    // canceled it after exhausting dunning retries). Our billing portal is
    // configured to cancel at period end, so this fires exactly when access
    // should end — not the moment the user clicks "cancel".
    const subscription = event.data.object;

    try {
      const { error } = await supabase
        .from('profiles')
        .update({
          plan: 'free',
          payment_status: 'active',
          stripe_subscription_id: null,
        })
        .eq('stripe_customer_id', subscription.customer);

      if (error) throw error;

      res.status(200).json({ received: true });
    } catch (error) {
      console.error('Stripe webhook handler error (customer.subscription.deleted):', error.message);
      res.status(500).json({ error: 'Webhook handler failed' });
    }
  } else {
    res.status(200).json({ received: true });
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
    return res.status(400).json({ error: { message: 'Invalid priceId' } });
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
    const status = error.statusCode || 500;
    const message = error.message || 'Failed to create checkout session';
    console.error('Stripe checkout session error:', error.message);
    res.status(status).json({ error: { message } });
  }
});

app.post('/api/create-portal-session', chatLimiter, async (req, res) => {
  const { userId } = req.body;

  if (!userId) {
    return res.status(400).json({ error: { message: 'userId is required' } });
  }

  try {
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    const { data: profile, error } = await supabase
      .from('profiles')
      .select('stripe_customer_id')
      .eq('id', userId)
      .single();

    if (error) throw error;

    if (!profile || !profile.stripe_customer_id) {
      return res.status(400).json({ error: { message: 'No billing account found for this user' } });
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: profile.stripe_customer_id,
      return_url: 'https://onimastering.com/?billing=return',
    });

    res.json({ url: session.url });
  } catch (error) {
    const status = error.statusCode || 500;
    const message = error.message || 'Failed to create billing portal session';
    console.error('Stripe portal session error:', error.message);
    res.status(status).json({ error: { message } });
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
    const status = error.status || 500;
    const message = error.error?.error?.message || error.message || 'Failed to get response from Anthropic';
    console.error('Anthropic API error:', error.message);
    res.status(status).json({ error: { message } });
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
      body: JSON.stringify({ model: 'gpt-4o-mini-tts', input: text, voice }),
    });

    if (!response.ok) {
      const err = await response.json();
      const message = err.error?.message || 'TTS failed';
      return res.status(response.status).json({ error: { message } });
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
