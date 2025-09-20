// functions/generate.js
const crypto = require('crypto');
const { supabase } = require('./_supabase');

function log(...args) {
  // Netlify will show this in Function Logs
  console.log('[generate]', ...args);
}

function verifyWooSignature(rawBody, secret, headerSig) {
  try {
    if (!secret || !headerSig) return false;
    const digest = crypto
      .createHmac('sha256', secret)
      .update(rawBody, 'utf8')
      .digest('base64');
    return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(headerSig));
  } catch (e) {
    log('signature error', e);
    return false;
  }
}

function makeLicenseKey(prefix = 'VMIX') {
  return `${prefix}-${Math.random().toString(36).slice(2, 6).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== 'POST') {
      return { statusCode: 405, body: 'Method Not Allowed' };
    }

    const qs = new URLSearchParams(event.rawQuery || event.queryStringParameters || {});
    const debugMode = (qs.get && qs.get('debug') === '1') || event.queryStringParameters?.debug === '1';

    const secret = process.env.WC_WEBHOOK_SECRET || '';
    const headerSig = event.headers['x-wc-webhook-signature'] || event.headers['X-WC-Webhook-Signature'];
    const rawBody = event.body || '';

    // Signature check (allow bypass in debug mode so you can test end-to-end)
    const sigOk = verifyWooSignature(rawBody, secret, headerSig);
    if (!sigOk && !debugMode) {
      log('invalid signature', { hasSecret: !!secret, hasHeader: !!headerSig });
      return { statusCode: 401, body: 'Invalid signature' };
    }

    let order = null;
    try {
      order = JSON.parse(rawBody);
    } catch (e) {
      log('JSON parse error; body was:', rawBody.slice(0, 500));
      return { statusCode: 400, body: 'Bad JSON payload' };
    }

    // Woo sends a full order object for “order.*” topics
    const orderId = order.id || order.order_id || null;
    const status = (order.status || '').toLowerCase();
    const email =
      order.billing?.email ||
      order.customer_email ||
      (order.billing && order.billing.email) ||
      '';

    // Optional: see what Woo sent (remove after debugging)
    log('order summary', { orderId, status, email });

    // Only process when paid
    const isPaid = status === 'processing' || status === 'completed';
    if (!isPaid) {
      return {
        statusCode: 200,
        body: JSON.stringify({ ok: true, skipped: true, reason: 'Order not paid', orderId, status })
      };
    }

    if (!email) {
      log('missing email in order');
      return { statusCode: 400, body: 'Billing email missing in order' };
    }

    // Idempotency: already generated for this order?
    const { data: existing, error: findErr } = await supabase
      .from('licenses')
      .select('key, order_id')
      .eq('order_id', orderId)
      .limit(1)
      .maybeSingle();

    if (findErr) {
      log('Supabase select error', findErr);
      return { statusCode: 500, body: 'Supabase read error' };
    }

    if (existing?.key) {
      return {
        statusCode: 200,
        body: JSON.stringify({ ok: true, reused: true, key: existing.key, orderId })
      };
    }

    // Create license
    const newKey = makeLicenseKey('VMIX');
    const nowIso = new Date().toISOString();

    const insertRow = {
      key: newKey,
      plan: 'full',
      active: true,
      email,
      order_id: orderId,
      max_devices: 1,
      created_at: nowIso
      // expires_at: null
    };

    const { error: insErr } = await supabase.from('licenses').insert([insertRow]);
    if (insErr) {
      log('Supabase insert error', insErr);
      return { statusCode: 500, body: 'Supabase insert error' };
    }

    log('license created', { key: newKey, email, orderId });
    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, key: newKey, email, orderId })
    };

  } catch (err) {
    log('unhandled error', err);
    // Never throw a raw 500 without details in logs
    return { statusCode: 500, body: 'Server error' };
  }
};
