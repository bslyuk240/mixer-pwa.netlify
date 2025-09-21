// netlify/functions/generate.js
// Generates a license ONLY for allowed products (by ID or SKU).
// Writes the key back into Woo (order meta + customer note).

const crypto = require("crypto");

const {
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY,
  WC_WEBHOOK_SECRET,
  WOOCOMMERCE_URL,
  WOOCOMMERCE_CK,
  WOOCOMMERCE_CS,
  ALLOWED_PRODUCT_IDS,   // e.g. "716,717"
  ALLOWED_PRODUCT_SKUS,  // e.g. "VMT-EBOOK"
} = process.env;

// ---------- Helpers ----------
function parseCsvInts(val) {
  if (!val) return [];
  return String(val)
    .split(",")
    .map(s => parseInt(s.trim(), 10))
    .filter(n => Number.isFinite(n));
}
function parseCsvStrings(val) {
  if (!val) return [];
  return String(val)
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);
}
const ALLOWED_IDS = parseCsvInts(ALLOWED_PRODUCT_IDS);
const ALLOWED_SKUS = parseCsvStrings(ALLOWED_PRODUCT_SKUS);

function shouldProcessOrder(order) {
  // If no filters configured, allow all (backward compatible)
  if (ALLOWED_IDS.length === 0 && ALLOWED_SKUS.length === 0) return true;

  const items = order?.line_items || [];
  for (const li of items) {
    const id = Number(li?.product_id);
    const sku = (li?.sku || "").trim();
    if (ALLOWED_IDS.includes(id)) return true;
    if (sku && ALLOWED_SKUS.includes(sku)) return true;
  }
  return false;
}

// Minimal Supabase call
function sb(path, init = {}) {
  const url = `${SUPABASE_URL}/rest/v1${path}`;
  const headers = {
    apikey: SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    "Content-Type": "application/json",
    Prefer: "return=representation",
    ...init.headers,
  };
  return fetch(url, { ...init, headers });
}

// Key generator
function makeKey() {
  const rand = () =>
    crypto.randomBytes(2).toString("hex").toUpperCase().replace(/[^A-Z0-9]/g, "");
  return `VMIX-2025-${rand().slice(0, 4)}-${rand().slice(0, 4)}`;
}

// Woo helpers
function wooHeaders(extra = {}) {
  const token = Buffer.from(`${WOOCOMMERCE_CK}:${WOOCOMMERCE_CS}`).toString("base64");
  return { Authorization: `Basic ${token}`, "Content-Type": "application/json", ...extra };
}
async function fetchWooOrder(orderId) {
  const res = await fetch(
    `${WOOCOMMERCE_URL.replace(/\/$/, "")}/wp-json/wc/v3/orders/${orderId}`,
    { headers: wooHeaders() }
  );
  const txt = await res.text();
  if (!res.ok) {
    console.log("[generate] woo_fetch_order_failed", res.status, txt);
    throw new Error(`Woo fetch order failed: ${res.status}`);
  }
  try { return JSON.parse(txt); } catch { return {}; }
}
async function updateWooOrderMeta(orderId, licenseKey) {
  const body = JSON.stringify({ meta_data: [{ key: "_license_key", value: licenseKey }] });
  const res = await fetch(
    `${WOOCOMMERCE_URL.replace(/\/$/, "")}/wp-json/wc/v3/orders/${orderId}`,
    { method: "PUT", headers: wooHeaders(), body }
  );
  const text = await res.text();
  console.log("[generate] woo_update_meta_res", res.status, text);
  return res.ok;
}
async function addWooCustomerNote(orderId, licenseKey) {
  const note = `Your Virtual Mixer Trainer license key:\n\n${licenseKey}\n\nKeep this safe. Enter it in the app to unlock Full mode.`;
  const body = JSON.stringify({ note, customer_note: true });
  const res = await fetch(
    `${WOOCOMMERCE_URL.replace(/\/$/, "")}/wp-json/wc/v3/orders/${orderId}/notes`,
    { method: "POST", headers: wooHeaders(), body }
  );
  const text = await res.text();
  console.log("[generate] woo_add_note_res", res.status, text);
  return res.ok;
}

