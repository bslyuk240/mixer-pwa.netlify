// netlify/functions/generate.js
// Generates a license on WooCommerce webhook (order paid/updated).
// - Accepts GET (for health check) => 200
// - Verifies HMAC signature from Woo on POST using WC_WEBHOOK_SECRET
// - Gracefully handles Woo's initial "ping" or test payloads

const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");

// env
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const WC_WEBHOOK_SECRET = process.env.WC_WEBHOOK_SECRET;

// supabase client (service role)
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
});

// small helpers
const json = (status, body) => ({
  statusCode: status,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

// Verify Woo signature using RAW body string (must NOT stringify again!)
function verifyWooSignature(headers, rawBody) {
  try {
    const sigHeader =
      headers["x-wc-webhook-signature"] ||
      headers["X-WC-Webhook-Signature"] ||
      headers["x-wc-webhook-signature".toLowerCase()];

    if (!sigHeader || !WC_WEBHOOK_SECRET) return false;

    const computed = crypto
      .createHmac("sha256", WC_WEBHOOK_SECRET)
      .update(rawBody || "")
      .digest("base64");

    // timing-safe compare
    const a = Buffer.from(sigHeader);
    const b = Buffer.from(computed);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// Simple key generator
function makeKey(prefix = "VMIX") {
  const rnd = Math.random().toString(36).slice(2, 6).toUpperCase();
  const y = new Date().getFullYear();
  return `Bensly-${prefix}-${y}-${rnd}`;
}

// Insert license into DB
async function createLicense({ email, order_id }) {
  const key = makeKey("VMIX");
  const row = {
    key,
    plan: "full",
    status: "active",
    max_devices: 2,
    email: email || null,
    order_id: order_id || null,
    // expires_date: null  // leave null for no expiry
  };
  const { error } = await supabase.from("licenses").insert(row);
  if (error) throw error;
  return { key, plan: "full" };
}

exports.handler = async (event, context) => {
  // Health check
  if (event.httpMethod !== "POST") {
    return json(200, { ok: true, note: "Generator ready" });
  }

  const raw = event.body || "";

  // Verify signature (Woo sends one when you save/test)
  const okSig = verifyWooSignature(event.headers || {}, raw);
  if (!okSig) {
    // Return 401 so Woo shows “401” when secret doesn’t match
    return json(401, { ok: false, reason: "bad_signature" });
  }

  // Try parse JSON
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (e) {
    return json(400, { ok: false, reason: "bad_json", detail: e.message });
  }

  // Woo sends different shapes. Handle “ping/test” gracefully.
  // If there’s no order info, just acknowledge.
  const order = payload?.data?.order || payload?.order || null;

  // If this is clearly a ping (no order), reply 200 so Woo can save the webhook
  if (!order) {
    return json(200, { ok: true, note: "ping_ack" });
  }

  // Decide if we should issue a key (e.g., order status completed/processing/paid)
  const status = (order.status || "").toLowerCase();
  const allowed = ["completed", "processing", "paid"];
  if (!allowed.includes(status)) {
    // Not a paid/completed state; no key issued.
    return json(200, { ok: true, skipped: true, status });
  }

  // Grab buyer email + order id if available
  const email =
    order.billing?.email ||
    payload?.data?.billing?.email ||
    payload?.billing?.email ||
    null;

  const order_id =
    order.id || payload?.data?.order_id || payload?.id || null;

  try {
    const lic = await createLicense({ email, order_id });
    return json(200, { ok: true, issued: lic });
  } catch (e) {
    return json(500, { ok: false, reason: "db_insert_failed", detail: e.message });
  }
};
