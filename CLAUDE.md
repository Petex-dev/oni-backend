# CLAUDE.md

## Project
Oni AI Mastering — backend server

## Purpose
Node.js backend for a browser-based AI audio mastering studio. Handles user accounts, API key proxying (hides Anthropic + OpenAI keys server-side), Stripe payments, and an autonomous mastering agent.

## Stack
- Node.js
- Express.js
- Supabase (auth + database)
- Stripe (payments)
- Deployed to Railway

## Conventions
- Keep all API keys in environment variables, never in code
- Use RESTful endpoints under /api
- Return clear error messages as JSON
