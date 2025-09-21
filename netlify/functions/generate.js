// netlify/functions/generate.js
//
// What this function does:
// 1) (GET) health check -> returns {ok:true, note:"Generator ready"}
// 2) (POST) WooCommerce webhook -> verifies HMAC signature, generates a license,
//    stores it in Supabase, and writes it back to the Woo order as order meta
//    and as a customer-visible order note.

const crypto = require('crypto');
const { supabase } = require('./_supabase');

// ---- Environment variables you MUST set in Netlify (Site → Settings → Env vars) ----
// SUPABASE_URL                (already set)
// SUPABASE_SERVICE_KEY        (already set; service_role key)
// WC_WEBHOOK_SECRET           (the same secret you put in the Woo webhook form)
// WOOCOMMERCE_URL             (e.g. https://julinemart.com)
// WOOCOMMERCE_CK              (Woo REST API consumer key with read/write on orders)
// WOOCOMMERCE_CS              (Woo REST API consumer secret)
// OPTIONAL:
// PRODUCT_ID_REQUIRE (comma list of numeric product IDs; if set, webhook will only
//   issue a license if the order contains at least one of these products)
// DEBUG_ALLOW_NO_SIG = "true" (dev only: allow missing signature)

// ---- Small helpers ----
const json = (code, obj) => ({
  statusCode: code,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(obj),
});

function b64HmacSHA256(secret, payload) {
  return crypto.createHmac('sha256', secret).update(payload).digest('base64');
}

function ensureArray(a) { return Array.isArray(a) ? a : (a ? [a] : []); }

function generateLicenseKey() {
  // Example: VMIX-2025-9YH3-3KDG-8VQZ
  const seg = () => Math.random().toString(36).toUpperCase().replace(/[^A-Z0-9]/g,'').slice(2,6);
  return `VMIX-${new Date().getFullYear()}-${seg()}-${seg()}-${seg()}`;
}

// ---- Woo REST client (basic auth) ----
async function wooRequest(method, path, body) {
  const base = process.env.WOOCOMMERCE_URL;
  const ck = process.env.WOOCOMMERCE_CK;
  const cs = process.env.WOOCOMMERCE_CS;
  if (!base || !ck || !cs) {
    throw new Error('Woo REST env missing: WOOCOMMERCE_URL / CK / CS');
  }
  const url = `${base.replace(/\/+$/,'')}/wp-json/wc/v3${path}`;
  const auth = Buffer.from(`${ck}:${cs}`).toString('base64');

  const res = await fetch(url, {
    method,
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch {}
  if (!res.ok) {
    const msg = `Woo request failed ${res.status} ${res.statusText}`;
    throw new Error(msg + ' :: ' + (text || ''));
  }
  return data;
}

// ---- Main handler ----
exports.handler = async (event) => {
  try {
    // Health check
    if (event.httpMethod === 'GET') {
      return json(200, { ok: true, note: 'Generator ready' });
    }

    if (event.httpMethod !== 'POST') {
      return json(405, { ok: false, error: 'method_not_allowed' });
    }

    const rawBody = event.body || '';
    const sigHeader = event.headers['x-wc-webhook-signature'] || event.headers['X-WC-Webhook-Signature'];
    const secret = process.env.WC_WEBHOOK_SECRET || '';
    const allowNoSig = (process.env.DEBUG_ALLOW_NO_SIG || '').toLowerCase() === 'true';

    // Verify Woo signature (HMAC SHA256 base64 of raw body with secret)
    if (!sigHeader && !allowNoSig) {
      return json(401, { ok: false, error: 'missing_signature' });
    }
    if (sigHeader && secret) {
      const expected = b64HmacSHA256(secret, rawBody);
      if (sigHeader !== expected) {
        return json(401, { ok: false, error: 'signature_mismatch' });
      }
    }

    // Parse the Woo payload (order object)
    let payload;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return json(400, { ok: false, error: 'invalid_json' });
    }

    const orderId = payload.id || payload.order_id || payload.number;
    const email =
      payload.billing?.email ||
      payload.customer?.email ||
      payload.customer_email ||
      null;

    if (!orderId) {
      return json(400, { ok: false, error: 'no_order_id' });
    }

    // If you only want to issue keys for specific products, enforce here
    const productFilter = (process.env.PRODUCT_ID_REQUIRE || '').trim();
    if (productFilter) {
      const requiredIds = productFilter.split(',').map(s => parseInt(s.trim(), 10)).filter(Boolean);
      const line = ensureArray(payload.line_items);
      const found = line.some(li => li?.product_id && requiredIds.includes(Number(li.product_id)));
      if (!found) {
        // Not a product we generate a license for.
        return json(200, { ok: true, skipped: true, reason: 'product_not_required' });
      }
    }

    // 1) Reuse if this order already has a license
    const existing = await supabase
      .from('licenses')
      .select('*')
      .eq('order_id', orderId)
      .limit(1)
      .maybeSingle();

    if (existing.error) {
      return json(500, { ok: false, reason: 'db_select_failed', detail: existing.error.message });
    }

    let licenseRow = existing.data;
    if (!licenseRow) {
      // 2) Create a new license
      const key = generateLicenseKey();
      const ins = await supabase
        .from('licenses')
        .insert([{
          key,
          plan: 'full',
          status: 'active',
          max_devices: 2,
          email: email || null,
          order_id: orderId,
        }])
        .select()
        .single();

      if (ins.error) {
        return json(500, { ok: false, reason: 'db_insert_failed', detail: ins.error.message });
      }
      licenseRow = ins.data;
    }

    const licenseKey = licenseRow.key;

    // 3) Write back into Woo order meta as _license_key
    try {
      await wooRequest('PUT', `/orders/${orderId}`, {
        meta_data: [{ key: '_license_key', value: licenseKey }],
      });
    } catch (e) {
      // not fatal — still return ok, but include warning
      console.warn('Failed to write order meta:', e?.message || e);
    }

    // 4) Also add a customer-visible order note (nice UX)
    try {
      await wooRequest('POST', `/orders/${orderId}/notes`, {
        note: `Your license key: ${licenseKey}\n\nKeep this safe. You can activate in the app via the "Enter license key" field.`,
        customer_note: true,
      });
    } catch (e) {
      console.warn('Failed to add order note:', e?.message || e);
    }

    return json(200, {
      ok: true,
      order_id: orderId,
      email: email || null,
      license_key: licenseKey,
      reused: !!existing.data,
    });
  } catch (err) {
    return json(500, { ok: false, error: 'unhandled', detail: String(err?.message || err) });
  }
};
