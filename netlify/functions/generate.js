// netlify/functions/generate.js
// No external deps: uses Node's crypto + fetch and your local _supabase helper.

const crypto = require("crypto");
const { supabase } = require("./_supabase");

// ---- helpers ---------------------------------------------------------------

function ok(body) {
  return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}
function err(code, body) {
  return { statusCode: code, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

function safeEq(a, b) {
  // constant-time-ish compare to avoid length leaks
  try {
    const A = Buffer.from(String(a) ?? "");
    const B = Buffer.from(String(b) ?? "");
    if (A.length !== B.length) return false;
    return crypto.timingSafeEqual(A, B);
  } catch {
    return a === b;
  }
}

function makeKey() {
  // e.g. JMNX-VMIX-AB12-CD34-EF56
  const chunk = () => crypto.randomBytes(2).toString("hex").toUpperCase();
  return `JMNX-VMIX-${chunk()}-${chunk()}-${chunk()}`;
}

async function makeUniqueKey() {
  for (let i = 0; i < 6; i++) {
    const key = makeKey();
    const { data, error } = await supabase.from("licenses").select("key").eq("key", key).maybeSingle();
    if (error) throw new Error("db_check_failed: " + error.message);
    if (!data) return key;
  }
  throw new Error("could_not_generate_unique_key");
}

// ---- main handler ----------------------------------------------------------

exports.handler = async (event) => {
  // Simple GET to confirm function is alive
  if (event.httpMethod === "GET") return ok({ ok: true, note: "Generator ready" });

  // Only accept POST from Woo
  if (event.httpMethod !== "POST") return err(405, { ok: false, error: "method_not_allowed" });

  // 1) Verify webhook signature
  const secret = process.env.WC_WEBHOOK_SECRET;
  if (!secret) return err(500, { ok: false, error: "missing_netlify_env: WC_WEBHOOK_SECRET" });

  const raw = event.body || "";
  const provided = event.headers["x-wc-webhook-signature"] || event.headers["X-WC-Webhook-Signature"];
  const expected = crypto.createHmac("sha256", secret).update(raw).digest("base64");
  if (!safeEq(provided, expected)) {
    return err(401, { ok: false, error: "bad_signature" });
  }

  // 2) Parse order payload
  let order;
  try {
    order = JSON.parse(raw);
  } catch {
    return err(400, { ok: false, error: "invalid_json" });
  }

  // Woo can send different shapes; handle both common cases
  const orderId = order?.id ?? order?.order_id;
  const status = (order?.status || "").toLowerCase();
  const email = order?.billing?.email || order?.customer_email || null;

  // only proceed for "paid" statuses
  if (!orderId) return err(400, { ok: false, error: "missing_order_id" });
  if (!["processing", "completed"].includes(status)) {
    return ok({ ok: true, skipped: true, reason: "status_not_paid", status });
  }

  // 3) Generate + store license
  let key;
  try {
    key = await makeUniqueKey();
    const { error: insErr } = await supabase.from("licenses").insert([
      {
        key,
        plan: "full",
        status: "active",
        max_devices: 2,
        email,
        order_id: orderId,
      },
    ]);
    if (insErr) return err(500, { ok: false, error: "db_insert_failed", detail: insErr.message });
  } catch (e) {
    return err(500, { ok: false, error: "key_generation_failed", detail: String(e.message || e) });
  }

  // 4) Write the license back to the WooCommerce order meta so it appears in admin/emails
  const wooUrl = (process.env.WOOCOMMERCE_URL || "").replace(/\/+$/, ""); // no trailing slash
  const ck = process.env.WOOCOMMERCE_CK;
  const cs = process.env.WOOCOMMERCE_CS;
  if (!wooUrl || !ck || !cs) {
    // Not fatal for the customer—license is created; just report warning
    return ok({ ok: true, key, orderId, warn: "missing_woo_creds_no_meta_write" });
  }

  try {
    const auth = Buffer.from(`${ck}:${cs}`).toString("base64");
    const res = await fetch(`${wooUrl}/wp-json/wc/v3/orders/${orderId}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Basic ${auth}`,
      },
      body: JSON.stringify({
        meta_data: [{ key: "_license_key", value: key }],
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return ok({
        ok: true,
        key,
        orderId,
        meta_write: false,
        meta_status: res.status,
        meta_body: text?.slice(0, 500),
      });
    }
  } catch (e) {
    return ok({ ok: true, key, orderId, meta_write: false, meta_error: String(e.message || e) });
  }

  return ok({ ok: true, key, orderId, meta_write: true });
};
