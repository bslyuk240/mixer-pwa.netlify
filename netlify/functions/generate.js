// netlify/functions/generate.js
exports.handler = async (event, context) => {
  // ---------- env ----------
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
  const WC_WEBHOOK_SECRET = process.env.WC_WEBHOOK_SECRET;
  const WOOCOMMERCE_URL = (process.env.WOOCOMMERCE_URL || '').replace(/\/+$/, '');
  const WOOCOMMERCE_CK = process.env.WOOCOMMERCE_CK;
  const WOOCOMMERCE_CS = process.env.WOOCOMMERCE_CS;

  // helpers
  const json = (code, body) => ({ statusCode: code, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const log = (...a) => console.log('[generate]', ...a);

  // quick ping
  if (event.httpMethod === 'GET' && (event.queryStringParameters?.ping || event.queryStringParameters?.test_order)) {
    // simple test mode: ?test_order=123&auth=YOUR_SECRET
    if (event.queryStringParameters?.test_order) {
      if (event.queryStringParameters?.auth !== WC_WEBHOOK_SECRET) {
        return json(401, { ok: false, reason: 'bad_secret' });
      }
      const orderId = parseInt(event.queryStringParameters.test_order, 10);
      const info = await ensureLicenseForOrder(orderId);
      return json(200, { ok: true, ...info });
    }
    return json(200, { ok: true, note: 'Generator ready' });
  }

  // -------------- verify WooCommerce signature --------------
  // Woo sends: X-WC-Webhook-Signature: base64(HMAC-SHA256(body, secret))
  const sig = event.headers['x-wc-webhook-signature'] || event.headers['X-WC-Webhook-Signature'];
  const bodyRaw = event.body || '';
  const hasSig = !!sig;
  let verified = false;
  if (hasSig) {
    try {
      const crypto = await import('crypto');
      const hmac = crypto.createHmac('sha256', WC_WEBHOOK_SECRET || '');
      hmac.update(bodyRaw, 'utf8');
      const digest = hmac.digest('base64');
      verified = (digest === sig);
    } catch (e) {
      log('sig error', e);
      verified = false;
    }
  }
  if (!verified) {
    // we still return 200 so Woo doesn’t hammer forever, but do nothing
    log('signature failed or missing; ignoring');
    return json(200, { ok: true, ignored: 'bad_signature' });
  }

  // -------------- parse webhook --------------
  let payload;
  try {
    payload = JSON.parse(bodyRaw);
  } catch {
    return json(200, { ok: true, ignored: 'bad_json' });
  }

  // Woo can send many event types; the body has "id" and "status"
  const orderId = Number(payload?.id);
  const status = String(payload?.status || '').toLowerCase();
  const topic = event.headers['x-wc-webhook-topic'] || '';

  log('incoming {');
  log('  topic:', `'${topic}'`, ', status:', `'${status}'`, ', id:', orderId);
  log('}');

  // guard: only process when it matters
  if (!orderId || !['processing', 'completed'].includes(status)) {
    return json(200, { ok: true, skipped: true, reason: 'status_not_ready_or_no_id', status, orderId });
  }

  // do it
  try {
    const info = await ensureLicenseForOrder(orderId);
    return json(200, { ok: true, ...info });
  } catch (e) {
    log('fatal', e);
    return json(200, { ok: false, reason: 'fatal_error' }); // 200 so Woo stops retrying
  }

  // ---------------- core worker ----------------
  async function ensureLicenseForOrder(orderId) {
    // fetch order details from Woo (to get email, and check if meta already has key)
    const order = await wooGet(`/wp-json/wc/v3/orders/${orderId}`);
    const email = order?.billing?.email || '';

    // If Woo already has a license stored, stop (idempotent).
    const existingMeta = readOrderMeta(order, '_license_key');
    if (existingMeta) {
      log('already_has_key', existingMeta);
      return { reused: true, license: existingMeta };
    }

    // Check Supabase by order_id (idempotent)
    const found = await sbSelectLicenseByOrder(orderId);
    if (found?.key) {
      // write back to Woo if missing
      await wooPostMeta(orderId, '_license_key', found.key);
      await wooAddCustomerNote(orderId, `Your license key: ${found.key}`);
      return { reused: true, license: found.key };
    }

    // Generate a fresh key
    const licenseKey = makeKey('VMIX-2025');

    // Try insert (protected by unique index on order_id). If race/duplicate happens, read existing and reuse.
    const inserted = await sbInsertLicense({ key: licenseKey, plan: 'full', status: 'active', order_id: orderId, email, max_devices: 2 });
    if (!inserted.ok && inserted.code === 'unique_violation') {
      const again = await sbSelectLicenseByOrder(orderId);
      if (again?.key) {
        await wooPostMeta(orderId, '_license_key', again.key);
        await wooAddCustomerNote(orderId, `Your license key: ${again.key}`);
        return { reused: true, license: again.key };
      }
      // fall through if not found (unlikely)
    } else if (!inserted.ok) {
      // DB insert failed for other reason → do not loop forever. Stop and let you inspect.
      log('db_insert_failed', inserted.detail || inserted);
      return { reused: false, error: 'db_insert_failed' };
    }

    // Write to Woo
    await wooPostMeta(orderId, '_license_key', licenseKey);
    await wooAddCustomerNote(orderId, `Your license key: ${licenseKey}`);

    log('generated', licenseKey);
    return { reused: false, license: licenseKey };
  }

  // ---------------- utilities ----------------
  function makeKey(prefix) {
    // VMIX-2025-XXXX-XXXX (simple human-friendly)
    const block = () => Math.random().toString(36).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
    return `${prefix}-${block()}-${block()}`;
  }

  function readOrderMeta(order, keyName) {
    const meta = Array.isArray(order?.meta_data) ? order.meta_data : [];
    const hit = meta.find(m => m?.key === keyName);
    return hit?.value || null;
  }

  async function wooGet(path) {
    const url = `${WOOCOMMERCE_URL}${path}`;
    const auth = Buffer.from(`${WOOCOMMERCE_CK}:${WOOCOMMERCE_CS}`).toString('base64');
    const res = await fetch(url, { headers: { Authorization: `Basic ${auth}` } });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      log('wooGet error', res.status, t);
      throw new Error('woo_get_failed');
    }
    return res.json();
  }

  async function wooPostMeta(orderId, key, value) {
    const url = `${WOOCOMMERCE_URL}/wp-json/wc/v3/orders/${orderId}`;
    const auth = Buffer.from(`${WOOCOMMERCE_CK}:${WOOCOMMERCE_CS}`).toString('base64');
    const body = JSON.stringify({ meta_data: [{ key, value }] });
    const res = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Basic ${auth}` }, body });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      log('wooPostMeta error', res.status, t);
      // don’t throw → we already made the key. You can re-run a repair later if needed.
    }
  }

  async function wooAddCustomerNote(orderId, note) {
    const url = `${WOOCOMMERCE_URL}/wp-json/wc/v3/orders/${orderId}/notes`;
    const auth = Buffer.from(`${WOOCOMMERCE_CK}:${WOOCOMMERCE_CS}`).toString('base64');
    const body = JSON.stringify({ note, customer_note: true });
    await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Basic ${auth}` }, body })
      .catch(() => {});
  }

  async function sbSelectLicenseByOrder(orderId) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/licenses?order_id=eq.${orderId}&select=key,order_id`, {
      headers: {
        apikey: SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
        Prefer: 'return=representation'
      }
    });
    if (!res.ok) return null;
    const rows = await res.json();
    return rows?.[0] || null;
  }

  async function sbInsertLicense(row) {
    try {
      const res = await fetch(`${SUPABASE_URL}/rest/v1/licenses`, {
        method: 'POST',
        headers: {
          apikey: SUPABASE_SERVICE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
          'Content-Type': 'application/json',
          Prefer: 'return=representation'
        },
        body: JSON.stringify(row)
      });
      if (res.ok) return { ok: true };
      const txt = await res.text().catch(() => '');
      // detect unique violation message supabase/postgrest returns
      if (/duplicate key|unique/i.test(txt)) return { ok: false, code: 'unique_violation', detail: txt };
      return { ok: false, detail: txt };
    } catch (e) {
      return { ok: false, detail: String(e) };
    }
  }
};
