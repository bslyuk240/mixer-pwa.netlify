// netlify/functions/generate.js
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");

// ---- env ----
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const WC_WEBHOOK_SECRET = process.env.WC_WEBHOOK_SECRET || "";
const WOO_URL = (process.env.WOOCOMMERCE_URL || "").replace(/\/+$/, "");
const WOO_CK = process.env.WOOCOMMERCE_CK || "";
const WOO_CS = process.env.WOOCOMMERCE_CS || "";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
});

// ---- helpers ----
const ok = (body, status = 200) => ({
  statusCode: status,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

const log = (...a) => console.log("[generate]", ...a);

function hmacValid(rawBody, signatureBase64) {
  if (!WC_WEBHOOK_SECRET) return false;
  if (!signatureBase64) return false;
  const digest = crypto
    .createHmac("sha256", WC_WEBHOOK_SECRET)
    .update(rawBody, "utf8")
    .digest("base64");
  return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(signatureBase64));
}

function makeKey() {
  // e.g. VMIX-2025-3F7C-9KQ2
  const part = () => Math.random().toString(36).toUpperCase().slice(2, 6);
  return `VMIX-${new Date().getFullYear()}-${part()}-${part()}`;
}

async function wooGet(path) {
  const url = `${WOO_URL}/wp-json/wc/v3${path}`;
  const auth = Buffer.from(`${WOO_CK}:${WOO_CS}`).toString("base64");
  const res = await fetch(url, {
    headers: { Authorization: `Basic ${auth}` },
  });
  if (!res.ok) throw new Error(`Woo GET ${path} -> ${res.status}`);
  return res.json();
}

async function wooPut(path, body) {
  const url = `${WOO_URL}/wp-json/wc/v3${path}`;
  const auth = Buffer.from(`${WOO_CK}:${WOO_CS}`).toString("base64");
  const res = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Woo PUT ${path} -> ${res.status}: ${t}`);
  }
  return res.json();
}

async function upsertLicense({ key, email, order_id }) {
  const row = {
    key,
    plan: "full",
    status: "active",
    email: email || null,
    order_id: order_id || null,
    max_devices: 2,
  };
  const { error } = await supabase.from("licenses").insert(row, { upsert: false });
  if (error) throw new Error("supabase_insert_failed: " + error.message);
  return row;
}

async function writeOrderMeta(orderId, metaKey, metaValue) {
  const order = await wooGet(`/orders/${orderId}`);
  const existing = Array.isArray(order.meta_data) ? order.meta_data : [];
  const already = existing.find((m) => m.key === metaKey);
  if (already) {
    // update in place
    already.value = metaValue;
  } else {
    existing.push({ key: metaKey, value: metaValue });
  }
  await wooPut(`/orders/${orderId}`, { meta_data: existing });
}

exports.handler = async (event) => {
  try {
    // health check
    if (event.httpMethod === "GET") {
      if (event.queryStringParameters?.ping) {
        return ok({ ok: true, note: "Generator ready" });
      }
      // Manual trigger: /generate?test_order=123&auth=SECRET
      const q = event.queryStringParameters || {};
      if (q.test_order && q.auth === WC_WEBHOOK_SECRET) {
        const testId = Number(q.test_order);
        log("manual_trigger", { testId });
        return await handleOrderId(testId);
      }
      return ok({ ok: true, usage: "POST Woo webhook payload or ?test_order=ID&auth=SECRET" });
    }

    // Webhook must be POSTed by Woo
    if (event.httpMethod !== "POST") {
      return ok({ ok: false, reason: "method_not_allowed" }, 405);
    }

    const raw = event.body || "";
    const sig = event.headers["x-wc-webhook-signature"] || event.headers["X-WC-Webhook-Signature"];
    log("incoming {");
    log("  topic:", JSON.stringify(event.headers["x-wc-webhook-topic"] || "" , null, 0) || "(none)");
    log("  hasSig:", !!sig, "sigLen:", (sig || "").length);
    log("  ua:", JSON.stringify(event.headers["user-agent"] || "?", null, 0));
    log("  bodyLen:", raw.length);
    log("}");

    // Signature required
    if (!hmacValid(raw, sig)) {
      return ok({ ok: false, reason: "unauthorized" }, 401);
    }

    const body = JSON.parse(raw);
    // Woo sends many shapes; try to grab order id/status directly
    const orderId = body?.id || body?.order_id || body?.data?.id;
    const status = (body?.status || body?.data?.status || "").toLowerCase();
    const topic = event.headers["x-wc-webhook-topic"] || "";

    log("parsed { orderId:", orderId, ", status:", status, ", topic:", topic, "}");

    // Fetch the order from Woo to be certain (also gives us email & current status)
    if (!orderId) {
      return ok({ ok: false, reason: "no_order_id" }, 400);
    }

    return await handleOrderId(orderId);
  } catch (e) {
    console.error(e);
    return ok({ ok: false, error: String(e.message || e) }, 500);
  }
};

async function handleOrderId(orderId) {
  // Pull current order
  const order = await wooGet(`/orders/${orderId}`);

  const status = (order.status || "").toLowerCase();
  const email =
    order?.billing?.email ||
    order?.shipping?.email ||
    (Array.isArray(order?.billing) ? order.billing[0]?.email : null) ||
    null;

  log("status_fetched { status:", status, "}");

  // Accept completed, processing, and on-hold (COD testing)
  const ALLOWED = new Set(["completed", "processing", "on-hold"]);
  if (!ALLOWED.has(status)) {
    log("skip_status", status);
    return ok({ ok: true, skipped: true, status });
  }

  // If order already has a key, don’t generate again
  const meta = Array.isArray(order.meta_data) ? order.meta_data : [];
  const existing = meta.find((m) => m.key === "_license_key");
  if (existing?.value) {
    log("already_has_key", existing.value);
    return ok({ ok: true, reused: true, license: existing.value });
  }

  // Generate and save
  const license = makeKey();
  await upsertLicense({ key: license, email, order_id: orderId });

  // Write back to Woo meta
  await writeOrderMeta(orderId, "_license_key", license);

  log("generated", license);
  return ok({ ok: true, license, reused: false });
}