// Woo webhook signature
function isValidSignature(rawBody, sigHeader) {
  try {
    if (!sigHeader || !WC_WEBHOOK_SECRET) return false;
    const digest = crypto.createHmac("sha256", WC_WEBHOOK_SECRET)
      .update(rawBody, "utf8")
      .digest("base64");
    return crypto.timingSafeEqual(Buffer.from(sigHeader), Buffer.from(digest));
  } catch { return false; }
}

// ---------- Handler ----------
exports.handler = async (event) => {
  try {
    // Health check
    if (event.httpMethod === "GET") {
      if (event.queryStringParameters?.ping) {
        return { statusCode: 200, headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ok: true, note: "Generator ready" }) };
      }
    }

    const rawBody = event.body || "";
    const sig = event.headers["x-wc-webhook-signature"];
    const qs = event.queryStringParameters || {};

    // Manual test: /generate?test_order=123&auth=<secret>
    let orderId = null;
    if (qs.test_order && qs.auth === WC_WEBHOOK_SECRET) {
      orderId = parseInt(qs.test_order, 10);
      console.log("[generate] manual_test", { orderId });
    } else {
      // Real webhook
      console.log("[generate] incoming", {
        topic: event.headers["x-wc-webhook-topic"] || "(none)",
        hasSig: !!sig,
        sigLen: sig ? sig.length : 0,
        ua: event.headers["user-agent"],
        bodyLen: rawBody.length,
      });
      if (!isValidSignature(rawBody, sig)) {
        console.log("[generate] invalid_signature");
        return { statusCode: 401, body: "Invalid signature" };
      }
      let payload; try { payload = JSON.parse(rawBody); } catch { payload = {}; }
      orderId = payload?.id || payload?.order_id || payload?.resource_id;
      if (!orderId) return { statusCode: 400, body: "Missing order id" };
    }

    // 1) Fetch full order from Woo
    const order = await fetchWooOrder(orderId);
    console.log("[generate] status_fetched", { status: order?.status });

    // 2) Filter: only process orders that contain allowed products
    const allowed = shouldProcessOrder(order);
    console.log("[generate] product_filter", {
      allowed,
      configured_ids: ALLOWED_IDS,
      configured_skus: ALLOWED_SKUS,
      line_items: (order?.line_items || []).map(li => ({ id: li.product_id, sku: li.sku }))
    });
    if (!allowed) {
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ok: true, skipped: true, reason: "not_target_product" }),
      };
    }

    // Buyer email (optional)
    const buyerEmail = order?.billing?.email || null;

    // 3) Reuse existing license for this order if present
    let licenseKey = null;
    {
      const res = await sb(`/licenses?order_id=eq.${orderId}&select=key,order_id`);
      const arr = (await res.json()) || [];
      if (Array.isArray(arr) && arr.length) {
        licenseKey = arr[0].key;
        console.log("[generate] already_has_key", licenseKey);
      }
    }

    // 4) If no existing key, create + store
    if (!licenseKey) {
      const newKey = makeKey();
      const ins = await sb(`/licenses`, {
        method: "POST",
        body: JSON.stringify([{
          key: newKey,
          plan: "full",
          status: "active",
          order_id: orderId,
          email: buyerEmail,
          max_devices: 2,
        }]),
      });
      const txt = await ins.text();
      if (!ins.ok) {
        console.log("[generate] db_insert_failed", txt);
        return { statusCode: 500, body: JSON.stringify({ ok: false, reason: "db_insert_failed" }) };
      }
      licenseKey = newKey;
      console.log("[generate] generated", licenseKey);
    }

    // 5) Write back to Woo (meta + customer note)
    const metaOk = await updateWooOrderMeta(orderId, licenseKey);
    const noteOk = await addWooCustomerNote(orderId, licenseKey);

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ok: true,
        license: licenseKey,
        wrote_meta: metaOk,
        wrote_note: noteOk,
      }),
    };
  } catch (e) {
    console.log("[generate] fatal", e?.message);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: e?.message }) };
  }
};
