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
  'price_1UHoSK3jfi4dDsisTns53CGN': { plan: 'artist', credits: 50 }, // Artist monthly
  'price_1UHoSJ3jfi4dDsisYWIwzvEe': { plan: 'artist', credits: 50 }, // Artist yearly
  'price_1UHoSJ3jfi4dDsisxBXGSGml': { plan: 'pro', credits: 125 }, // Pro monthly
  'price_1UHoSJ3jfi4dDsis4MSeybV4': { plan: 'pro', credits: 125 }, // Pro yearly
  'price_1UHoSN3jfi4dDsis1t6zZ2bB': { plan: 'studio', credits: 300 }, // Studio monthly
  'price_1UHoSM3jfi4dDsispDYAgtCq': { plan: 'studio', credits: 300 }, // Studio yearly
};
const REUP_PRICE_ID = 'price_1UHoSJ3jfi4dDsishsXnGTXh'; // Credit Re-up (one-time)
const ALLOWED_PRICE_IDS = new Set([...Object.keys(PLAN_BY_PRICE_ID), REUP_PRICE_ID]);

// Every Stripe-purchased credit grant goes through apply_credit_grant (Migration 5),
// which records it in credit_grants and changes the balance in one transaction —
// exactly once per Stripe event, since Stripe delivers events at least once.
async function grantCredits(supabase, args) {
  const { data, error } = await supabase.rpc('apply_credit_grant', args);
  if (error) throw error;
  if (data === 'no_profile') throw new Error(`apply_credit_grant: no profile for user ${args.p_user_id}`);
  if (data === 'duplicate') console.log(`Stripe event ${args.p_stripe_event_id} already granted — skipped`);
  return data;
}

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

        // Non-credit fields first: safe to repeat, so a retry after a failed grant
        // below just re-applies them.
        const { error } = await supabase
          .from('profiles')
          .update({
            plan,
            stripe_customer_id: session.customer,
            stripe_subscription_id: session.subscription,
          })
          .eq('id', userId);

        if (error) throw error;

        // A new subscription is a purchase, not a renewal — the plan's credits are ADDED
        // to whatever the customer already has. Recorded against the subscription's
        // first invoice so a refund of that charge can find it.
        await grantCredits(supabase, {
          p_user_id: userId,
          p_kind: 'subscription_start',
          p_amount: credits,
          p_stripe_event_id: event.id,
          p_stripe_invoice_id: session.invoice,
          p_amount_paid_cents: session.amount_total,
          p_currency: session.currency,
        });
      } else if (priceId === REUP_PRICE_ID) {
        // Re-up credits go to bonus_credits, which the invoice.paid renewal reset
        // never touches — a customer keeps what they paid for across renewals.
        await grantCredits(supabase, {
          p_user_id: userId,
          p_kind: 'reup',
          p_amount: 10,
          p_stripe_event_id: event.id,
          p_stripe_payment_intent_id: session.payment_intent,
          p_amount_paid_cents: session.amount_total,
          p_currency: session.currency,
        });
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

      // Invoices have no client_reference_id / userId, unlike checkout sessions,
      // so find the profile by stripe_customer_id.
      const { data: profile, error: fetchError } = await supabase
        .from('profiles')
        .select('id')
        .eq('stripe_customer_id', invoice.customer)
        .maybeSingle();

      if (fetchError) throw fetchError;
      if (!profile) {
        return res.status(200).json({ received: true });
      }

      // Resets credits to the plan amount (no rollover). Idempotent twice over: once
      // per Stripe event, and only if this billing period hasn't been refreshed yet.
      await grantCredits(supabase, {
        p_user_id: profile.id,
        p_kind: 'renewal',
        p_amount: credits,
        p_stripe_event_id: event.id,
        p_stripe_invoice_id: invoice.id,
        p_amount_paid_cents: invoice.amount_paid,
        p_currency: invoice.currency,
        p_period_start: periodStartIso,
      });

      const { error } = await supabase
        .from('profiles')
        .update({ plan, payment_status: 'active' })
        .eq('id', profile.id);

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
        .select('id, plan, credits')
        .eq('stripe_customer_id', subscription.customer)
        .single();

      if (fetchError) throw fetchError;

      if (existing && existing.plan !== plan) {
        // Upgrade vs downgrade is decided against the user's CURRENT credits
        // balance, not the old plan's nominal amount — someone who's already
        // used most of their credits shouldn't be treated as "downgrading"
        // just because their remaining balance happens to be low.
        const isUpgrade = credits > existing.credits;
        if (isUpgrade) {
          // Upgrade is a purchase (proration charge), not a renewal — add the new
          // plan's credits to the existing balance rather than overwriting it.
          // The live portal invoices prorations immediately, so the upgrade has its
          // own invoice; link it only if latest_invoice really is that proration
          // invoice, never the previous period's (a refund of that one must match
          // the grant it actually paid for). Granted BEFORE the plan update: if the
          // plan update then fails, the retry sees the old plan, and the grant call
          // is a no-op 'duplicate' for this event.
          let upgradeInvoice = null;
          if (subscription.latest_invoice) {
            const inv = await stripe.invoices.retrieve(
              typeof subscription.latest_invoice === 'string'
                ? subscription.latest_invoice
                : subscription.latest_invoice.id
            );
            if (inv.billing_reason === 'subscription_update') upgradeInvoice = inv;
          }
          await grantCredits(supabase, {
            p_user_id: existing.id,
            p_kind: 'upgrade',
            p_amount: credits,
            p_stripe_event_id: event.id,
            p_stripe_invoice_id: upgradeInvoice?.id || null,
            p_amount_paid_cents: upgradeInvoice?.total ?? null,
            p_currency: upgradeInvoice?.currency || null,
          });
        }
        // Downgrade: only `plan` changes here. Credits stay as-is until the
        // next invoice.paid renewal resets them to the new (lower) amount.
        const { error } = await supabase
          .from('profiles')
          .update({
            plan,
            stripe_subscription_id: subscription.id,
            payment_status: 'active',
          })
          .eq('id', existing.id);

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
  } else if (event.type === 'charge.refunded') {
    // Full or partial refund (issued from the Stripe dashboard). Takes back credits in
    // proportion to the amount refunded, only from the pool that purchase granted,
    // floored at 0; the plan is left alone (cancelling is a separate Stripe action).
    // charge.amount_refunded is cumulative, so repeated partial refunds and re-delivered
    // events converge on the right total. See apply_credit_refund (Migration 5).
    const charge = event.data.object;

    try {
      const paymentIntentId = typeof charge.payment_intent === 'string'
        ? charge.payment_intent
        : charge.payment_intent?.id || null;

      // Charges no longer carry their invoice on this API version — ask Stripe which
      // invoice (if any) this payment paid. Re-up charges have none.
      let invoiceId = null;
      if (paymentIntentId) {
        const payments = await stripe.invoicePayments.list({
          payment: { type: 'payment_intent', payment_intent: paymentIntentId },
          limit: 1,
        });
        const inv = payments.data[0]?.invoice;
        invoiceId = typeof inv === 'string' ? inv : inv?.id || null;
      }

      const { data, error } = await supabase.rpc('apply_credit_refund', {
        p_stripe_event_id: event.id,
        p_stripe_charge_id: charge.id,
        p_stripe_payment_intent_id: paymentIntentId,
        p_stripe_invoice_id: invoiceId,
        p_charge_amount_cents: charge.amount,
        p_refunded_cents_total: charge.amount_refunded,
      });

      if (error) throw error;

      if (data.status === 'no_grant') {
        console.warn(`charge.refunded ${charge.id}: no credit grant recorded for this charge — manual review`);
      } else {
        console.log(`charge.refunded ${charge.id}:`, JSON.stringify(data));
      }

      res.status(200).json({ received: true });
    } catch (error) {
      console.error('Stripe webhook handler error (charge.refunded):', error.message);
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
      return res.status(400).json({ error: { message: 'No billing account found for this user', code: 'no_billing_account' } });
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
  const { text, voice = 'echo', speed } = req.body;

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
      body: JSON.stringify({
        model: 'gpt-4o-mini-tts',
        input: text,
        voice,
        speed: speed || 1.0,
        instructions: 'Speak with genuine warmth and RANGE, like a real seasoned mastering engineer who loves music and is sitting right next to the user. Let real energy come through — sound audibly excited when something sounds great, focused and reassuring when troubleshooting a problem, satisfied when a mix is finally dialed in. Match your tone to what\'s being said, never flat or robotic, never a generic narrator reading a script.',
      }),
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

// ── Support Chat (FAQ-only, separate from the mastering AI Engineer) ──

// Prices in item 1 below are hardcoded from live Stripe price objects, confirmed directly
// against Stripe (not memory/assumption) as of 2026-09-21. A prior incident had the model
// hallucinate a Pro monthly price when this knowledge base had credits/song counts but no
// dollar figures at all — an instruction to "not invent pricing" was not sufficient on its
// own to stop that. If these ever need updating (a price change), verify directly against
// Stripe (dashboard or `stripe prices list`) — don't guess, and don't just bump by feel.
const SUPPORT_SYSTEM_PROMPT = `You are Oni Support, the customer support assistant for onimastering.com.

You have NO access to the mastering engine and cannot change any audio settings (EQ, fades, Saturation, Multiband, compression, etc.) — that is a completely separate system operated by a different AI. If asked to adjust a mix, say so plainly and redirect to the mastering chat.

Answer ONLY from this knowledge base. Do not invent policy, pricing, or behavior not listed here.

1. Plans & credits: Free ($0, 5 credits, one-time signup grant, ~1 song). Artist ($49.99/mo or $539.99/yr, 50 credits/mo, ~10 songs). Pro ($99.99/mo or $1,079.99/yr, 125 credits/mo, ~25 songs). Studio ($199.99/mo or $2,159.99/yr, 300 credits/mo, ~60 songs). Credit Re-up: $10.99 one-time for +10 credits, available on any plan.
2. How credits work: each mastering action costs a fixed number of credits (5 per song master), shown in-app before use. Paid-plan credits refresh monthly and do NOT roll over, including on annual billing.
3. Canceling a subscription: Settings → Manage Subscription opens the Stripe billing portal (self-serve). Cancellation takes effect at the END of the current billing period — plan access and remaining credits continue until then.
4. Refund policy (FIRM — never deviate): credits already used are non-refundable; no prorated refunds for early cancellation except at the founder's discretion or as required by law. Never offer, promise, imply, or hint at refund flexibility or exceptions, and never say you'll "process" one. Direct every refund request to oniaimastering@gmail.com for manual review — do not speculate about the outcome.
5. Mobile downloads: on iOS Safari, a native browser "Download"/save-file prompt appearing after export is EXPECTED behavior (iOS's own file handling), not a bug.
6. Export/render time: heavier chains (e.g. Multiband, Saturation) genuinely take longer to render than simple chains — this is expected, not a stall.
7. Privacy: uploaded audio is deleted from our systems shortly after processing completes; it is never used to train AI models or shared with third parties.
8. Free tier credits: a ONE-TIME grant at signup, not recurring — unlike paid plans, it does not refresh monthly.
9. Undo/redo: available in the mastering editor for settings changes made during the current session.

Escalation — never leave the user without a next step:
- Billing/subscription self-serve (payment method, invoices, canceling, upgrading/downgrading): point to the Stripe Portal via Settings → Manage Subscription.
- Anything else outside this knowledge base — bug reports, refund requests, account issues, anything you're not sure of: point to oniaimastering@gmail.com. Do not guess at answers outside your knowledge base.

Plain text only — no markdown (no asterisks, no headers, no bullet/numbered list syntax). The chat UI displays your reply as raw text, so any markdown shows up as literal symbols. Use line breaks and plain dashes if you need structure.

Respond in the user's language: {lang}. Be warm, concise, and direct.`;

app.post('/api/support-chat', chatLimiter, async (req, res) => {
  const { messages, lang } = req.body;

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages is required' });
  }

  // Auth verification: derive the real user server-side from the Supabase
  // access token. Never trust a client-supplied user_id — there isn't one in
  // this request on purpose.
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'Missing or malformed Authorization header' });
  }

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  const { data: { user }, error: authError } = await supabase.auth.getUser(token);

  if (authError || !user) {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }

  const userId = user.id;

  const params = {
    model: 'claude-sonnet-4-5',
    max_tokens: 1024,
    system: SUPPORT_SYSTEM_PROMPT.replace('{lang}', lang || 'English'),
    messages,
  };

  try {
    const stream = anthropic.messages.stream(params);
    const response = await stream.finalMessage();

    const replyText = response.content?.find((block) => block.type === 'text')?.text || '';

    // Fire-and-forget logging — never block or fail the user's response on this.
    supabase
      .from('support_chat_logs')
      .insert({
        user_id: userId,
        messages: [...messages, { role: 'assistant', content: replyText }],
        created_at: new Date().toISOString(),
      })
      .then(({ error }) => {
        if (error) console.error('Support chat logging error:', error.message);
      });

    res.json(response);
  } catch (error) {
    const status = error.status || 500;
    const message = error.error?.error?.message || error.message || 'Failed to get response from Anthropic';
    console.error('Anthropic API error (support-chat):', error.message);
    res.status(status).json({ error: { message } });
  }
});

app.listen(port, () => {
  console.log(`Server started on port ${port}`);
  console.log(`Health check available at http://localhost:${port}/api/health`);
});
