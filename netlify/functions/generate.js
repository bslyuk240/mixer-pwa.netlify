// netlify/functions/generate.js
// Generates a license when Woo sends an order webhook,
// saves it to Supabase, and writes the key back to the Woo order.

const crypto = require("crypto");
const WooCommerceRestApi = require("@woocommerce/woocommerce-rest-api").default;
const { createClient } = require("@supabase/supabase-js");

// ---- ENV ----
const {
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY,
  WC_WEBHOOK_SECRET,
  WOOCOMMERCE_URL,
  WOOCOMMERCE_CK,
  WOOCOMMERCE_CS,
} = process.env;

// ---- CLIENTS ----
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
});

const woo = new WooCommerceRestApi({
  url: WOOCOMMERCE_URL, // e.g. https://julinemart.com
  consumerKey: WOOCOMMERCE_CK,
  consumerSecret: WOOCOMMERCE_CS,
  version: "wc/v3",
});

// ---- HELPERS ----
function json(statusCode, bodyObj, extraHeaders = {}) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      ...extraHeaders,
    },
    body: JSON.stringify(bodyObj),
  };
}

function verifySignature(rawBody, signatureBase64, secret) {
  if (!signatureBase64) return false;
  try {
    const hmac = crypto
      .createHmac("sha256", secret)
      .update(rawBody, "utf8")
      .digest("base64");
    return crypto.timingSafeEqual(
      Buffer.from(hmac),
      Buffer.from(signatureBase64)
    );
  } catch {
    return false;
  }
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

function makeKey() {
  const y = new Date().getFullYear();
  const rand = crypto.randomBytes(3).toString("hex").toUpperCase(); // 6 hex chars
  // Format similar to your existing keys
  return `Bensly-VMIX-${y}-${rand}`;
}

async function ensureUniqueKey() {
  for (let i = 0; i < 5; i++) {
    const key = makeKey();
    const { data, error } = await supabase
      .from("licenses")
      .select("key")
      .eq("key", key)
      .limit(1);

    if (error) throw error;
    if (!data || data.length === 0) return key;
  }
  throw new Error("could_not_generate_unique_key");
}

async function writeKeyToWoo(orderId, license, meta = {}) {
  // 1) custom field
  await woo.put(`orders/${orderId}`, {
    meta_data: [
      { key: "_license_key", value: license },
      { key: "_license_meta", value: JSON.stringify(meta) },
    ],
  });

  // 2) customer-visible note
  await woo.post(`orders/${orderId}/notes`, {
    note: `🎟 License generated: ${license}\nPlan: ${meta.plan || "full"} · Max devices: ${meta.max_devices ?? 2}`,
    customer_note: true, // send to customer (depends on email settings)
  });
}

function shouldGenerateForOrder(order) {
  // Only run on paid-ish statuses
  const okStatuses = new Set(["processing", "completed"]);
  if (!okStatuses.has((order?.status || "").toLowerCase())) return false;

  // If the order already has _license_key in meta, skip (idempotence)
  const hasKey = (order?.meta_data || []).some(
    (m) => m?.key === "_license_key" && String(m?.value || "").length > 0
  );
  if (hasKey) return false;

  // (Optional) Only if certain product(s) are present. Comment out if not needed.
  // const productIds = (order?.line_items || []).map((li) => li.product_id);
  // const TARGET_IDS = new Set([1234, 5678]); // put the ebook product ID(s) here
  // if (!productIds.some((id) => TARGET_IDS.has(id))) return false;

  return true;
}

// ---- HANDLER ----
exports.handler = async (event) => {
  try {
    // Health check / simple GET
    if (event.httpMethod === "GET") {
      // test mode bypasses signature & body requirements
      const isTest = event.queryStringParameters?.test === "1";
      return json(200, {
        ok: true,
        note: isTest ? "Generator ready (test mode)" : "Generator ready",
      });
    }

    if (event.httpMethod !== "POST") {
      return json(405, { ok: false, error: "method_not_allowed" });
    }

    // --- Signature check (unless test=1) ---
    const isTest = event.queryStringParameters?.test === "1";
    const rawBody = event.body || "";
    const sig = event.headers["x-wc-webhook-signature"];
    if (!isTest) {
      if (!WC_WEBHOOK_SECRET) {
        return json(500, { ok: false, error: "missing_wc_secret" });
      }
      const ok = verifySignature(rawBody, sig, WC_WEBHOOK_SECRET);
      if (!ok) {
        return json(401, { ok: false, error: "invalid_signature" });
      }
    }

    // Parse payload
    let payload;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return json(400, { ok: false, error: "invalid_json" });
    }

    const order = payload;
    const orderId = Number(order?.id || payload?.order_id || 0);
    const email =
      order?.billing?.email ||
      order?.customer_email ||
      payload?.customer_email ||
      null;

    if (!orderId) {
      return json(400, { ok: false, error: "missing_order_id" });
    }

    if (!shouldGenerateForOrder(order)) {
      return json(200, {
        ok: true,
        skipped: true,
        reason:
          "status_not_eligible_or_already_has_key_or_product_filter_not_matched",
      });
    }

    // Idempotency: already created for this order?
    const existing = await getExistingLicenseForOrder(orderId);
    if (existing?.key) {
      // still ensure Woo has it (write again if needed)
      await writeKeyToWoo(orderId, existing.key, {
        plan: existing.plan || "full",
        max_devices: existing.max_devices ?? 2,
      });
      return json(200, { ok: true, reused: true, key: existing.key });
    }

    // Make a fresh license
    const license = await ensureUniqueKey();

    // Insert into Supabase
    const row = {
      key: license,
      plan: "full",
      status: "active",
      max_devices: 2,
      email,
      order_id: orderId,
    };

    const { error: insErr } = await supabase.from("licenses").insert([row]);
    if (insErr) {
      return json(500, { ok: false, error: "db_insert_failed", detail: insErr.message });
    }

    // Write back to Woo order
    await writeKeyToWoo(orderId, license, { plan: "full", max_devices: 2 });

    return json(200, { ok: true, key: license });
  } catch (e) {
    return json(500, { ok: false, error: "server_error", detail: String(e?.message || e) });
  }
};
