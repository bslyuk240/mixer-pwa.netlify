// netlify/functions/generate.js
// Verifies WooCommerce webhook signature, then creates a license in Supabase.

const crypto = require("crypto");
const { supabase } = require("./_supabase");

// ===== Helpers =====
function base64HmacSHA256(secret, rawBodyBuffer) {
  return crypto.createHmac("sha256", secret).update(rawBodyBuffer).digest("base64");
}

function response(status, bodyObj) {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(bodyObj),
  };
}

// Build a simple license key (feel free to change format)
function makeKey() {
  const a = Date.now().toString(36).toUpperCase();
  const b = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `VMIX-${a}-${b}`;
}

exports.handler = async (event) => {
  // Health check
  if (event.httpMethod === "GET") {
    return response(200, { ok: true, note: "Generator ready" });
  }

  // POST from Woo
  if (event.httpMethod !== "POST") {
    return response(405, { ok: false, error: "method_not_allowed" });
  }

  const secret = process.env.WC_WEBHOOK_SECRET;
  if (!secret) {
    console.error("Missing WC_WEBHOOK_SECRET in Netlify env");
    return response(500, { ok: false, error: "server_misconfigured" });
  }

  // IMPORTANT: use the raw body bytes exactly as Woo sent them
  const isBase64 = event.isBase64Encoded;
  const rawBodyBuf = isBase64
    ? Buffer.from(event.body || "", "base64")
    : Buffer.from(event.body || "", "utf8");

  // Woo sends signature in this header
  const provided = event.headers["x-wc-webhook-signature"] || event.headers["X-Wc-Webhook-Signature"];
  const topic     = event.headers["x-wc-webhook-topic"] || event.headers["X-Wc-Webhook-Topic"];
  const delivery  = event.headers["x-wc-webhook-delivery-id"] || event.headers["X-Wc-Webhook-Delivery-Id"];

  // Optional debug bypass (ONLY set this temporarily in Netlify if you need it)
  const allowBypass = process.env.WC_BYPASS_SIG === "1";

  // Compute the expected signature
  const expected = base64HmacSHA256(secret, rawBodyBuf);

  // Log minimal info for debugging (never log your secret)
  console.log("[generate] topic:", topic || "(none)", "delivery:", delivery || "(none)");
  console.log("[generate] provided sig len:", provided ? provided.length : 0, "expected sig len:", expected.length);

  if (!allowBypass) {
    if (!provided) {
      return response(401, { ok: false, error: "missing_signature" });
    }
    if (provided !== expected) {
      // You’ll see these lengths in Netlify logs to confirm mismatch
      return response(401, { ok: false, error: "bad_signature" });
    }
  } else {
    console.warn("[generate] WARNING: signature check bypassed (WC_BYPASS_SIG=1).");
  }

  // Parse JSON body after signature check
  let payload;
  try {
    payload = JSON.parse(rawBodyBuf.toString("utf8"));
  } catch (e) {
    console.error("JSON parse failed:", e);
    return response(400, { ok: false, error: "bad_json" });
  }

  // Pull email & order id in a Woo-agnostic way
  const orderId = payload.id || payload.order_id || null;
  const email =
    payload?.billing?.email ||
    payload?.customer_email ||
    payload?.customer?.email ||
    payload?.payer_email ||
    null;

  if (!email) {
    // Not fatal, but useful to know
    console.warn("No email found in webhook payload");
  }

  // Make the license
  const key = makeKey();

  // Insert into Supabase
  const row = {
    key,
    plan: "full",
    status: "active",
    max_devices: 2,
    email,
    order_id: orderId,
    created_at: new Date().toISOString(),
  };

  try {
    const { data, error } = await supabase.from("licenses").insert(row).select().single();
    if (error) {
      console.error("Supabase insert error:", error);
      return response(500, { ok: false, error: "db_insert_failed" });
    }
    console.log("License created:", data?.key, "order:", orderId);
  } catch (e) {
    console.error("Supabase exception:", e);
    return response(500, { ok: false, error: "db_exception" });
  }

  // Return 200 so Woo marks webhook delivery as successful
  return response(200, {
    ok: true,
    key,
    plan: "full",
    note: "License generated",
  });
};
