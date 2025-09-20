// netlify/functions/generate.js
// Robust WooCommerce → Netlify webhook that:
// - Replies 200 to Woo "ping" tests (no signature needed)
// - Verifies HMAC signature for real order payloads
// - Creates a license row in Supabase (max 2 devices, no expiry)

const crypto = require("crypto");
const { supabase } = require("./_supabase");

const SECRET = process.env.WC_WEBHOOK_SECRET;

// HMAC-SHA256 base64, same as WooCommerce
function makeSignature(rawBody, secret) {
  return crypto.createHmac("sha256", String(secret)).update(rawBody).digest("base64");
}

// Simple key generator: VMIX-XXXX-XXXX-XXXX
function newKey() {
  const chunk = () => Math.random().toString(36).slice(2, 6).toUpperCase();
  return `VMIX-${chunk()}-${chunk()}-${chunk()}`;
}

exports.handler = async (event) => {
  // Health check in browser
  if (event.httpMethod === "GET") {
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ok: true, note: "Generator ready" })
    };
  }

  // Only accept POSTs from Woo
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  const raw = event.body || "";
  let payload = null;

  // Try to parse JSON (Woo sends JSON)
  try {
    payload = JSON.parse(raw || "{}");
  } catch {
    // If we can’t parse, but it’s Woo's ping, still reply 200 below
  }

  const headerSig =
    event.headers["x-wc-webhook-signature"] ||
    event.headers["X-WC-Webhook-Signature"];

  // 1) Allow Woo's "ping" when saving the webhook (often no useful body/signature)
  //    Woo typically sends {"webhook_id": ..., "test":"ping"}
  if ((payload && (payload.test === "ping" || payload.webhook_id)) && !headerSig) {
    return { statusCode: 200, body: JSON.stringify({ ok: true, note: "Webhook ping OK" }) };
  }

  // 2) For real deliveries we require both secret & signature
  if (!SECRET) {
    return { statusCode: 500, body: JSON.stringify({ ok: false, reason: "missing_secret" }) };
  }
  if (!headerSig) {
    // Missing signature → unauthorized
    return { statusCode: 401, body: JSON.stringify({ ok: false, reason: "missing_signature" }) };
  }

  // Verify signature
  const expected = makeSignature(raw, SECRET);
  if (headerSig !== expected) {
    return { statusCode: 401, body: JSON.stringify({ ok: false, reason: "bad_signature" }) };
  }

  // At this point, it’s a valid Woo request.
  // Woo sends the full order as the payload (for order.updated / order.paid topics).
  // We’ll only act if the order is paid/processing/completed.
  const order = payload || {};
  const status = (order.status || "").toLowerCase();

  const isPaid =
    status === "processing" || status === "completed" || status === "paid";

  // If it’s not a paid status, acknowledge but do nothing.
  if (!isPaid) {
    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, skipped: true, note: `status=${status}` })
    };
  }

  // Pull an email if possible
  let email = order.billing && order.billing.email ? String(order.billing.email) : null;
  if (!email && Array.isArray(order.meta_data)) {
    const metaEmail = order.meta_data.find(m => (m.key || "").toLowerCase().includes("email"));
    if (metaEmail) email = String(metaEmail.value || "");
  }

  const orderId = Number(order.id || order.number || Date.now());

  // Generate a license key
  const key = newKey();

  // Insert into Supabase: licenses
  // columns we use: key (PK), plan, status, max_devices, email, order_id
  const insert = {
    key,
    plan: "full",
    status: "active",
    max_devices: 2,
    email,
    order_id: orderId
  };

  const { error: insErr } = await supabase.from("licenses").insert(insert);

  if (insErr) {
    return {
      statusCode: 500,
      body: JSON.stringify({ ok: false, reason: "db_insert_failed", detail: insErr.message })
    };
  }

  // Optionally, you could email the key from here or just rely on your store’s order email.
  return {
    statusCode: 200,
    body: JSON.stringify({
      ok: true,
      created: { key, plan: "full", max_devices: 2, email, order_id: orderId }
    })
  };
};
