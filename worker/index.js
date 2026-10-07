/* A.M. Glow Up -- Square card payments.
 *
 * Everything except /api/* is served straight from static assets. The two
 * API routes exist so the Square access token never reaches the browser and
 * so the charge amount is computed here, not trusted from the client.
 *
 * Secrets / vars:
 *   SQUARE_ACCESS_TOKEN  (secret, set with `npx wrangler secret put`)
 *   SQUARE_APP_ID        (public, wrangler.jsonc vars)
 */

const SQUARE_API = 'https://connect.squareup.com/v2';
const SQUARE_VERSION = '2025-01-23';
const SHIPPING_CENTS = 800;
const FREE_SHIPPING_MIN_CENTS = 9900;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/square-config' && request.method === 'GET') {
      return squareConfig(env);
    }
    if (url.pathname === '/api/pay' && request.method === 'POST') {
      return pay(request, env);
    }
    if (url.pathname.startsWith('/api/')) {
      return json({ error: 'Not found' }, 404);
    }
    return env.ASSETS.fetch(request);
  },
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

function squareFetch(env, path, init = {}) {
  return fetch(SQUARE_API + path, {
    ...init,
    headers: {
      authorization: 'Bearer ' + env.SQUARE_ACCESS_TOKEN,
      'square-version': SQUARE_VERSION,
      'content-type': 'application/json',
      ...(init.headers || {}),
    },
  });
}

/* The location ID is looked up from the account itself rather than
   hardcoded, so a mistyped ID can't silently break checkout. Cached per
   isolate. */
let cachedLocationId = null;
async function getLocationId(env) {
  if (cachedLocationId) return cachedLocationId;
  const res = await squareFetch(env, '/locations');
  if (!res.ok) throw new Error('Square locations lookup failed: ' + res.status);
  const { locations = [] } = await res.json();
  const active = locations.filter((l) => l.status === 'ACTIVE');
  const main = active.find((l) => /main/i.test(l.name || '')) || active[0];
  if (!main) throw new Error('No active Square location on this account');
  cachedLocationId = main.id;
  return cachedLocationId;
}

async function squareConfig(env) {
  if (!env.SQUARE_ACCESS_TOKEN || !env.SQUARE_APP_ID) {
    return json({ error: 'Card payments are not configured yet' }, 503);
  }
  try {
    return json({ appId: env.SQUARE_APP_ID, locationId: await getLocationId(env) });
  } catch (err) {
    console.error(err);
    return json({ error: 'Card payments are temporarily unavailable' }, 503);
  }
}

/* Prices come from the deployed checkout.html catalog, the same list the
   page renders, so there's no third copy to keep in sync. The browser only
   sends product ids and quantities. */
let cachedCatalog = null;
async function getCatalog(env, request) {
  if (cachedCatalog) return cachedCatalog;
  const res = await env.ASSETS.fetch(new URL('/checkout.html', request.url));
  const html = await res.text();
  const catalog = new Map();
  const re = /\{\s*id:\s*(\d+),\s*name:\s*'((?:\\'|[^'])*)',\s*price:\s*(\d+(?:\.\d+)?)/g;
  for (const m of html.matchAll(re)) {
    catalog.set(Number(m[1]), { name: m[2].replace(/\\'/g, "'"), cents: Math.round(Number(m[3]) * 100) });
  }
  if (catalog.size === 0) throw new Error('Could not read product catalog');
  cachedCatalog = catalog;
  return catalog;
}

async function pay(request, env) {
  if (!env.SQUARE_ACCESS_TOKEN) return json({ error: 'Card payments are not configured yet' }, 503);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid request' }, 400);
  }
  const { sourceId, items, customer = {} } = body || {};
  if (typeof sourceId !== 'string' || !Array.isArray(items) || items.length === 0) {
    return json({ error: 'Invalid request' }, 400);
  }

  let catalog;
  try {
    catalog = await getCatalog(env, request);
  } catch (err) {
    console.error(err);
    return json({ error: 'Checkout is temporarily unavailable' }, 503);
  }

  let subtotal = 0;
  const lines = [];
  for (const item of items) {
    const product = catalog.get(Number(item.id));
    const qty = Number(item.qty);
    if (!product || !Number.isInteger(qty) || qty < 1 || qty > 50) {
      return json({ error: 'Your bag has an item that is no longer available. Please refresh and try again.' }, 400);
    }
    subtotal += product.cents * qty;
    lines.push(qty + 'x ' + product.name);
  }
  const shipping = subtotal >= FREE_SHIPPING_MIN_CENTS ? 0 : SHIPPING_CENTS;
  const total = subtotal + shipping;

  const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const note = ('Website order: ' + lines.join(', ') + ' | Ship to: ' +
    [str(customer.name, 80), str(customer.phone, 30), str(customer.address, 120),
     str(customer.city, 60), str(customer.state, 30), str(customer.zip, 15)].join(', ')).slice(0, 500);

  let locationId;
  try {
    locationId = await getLocationId(env);
  } catch (err) {
    console.error(err);
    return json({ error: 'Card payments are temporarily unavailable' }, 503);
  }

  const payment = {
    idempotency_key: crypto.randomUUID(),
    source_id: sourceId,
    amount_money: { amount: total, currency: 'USD' },
    location_id: locationId,
    autocomplete: true,
    note,
    shipping_address: {
      address_line_1: str(customer.address, 120),
      locality: str(customer.city, 60),
      administrative_district_level_1: str(customer.state, 30),
      postal_code: str(customer.zip, 15),
      country: 'US',
    },
  };
  const email = str(customer.email, 120);
  if (email) payment.buyer_email_address = email;
  if (typeof body.verificationToken === 'string') payment.verification_token = body.verificationToken;

  const res = await squareFetch(env, '/payments', { method: 'POST', body: JSON.stringify(payment) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.payment) {
    const code = data.errors && data.errors[0] && data.errors[0].code;
    console.error('Square payment failed', res.status, JSON.stringify(data.errors || data));
    return json({ error: friendlyError(code) }, 402);
  }
  return json({ ok: true, paymentId: data.payment.id, receiptUrl: data.payment.receipt_url || null, total });
}

function friendlyError(code) {
  switch (code) {
    case 'CARD_DECLINED':
    case 'GENERIC_DECLINE':
    case 'INSUFFICIENT_FUNDS':
      return 'Your card was declined. Please try another card.';
    case 'CVV_FAILURE':
      return 'The security code (CVC) didn\'t match. Please check it and try again.';
    case 'ADDRESS_VERIFICATION_FAILURE':
      return 'The ZIP code didn\'t match your card. Please check it and try again.';
    case 'INVALID_EXPIRATION':
    case 'EXPIRATION_FAILURE':
      return 'The card expiration date is invalid.';
    default:
      return 'Payment didn\'t go through. Please check your card details or try another card.';
  }
}
