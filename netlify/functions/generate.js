// netlify/functions/generate.js
const crypto = require('crypto');
const { supabase } = require('./_supabase');

const SECRET = (process.env.WC_WEBHOOK_SECRET || '').trim(); // trim to avoid hidden spaces

function hmacBase64(secret, buf) {
  return crypto.createHmac('sha256', secret).update(buf).digest('base64');
}

function json(code, body) {
  return {
    statusCode: code,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

exports.handler = async (event) => {
  try {
    // Health / GET check
    if (event.httpMethod === 'GET') {
      return json(200, { ok: true, note: 'Generator ready' });
    }

    const debug = (event.queryStringParameters || {}).debug === '1';

    if (!SECRET) {
      return json(500, { ok: false, reason: 'server_misconfig', detail: 'WC_WEBHOOK_SECRET missing' });
    }

    // Raw body handling (important for signature)
    let rawBuf;
    if (event.isBase64Encoded) {
      rawBuf = Buffer.from(event.body || '', 'base64');
    } else {
      rawBuf = Buffer.from(event.body || '', 'utf8');
    }

    const headers = event.headers || {};
    const topic = String(headers['x-wc-webhook-topic'] || headers['X-WC-Webhook-Topic'] || '');
    const sig = String(headers['x-wc-webhook-signature'] || headers['X-WC-Webhook-Signature'] || '');
    const expected = hmacBase64(SECRET, rawBuf);

    // Allow Woo "test" webhooks without failing your admin screen
    if (topic.startsWith('webhooks.')) {
      return json(200, { ok: true, note: 'pong', topic });
    }

    // Verify signature
    // Use timing-safe compare if lengths match, fall back otherwise
    let validSig = false;
    try {
      const a = Buffer.from(sig, 'utf8');
      const b = Buffer.from(expected, 'utf8');
      if (a.length === b.length) validSig = crypto.timingSafeEqual(a, b);
    } catch {}
    if (!validSig) {
      return json(401, {
        ok: false,
        reason: 'bad_signature',
        ...(debug ? {
          topic,
          isBase64: !!event.isBase64Encoded,
          recvSigLen: sig.length,
          expSigLen: expected.length,
          recvSigSample: sig.slice(0, 8) + '…',
          expSigSample: expected.slice(0, 8) + '…',
        } : {}),
      });
    }

    // Parse JSON body
    let data;
    try { data = JSON.parse(rawBuf.toString('utf8') || '{}'); }
    catch { return json(400, { ok: false, reason: 'bad_json' }); }

    // Extract fields commonly present in Woo order webhooks
    const orderId = data.id || data.order_id || null;
    const email =
      (data.billing && data.billing.email) ||
      data.customer_email ||
      (data.customer && data.customer.email) ||
      null;

    // Generate license
    const key = `VMT-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`.toUpperCase();
    const plan = 'full';
    const max_devices = 2;

    // Write to Supabase
    const { error } = await supabase
      .from('licenses')
      .insert([{ key, plan, status: 'active', max_devices, order_id: orderId, email }]);

    if (error) {
      return json(500, { ok: false, reason: 'db_insert_failed', detail: error.message });
    }

    return json(200, { ok: true, key, plan, max_devices, email, orderId });
  } catch (e) {
    return json(500, { ok: false, reason: 'server_error', detail: String(e && e.message || e) });
  }
};
