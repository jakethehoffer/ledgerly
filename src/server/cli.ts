#!/usr/bin/env node
import Stripe from 'stripe';
import { createServer } from './index.js';

const stripeSecretKey = process.env['STRIPE_SECRET_KEY'];
const webhookSecret = process.env['STRIPE_WEBHOOK_SECRET'];

if (!stripeSecretKey || !webhookSecret) {
  // eslint-disable-next-line no-console
  console.error(
    'Missing STRIPE_SECRET_KEY or STRIPE_WEBHOOK_SECRET environment variables',
  );
  process.exit(1);
}

const stripe = new Stripe(stripeSecretKey);
const { app } = createServer({ stripe, webhookSecret });

const port = Number(process.env['PORT'] ?? 3000);
app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`ledgerly webhook receiver listening on http://localhost:${String(port)}`);
  // eslint-disable-next-line no-console
  console.log('POST /webhook  -> Stripe webhook endpoint');
  // eslint-disable-next-line no-console
  console.log('GET  /health   -> health + dedup size');
});
