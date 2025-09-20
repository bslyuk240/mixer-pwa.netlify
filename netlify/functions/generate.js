// functions/generate.js
const { supabase } = require('./_supabase');

exports.handler = async (event) => {
  try {
    const body = JSON.parse(event.body || "{}");
    const { email, plan } = body;

    if (!email) return { statusCode: 400, body: "Email required" };

    // create a random license key
    const newKey = "VMIX-" + Math.random().toString(36).slice(2, 10).toUpperCase();

    const { error } = await supabase
      .from("licenses")
      .insert([{ key: newKey, email, plan: plan || "full", active: true, max_devices: 1 }]);

    if (error) throw error;

    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, key: newKey })
    };

  } catch (err) {
    return { statusCode: 500, body: err.message };
  }
};
