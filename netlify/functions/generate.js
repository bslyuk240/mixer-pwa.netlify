// netlify/functions/generate.js
// WooCommerce → Netlify → Supabase license generator
// - Always 200 for Woo "ping" (webhook save test)
// - HMAC check for real order payloads (handles base64 bodies)
// - Inserts license: plan=full, status=active, max_devices=2

const crypto = require("crypto");
const { supabase } = require("./_supabase");

const SECRET = process.env.WC_WEBHOOK_SECRET;

// ---- helpers ---------------------------------------------------------------

function toBufferFromEventBody(event) {
  if (!event || event.body == null) return Buffer.from("");
  if (event.isBase64Encoded) {
    return Buffer.from(event.body, "base64");
  }
  // Netlify gives us a UTF-8 string otherwise
  return Buffer.from(event.body, "utf8");
}

// HMAC-SHA256 in base64, like WooCommerce
function makeSignature(buf, secret) {
  return crypto.createHmac("sha256", String(secret)).update(buf).digest("base64");
}

function timingSafeEquals(a, b) {
  const ab = Buffer.from(a || "", "utf8");
  const bb = Buffer.from(b || "", "utf8");
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function newKey() {
  const chunk = () => Math.random().toString(36).slice(2, 6).toUpperCase();
  return `VMIX-${chunk()}-${chunk()}-${chunk()}`;
}

// ---- handler ---------------------------------------------------------------

exports.handler = async (event) => {
  // Simple GET health check
  if (event.httpMethod === "GET") {
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ok: true, note: "Generator ready" }),
    };
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  // Read raw bytes & JSON (if possible)
  const rawBuf = toBufferFromEventBody(event);
  let payload = null;
  try { payload = JSON.parse(rawBuf.toString("utf8") || "{}"); } catch {}

  // Header names can vary in case
  const headerSig =
    event.headers["x-wc-webhook-signature"] ||
    event.headers["X-WC-Webhook-Signature"] ||
    event.headers["x-wc-webhook-signature".toLowerCase()];

  // 1) ALLOW WOO "PING" UNCONDITIONALLY (to avoid 401s on Save)
  //    Woo sends {"webhook_id":..., "test":"ping"} when you save or “deliver sample”.
  if (payload && (payload.test === "ping" || payload.webhook_id)) {
    console.log("Woo ping received — returning 200 without signature check.");
    return { statusCode: 200, body: JSON.stringify({ ok: true, note: "Webhook ping OK" }) };
  }

  // 2) Real deliveries require secret & signature
  if (!SECRET) {
    console.error("Missing WC_WEBHOOK_SECRET in Netlify env");
    return { statusCode: 500, body: JSON.stringify({ ok: false, reason: "missing_secret" }) };
  }
  if (!headerSig) {
    return { statusCode: 401, body: JSON.stringify({ ok: false, reason: "missing_signature" }) };
  }

  const expected = makeSignature(rawBuf, SECRET);
  if (!timingSafeEquals(headerSig, expected)) {
    console.warn("Bad signature on webhook");
    return { statusCode: 401, body: JSON.stringify({ ok: false, reason: "bad_signature" }) };
  }

  // 3) At this point we have a valid Woo request (JSON order)
  const order = payload || {};
  const status = String(order.status || "").toLowerCase();
  const isPaid =
    status === "processing" || status === "completed" || status === "paid";

  if (!isPaid) {
    // Not paid yet — acknowledge but skip
    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, skipped: true, note: `status=${status}` }),
    };
  }

  // Grab customer email (if present)
  let email = order?.billing?.email || null;
  if (!email && Array.isArray(order?.meta_data)) {
    const m = order.meta_data.find(x => (x.key || "").toLowerCase().includes("email"));
    if (m) email = String(m.value || "");
  }

  const orderId = Number(order.id || order.number || Date.now());
  const key = newKey();

  const insertRow = {
    key,
    plan: "full",
    status: "active",
    max_devices: 2,
    email,
    order_id: orderId,
  };

  const { error: insErr } = await supabase.from("licenses").insert(insertRow);
  if (insErr) {
    console.error("Supabase insert error:", insErr);
    return {
      statusCode: 500,
      body: JSON.stringify({ ok: false, reason: "db_insert_failed", detail: insErr.message }),
    };
  }

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ok: true,
      created: { key, plan: "full", max_devices: 2, email, order_id: orderId },
    }),
  };
};
