/* A.M. Glow Up -- Square card payments + order notification emails.
 *
 * Everything except /api/* is served straight from static assets. The API
 * routes exist so the Square access token never reaches the browser, so the
 * charge amount is computed here (not trusted from the client), and so every
 * order -- card or phone/WhatsApp -- emails the owner a summary.
 *
 * Secrets / vars:
 *   SQUARE_ACCESS_TOKEN      (secret, set with `npx wrangler secret put`)
 *   SQUARE_APP_ID            (public, wrangler.jsonc vars)
 *   FORMSPREE_ORDER_FORM_ID  (wrangler.jsonc vars; the Formspree form emails
 *                             the owner's Gmail)
 */

const SQUARE_API = 'https://connect.squareup.com/v2';
const SQUARE_VERSION = '2025-01-23';
const SHIPPING_CENTS = 800;
const FREE_SHIPPING_MIN_CENTS = 9900;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    /* One canonical host for SEO: www.amglowup.com -> amglowup.com. */
    if (url.hostname === 'www.amglowup.com') {
      url.hostname = 'amglowup.com';
      return Response.redirect(url.toString(), 301);
    }
    if (url.pathname === '/api/square-config' && request.method === 'GET') {
      return squareConfig(env);
    }
    if (url.pathname === '/api/pay' && request.method === 'POST') {
      return pay(request, env, ctx);
    }
    if (url.pathname === '/api/order' && request.method === 'POST') {
      return phoneOrder(request, env);
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

/* Prices come from the deployed checkout page's catalog, the same list the
   page renders, so there's no third copy to keep in sync. The browser only
   sends product ids and quantities. (/checkout, not /checkout.html -- the
   assets layer redirects the .html form.) */
let cachedCatalog = null;
async function getCatalog(env, request) {
  if (cachedCatalog) return cachedCatalog;
  const res = await env.ASSETS.fetch(new URL('/checkout', request.url));
  const html = await res.text();
  const catalog = new Map();
  const re = /\{\s*id:\s*(\d+),\s*name:\s*'((?:\\'|[^'])*)',\s*price:\s*(\d+(?:\.\d+)?)[^}]*\}/g;
  for (const m of html.matchAll(re)) {
    catalog.set(Number(m[1]), {
      name: m[2].replace(/\\'/g, "'"),
      cents: Math.round(Number(m[3]) * 100),
      soldOut: /soldOut:\s*true/.test(m[0]),
    });
  }
  if (catalog.size === 0) throw new Error('Could not read product catalog');
  cachedCatalog = catalog;
  return catalog;
}

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const money = (cents) => '$' + (cents / 100).toFixed(2);

function cleanCustomer(c = {}) {
  return {
    name: str(c.name, 80), phone: str(c.phone, 30), email: str(c.email, 120),
    address: str(c.address, 120), city: str(c.city, 60), state: str(c.state, 30), zip: str(c.zip, 15),
  };
}

/* Shared by card and phone orders: validates the bag against the catalog
   and returns the authoritative totals. Throws { status, error } on bad
   input. */
async function priceOrder(env, request, items) {
  if (!Array.isArray(items) || items.length === 0) throw { status: 400, error: 'Invalid request' };
  let catalog;
  try {
    catalog = await getCatalog(env, request);
  } catch (err) {
    console.error(err);
    throw { status: 503, error: 'Checkout is temporarily unavailable' };
  }
  let subtotal = 0;
  const lines = [];
  for (const item of items) {
    const product = catalog.get(Number(item.id));
    const qty = Number(item.qty);
    if (!product || product.soldOut || !Number.isInteger(qty) || qty < 1 || qty > 50) {
      throw { status: 400, error: 'Your bag has an item that is no longer available. Please refresh and try again.' };
    }
    subtotal += product.cents * qty;
    lines.push({ qty, name: product.name, cents: product.cents * qty });
  }
  const shipping = subtotal >= FREE_SHIPPING_MIN_CENTS ? 0 : SHIPPING_CENTS;
  return { lines, subtotal, shipping, total: subtotal + shipping };
}

/* Order email to the owner via Formspree. Each field becomes its own row
   in the email, so it reads like a packing slip. */
async function notifyOrder(env, order, customer, payment) {
  if (!env.FORMSPREE_ORDER_FORM_ID) throw new Error('FORMSPREE_ORDER_FORM_ID not set');
  const paid = payment.method === 'card';
  const shipTo = [customer.address, [customer.city, customer.state].filter(Boolean).join(', '), customer.zip]
    .filter(Boolean).join(' · ');
  const body = {
    _subject: (paid ? 'PAID order ' : 'NEW order (call to collect payment) ') + money(order.total) + ' — ' + (customer.name || 'Customer'),
    'Payment': paid
      ? 'PAID by card through Square (' + payment.id + ')'
      : 'NOT PAID YET — contact the customer by phone or WhatsApp to collect payment',
    'Items': order.lines.map((l) => l.qty + ' × ' + l.name + ' — ' + money(l.cents)).join('\n'),
    'Subtotal': money(order.subtotal),
    'Shipping': order.shipping === 0 ? 'Free' : money(order.shipping),
    'Total': money(order.total),
    'Customer': customer.name,
    'Phone': customer.phone,
    'Email': customer.email,
    'Ship to': shipTo,
  };
  if (customer.email) body._replyto = customer.email;
  const res = await fetch('https://formspree.io/f/' + env.FORMSPREE_ORDER_FORM_ID, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error('Formspree ' + res.status + ': ' + (await res.text()).slice(0, 300));
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

/* Phone / WhatsApp orders: nothing is charged, so the email IS the order --
   if it fails to send, the customer has to be told rather than shown a
   confirmation for an order nobody will ever see. */
async function phoneOrder(request, env) {
  const body = await readJson(request);
  if (!body) return json({ error: 'Invalid request' }, 400);
  let order;
  try {
    order = await priceOrder(env, request, body.items);
  } catch (e) {
    return json({ error: e.error || 'Invalid request' }, e.status || 400);
  }
  const customer = cleanCustomer(body.customer);
  if (!customer.name || !customer.phone) return json({ error: 'Please add your name and phone number.' }, 400);
  try {
    await notifyOrder(env, order, customer, { method: 'phone' });
  } catch (err) {
    console.error('Phone order notification failed', err);
    return json({ error: 'We couldn\'t send your order. Please call or text us at (786) 521-7657 to place it.' }, 502);
  }
  return json({ ok: true, total: order.total });
}

async function pay(request, env, ctx) {
  if (!env.SQUARE_ACCESS_TOKEN) return json({ error: 'Card payments are not configured yet' }, 503);

  const body = await readJson(request);
  if (!body || typeof body.sourceId !== 'string') return json({ error: 'Invalid request' }, 400);

  let order;
  try {
    order = await priceOrder(env, request, body.items);
  } catch (e) {
    return json({ error: e.error || 'Invalid request' }, e.status || 400);
  }
  const customer = cleanCustomer(body.customer);

  const note = ('Website order: ' + order.lines.map((l) => l.qty + 'x ' + l.name).join(', ') + ' | Ship to: ' +
    [customer.name, customer.phone, customer.address, customer.city, customer.state, customer.zip].join(', ')).slice(0, 500);

  let locationId;
  try {
    locationId = await getLocationId(env);
  } catch (err) {
    console.error(err);
    return json({ error: 'Card payments are temporarily unavailable' }, 503);
  }

  const payment = {
    idempotency_key: crypto.randomUUID(),
    source_id: body.sourceId,
    amount_money: { amount: order.total, currency: 'USD' },
    location_id: locationId,
    autocomplete: true,
    note,
    shipping_address: {
      address_line_1: customer.address,
      locality: customer.city,
      administrative_district_level_1: customer.state,
      postal_code: customer.zip,
      country: 'US',
    },
  };
  if (customer.email) payment.buyer_email_address = customer.email;
  if (typeof body.verificationToken === 'string') payment.verification_token = body.verificationToken;

  const res = await squareFetch(env, '/payments', { method: 'POST', body: JSON.stringify(payment) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.payment) {
    const code = data.errors && data.errors[0] && data.errors[0].code;
    console.error('Square payment failed', res.status, JSON.stringify(data.errors || data));
    return json({ error: friendlyError(code) }, 402);
  }

  /* The charge already succeeded, so a failed email must not fail the
     response -- the payment still shows in her Square dashboard. */
  ctx.waitUntil(
    notifyOrder(env, order, customer, { method: 'card', id: data.payment.id })
      .catch((err) => console.error('Card order notification failed', data.payment.id, err))
  );
  return json({ ok: true, paymentId: data.payment.id, receiptUrl: data.payment.receipt_url || null, total: order.total });
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
