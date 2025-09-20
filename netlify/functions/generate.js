// netlify/functions/generate.js
const crypto = require('crypto');
const { supabase } = require('./_supabase');

const SECRET = process.env.WC_WEBHOOK_SECRET;

// HMAC-SHA256 base64 (Woo’s signature method)
function makeSig(secret, raw) {
  return crypto.createHmac('sha256', secret).update(raw).digest('base64');
}

exports.handler = async (event) => {
  try {
    // Basic health check
    if (!SECRET) {
      return resp(500, { ok: false, reason: 'server_misconfig', detail: 'WC_WEBHOOK_SECRET missing' });
    }

    const rawBody = event.body || '';               // RAW string
    const headers = event.headers || {};
    const topic = (headers['x-wc-webhook-topic'] || headers['X-WC-Webhook-Topic'] || '').toString();
    const sig = (headers['x-wc-webhook-signature'] || headers['X-WC-Webhook-Signature'] || '').toString();

    // Allow quick debugging (DON’T leave debug=1 forever in production)
    const debugMode = (event.queryStringParameters || {}).debug === '1';

    // Handle Woo "test ping" gracefully
    if (topic.startsWith('webhooks.')) {
      return resp(200, { ok: true, note: 'pong', topic });
    }

    // Verify signature
    const expected = makeSig(SECRET, rawBody);
    if (!sig || sig !== expected) {
      return resp(401, {
        ok: false,
        reason: 'bad_signature',
        ...(debugMode ? {
          topic,
          sig_present: !!sig,
          expected_sample: expected.slice(0, 8) + '…',
        } : {})
      });
    }

    // Parse JSON
    let data;
    try { data = JSON.parse(rawBody); }
    catch { return resp(400, { ok: false, reason: 'bad_json' }); }

    // Pull fields (works for order.paid and order.updated bodies)
    const orderId = data.id || data.order_id || null;
    const email =
      (data.billing && data.billing.email) ||
      data.customer_email ||
      (data.customer && data.customer.email) ||
      null;

    // Generate key
    const key = `VMT-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`.toUpperCase();
    const plan = 'full';
    const max_devices = 2;

    // Insert license
    const { error } = await supabase
      .from('licenses')
      .insert([{ key, plan, status: 'active', max_devices, order_id: orderId, email }]);

    if (error) {
      return resp(500, { ok: false, reason: 'db_insert_failed', detail: error.message });
    }

    // (Optional) you could email the key here via your email provider webhook or WP email

    return resp(200, { ok: true, key, plan, max_devices, email, orderId });

  } catch (e) {
    return resp(500, { ok: false, reason: 'server_error', detail: String(e && e.message || e) });
  }
};

function resp(code, obj) {
  return {
    statusCode: code,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(obj)
  };
}
