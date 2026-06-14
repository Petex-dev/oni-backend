require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
const port = process.env.PORT || 3000;

// Only allow requests from onimastering.com (and localhost for local dev)
app.use(cors({
  origin: ['https://onimastering.com', 'https://www.onimastering.com', 'http://localhost:3000'],
}));

app.use(express.json());

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// 20 requests per 15 minutes per IP address, applied only to /api/chat
const chatLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'Too many requests. You can send 20 messages every 15 minutes. Please wait and try again.',
  },
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'Oni backend is alive' });
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

app.listen(port, () => {
  console.log(`Server started on port ${port}`);
  console.log(`Health check available at http://localhost:${port}/api/health`);
});
