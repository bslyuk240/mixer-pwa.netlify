// netlify/functions/generate.js
// End-to-end Woo ⟶ Netlify ⟶ Supabase ⟶ Woo (order meta) with diagnostics & safe fallbacks.
// No external packages.

const crypto = require("crypto");
const { supabase } = require("./_supabase");

// ---------- response helpers ----------
const JSON_HEADERS = { "Content-Type": "application/json" };
const ok  = (b) => ({ statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify(b) });
const bad = (c,b) => ({ statusCode: c,   headers: JSON_HEADERS, body: JSON.stringify(b) });

// ---------- utils ----------
function safeEq(a, b) {
  try {
    const A = Buffer.from(String(a) ?? "");
    const B = Buffer.from(String(b) ?? "");
    if (A.length !== B.length) return false;
    return crypto.timingSafeEqual(A, B);
  } catch { return a === b; }
}

function chunk() { return crypto.randomBytes(2).toString("hex").toUpperCase(); }
function makeKey() { return `JMNX-VMIX-${chunk()}-${chunk()}-${chunk()}`; }

async function makeUniqueKey() {
  for (let i = 0; i < 7; i++) {
    const candidate = makeKey();
    const { data, error } = await supabase
      .from("licenses").select("key").eq("key", candidate).maybeSingle();
    if (error) throw new Error("db_check_failed: " + error.message);
    if (!data) return candidate;
  }
  throw new Error("could_not_generate_unique_key");
}

function log(...args){ try{ console.info("[generate]", ...args); }catch{} }

// ---------- Woo helpers ----------
function basicAuthHeader(ck, cs) {
  return "Basic " + Buffer.from(`${ck}:${cs}`).toString("base64");
}

async function fetchWooOrder(wooBase, ck, cs, orderId) {
  const res = await fetch(`${wooBase}/wp-json/wc/v3/orders/${orderId}`, {
    headers: { Authorization: basicAuthHeader(ck, cs) }
  });
  if (!res.ok) throw new Error("woo_fetch_order_failed: " + res.status);
  return res.json();
}

// ---------- main ----------
exports.handler = async (event) => {
  const DEBUG = process.env.DEBUG_WEBHOOK === "1";
  const FORCE_WRITE = process.env.FORCE_WRITE === "1";

  if (event.httpMethod === "GET") {
    return ok({ ok: true, note: "Generator ready" });
  }
  if (event.httpMethod !== "POST") {
    return bad(405, { ok: false, error: "method_not_allowed" });
  }

  const raw = event.body || "";
  const hdr = event.headers || {};
  const ua = (hdr["user-agent"] || "").toLowerCase();
  const topic = (hdr["x-wc-webhook-topic"] || "").toLowerCase();
  const sig = hdr["x-wc-webhook-signature"] || hdr["X-WC-Webhook-Signature"];

  if (DEBUG) {
    log("incoming", {
      topic,
      hasSig: !!sig,
      sigLen: (sig||"").length,
      ua,
      bodyLen: raw.length
    });
  }

  // Let Woo save the webhook config (ping comes without signature sometimes)
  const looksLikeWoo = ua.includes("woocommerce") || !!hdr["x-wc-webhook-source"];
  if (!sig && looksLikeWoo) {
    if (DEBUG) log("verification_ping_ok");
    return ok({ ok: true, note: "verification_ping_ok" });
  }

  // Signature verify for real events
  const secret = process.env.WC_WEBHOOK_SECRET;
  if (!secret) return bad(500, { ok: false, error: "missing_env_wc_webhook_secret" });

  const expected = crypto.createHmac("sha256", secret).update(raw).digest("base64");
  if (!safeEq(sig || "", expected)) {
    if (DEBUG) log("bad_signature");
    return bad(401, { ok: false, error: "bad_signature" });
  }

  // Parse order payload
  let order;
  try { order = JSON.parse(raw); }
  catch { return bad(400, { ok: false, error: "invalid_json" }); }

  let orderId = order?.id ?? order?.order_id;
  let status  = (order?.status || "").toLowerCase();
  const email = order?.billing?.email || order?.customer_email || null;

  if (DEBUG) log("parsed", { orderId, status, email });

  if (!orderId) return bad(400, { ok: false, error: "missing_order_id" });

  // If status missing or not paid states, try fetching the order to confirm
  const wooBase = (process.env.WOOCOMMERCE_URL || "").replace(/\/+$/, "");
  const ck = process.env.WOOCOMMERCE_CK;
  const cs = process.env.WOOCOMMERCE_CS;

  if ((!status || !["processing","completed"].includes(status)) && wooBase && ck && cs) {
    try {
      const full = await fetchWooOrder(wooBase, ck, cs, orderId);
      status = (full?.status || status || "").toLowerCase();
      if (!orderId && full?.id) orderId = full.id;
      if (!email && full?.billing?.email) full.billing.email;
      if (DEBUG) log("status_fetched", { status });
    } catch (e) {
      if (DEBUG) log("woo_fetch_order_failed", String(e.message || e));
    }
  }

  if (!FORCE_WRITE && !["processing","completed"].includes(status)) {
    if (DEBUG) log("skipping_status", status);
    return ok({ ok: true, skipped: true, reason: "status_not_paid", status });
  }

  // Create + store license
  let key;
  try {
    key = await makeUniqueKey();
    const { error: insErr } = await supabase.from("licenses").insert([{
      key,
      plan: "full",
      status: "active",
      max_devices: 2,
      email,
      order_id: orderId,
    }]);
    if (insErr) {
      if (DEBUG) log("db_insert_failed", insErr.message);
      return bad(500, { ok: false, error: "db_insert_failed", detail: insErr.message });
    }
    if (DEBUG) log("license_created", { key });
  } catch (e) {
    if (DEBUG) log("key_generation_failed", String(e.message || e));
    return bad(500, { ok: false, error: "key_generation_failed", detail: String(e.message || e) });
  }

  // Write key back to Woo (order meta)
  if (!wooBase || !ck || !cs) {
    if (DEBUG) log("meta_write_skipped_missing_creds");
    return ok({ ok: true, key, orderId, meta_write: false, warn: "missing_woo_creds" });
  }

  try {
    const res = await fetch(`${wooBase}/wp-json/wc/v3/orders/${orderId}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "Authorization": basicAuthHeader(ck, cs),
      },
      body: JSON.stringify({ meta_data: [{ key: "_license_key", value: key }] }),
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      if (DEBUG) log("meta_write_failed", res.status, txt.slice(0, 300));
      return ok({ ok: true, key, orderId, meta_write: false, meta_status: res.status, meta_body: txt.slice(0, 500) });
    }
    if (DEBUG) log("meta_write_ok");
    return ok({ ok: true, key, orderId, meta_write: true });

  } catch (e) {
    if (DEBUG) log("meta_write_error", String(e.message || e));
    return ok({ ok: true, key, orderId, meta_write: false, meta_error: String(e.message || e) });
  }
};
