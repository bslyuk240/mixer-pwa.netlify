// netlify/functions/generate.js
// Robust Woo → Netlify → Supabase license generator with order fetch + logs.

const crypto = require("crypto");
const WooCommerceRestApi = require("@woocommerce/woocommerce-rest-api").default;
const { createClient } = require("@supabase/supabase-js");

// ---- Required env vars (Netlify) ----
const {
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY,
  WC_WEBHOOK_SECRET,      // must match Woo "Secret"
  WOOCOMMERCE_URL,        // e.g. https://julinemart.com
  WOOCOMMERCE_CK,         // Woo REST ck_...
  WOOCOMMERCE_CS,         // Woo REST cs_...
} = process.env;

// ---- Clients ----
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
});

const woo = new WooCommerceRestApi({
  url: WOOCOMMERCE_URL,
  consumerKey: WOOCOMMERCE_CK,
  consumerSecret: WOOCOMMERCE_CS,
  version: "wc/v3",
});

// ---- Helpers ----
function json(statusCode, body) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

function log(...args) {
  // Will appear in Netlify Functions log
  console.log(...args);
}

function verifySignature(raw, sig, secret) {
  if (!sig) return false;
  try {
    const digest = crypto.createHmac("sha256", secret).update(raw, "utf8").digest("base64");
    return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(sig));
  } catch {
    return false;
  }
}

function makeKey() {
  const y = new Date().getFullYear();
  const rand = crypto.randomBytes(3).toString("hex").toUpperCase();
  return `Bensly-VMIX-${y}-${rand}`;
}

async function ensureUniqueKey() {
  for (let i = 0; i < 6; i++) {
    const key = makeKey();
    const { data, error } = await supabase.from("licenses").select("key").eq("key", key).limit(1);
    if (error) throw error;
    if (!data || data.length === 0) return key;
  }
  throw new Error("could_not_generate_unique_key");
}

async function getExistingLicenseForOrder(orderId) {
  const { data, error } = await supabase
    .from("licenses")
    .select("*")
    .eq("order_id", orderId)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

async function writeKeyToWoo(orderId, license, meta = {}) {
  // 1) custom field(s)
  await woo.put(`orders/${orderId}`, {
    meta_data: [
      { key: "_license_key", value: license },
      { key: "_license_meta", value: JSON.stringify(meta) },
    ],
  });

  // 2) visible note (often included in customer email depending on settings)
  await woo.post(`orders/${orderId}/notes`, {
    note: `🎟 License generated: ${license}\nPlan: ${meta.plan || "full"} · Max devices: ${meta.max_devices ?? 2}`,
    customer_note: true,
  });
}

function statusEligible(status) {
  const s = (status || "").toLowerCase();
  // Accept both processing/completed by default
  return s === "processing" || s === "completed";
}

function orderHasKey(order) {
  return (order?.meta_data || []).some((m) => m?.key === "_license_key" && String(m?.value || "").length > 0);
}

async function fetchFullOrderIfNeeded(payload) {
  // Woo “Order updated/created” webhooks usually send a full order,
  // but some sites/plugins send a short payload with only an id.
  const rawId = payload?.id ?? payload?.order_id ?? payload?.resource_id;
  const orderId = Number(rawId || 0);
  if (!orderId) return { order: null, orderId: 0 };

  // If payload already looks like a full order (has line_items/billing/status), use it.
  if (payload?.line_items && payload?.billing && payload?.status) {
    return { order: payload, orderId };
  }

  // Otherwise fetch the full order from Woo
  try {
    const { data } = await woo.get(`orders/${orderId}`);
    return { order: data, orderId };
  } catch (e) {
    log("[generate] fetch order failed:", e?.response?.data || e?.message || e);
    return { order: null, orderId };
  }
}

exports.handler = async (event) => {
  try {
    // Health check
    if (event.httpMethod === "GET") {
      const isTest = event.queryStringParameters?.test === "1";
      return json(200, { ok: true, note: isTest ? "Generator ready (test mode)" : "Generator ready" });
    }

    if (event.httpMethod !== "POST") return json(405, { ok: false, error: "method_not_allowed" });

    const isTest = event.queryStringParameters?.test === "1";
    const rawBody = event.body || "";
    const sig = event.headers["x-wc-webhook-signature"];

    if (!isTest) {
      if (!WC_WEBHOOK_SECRET) return json(500, { ok: false, error: "missing_wc_secret" });
      const ok = verifySignature(rawBody, sig, WC_WEBHOOK_SECRET);
      if (!ok) return json(401, { ok: false, error: "invalid_signature" });
    }

    // Parse payload (could be partial)
    let payload;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return json(400, { ok: false, error: "invalid_json" });
    }

    const topic = event.headers["x-wc-webhook-topic"] || "(none)";
    const delivery = event.headers["x-wc-webhook-delivery-id"] || "(none)";
    log(`[generate] topic: ${topic} delivery: ${delivery}`);

    // Get a full order object
    const { order, orderId } = await fetchFullOrderIfNeeded(payload);
    if (!order || !orderId) {
      log("[generate] no order or id:", { hasOrder: !!order, orderId });
      return json(400, { ok: false, error: "missing_order" });
    }

    // Log key fields
    log("[generate] orderId:", orderId, "status:", order.status, "has_key:", orderHasKey(order));

    // Skip rules (idempotent + status)
    if (orderHasKey(order)) {
      log("[generate] order already has _license_key; skipping");
      return json(200, { ok: true, skipped: true, reason: "already_has_key" });
    }
    if (!statusEligible(order.status)) {
      log("[generate] status not eligible, skipping:", order.status);
      return json(200, { ok: true, skipped: true, reason: "status_not_eligible" });
    }

    // Idempotency via DB
    const existing = await getExistingLicenseForOrder(orderId);
    if (existing?.key) {
      log("[generate] reusing existing key for order:", existing.key);
      await writeKeyToWoo(orderId, existing.key, {
        plan: existing.plan || "full",
        max_devices: existing.max_devices ?? 2,
      });
      return json(200, { ok: true, reused: true, key: existing.key });
    }

    // Create a new key + insert
    const email =
      order?.billing?.email ||
      order?.customer_email ||
      payload?.customer_email ||
      null;

    const key = await ensureUniqueKey();

    const row = {
      key,
      plan: "full",
      status: "active",
      max_devices: 2,
      email,
      order_id: orderId,
    };

    const { error: insErr } = await supabase.from("licenses").insert([row]);
    if (insErr) {
      log("[generate] db insert failed:", insErr);
      return json(500, { ok: false, error: "db_insert_failed", detail: insErr.message });
    }

    // Write to Woo (meta + note)
    await writeKeyToWoo(orderId, key, { plan: "full", max_devices: 2 });

    log("[generate] success for order:", orderId, "key:", key);
    return json(200, { ok: true, key });
  } catch (e) {
    log("[generate] server_error:", e?.response?.data || e?.message || e);
    return json(500, { ok: false, error: "server_error", detail: String(e?.message || e) });
  }
};
