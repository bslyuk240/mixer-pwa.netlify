// deactivate.js  -> POST { key, deviceId }
// NOTE: does NOT free the slot. It only sets active=false.
const { supabase } = require('./_supabase');

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== 'POST') return json({ ok: false, reason: 'method_not_allowed' }, 405);
    const { key, deviceId } = JSON.parse(event.body || '{}');
    if (!key || !deviceId) return json({ ok: false, reason: 'missing_params' }, 400);

    // Make sure the row exists; then set active=false
    const { error } = await supabase
      .from('activations')
      .update({ active: false, last_seen: new Date().toISOString() })
      .eq('license_key', key)
      .eq('device_id', deviceId);

    if (error) {
      console.error(error);
      return json({ ok: false, reason: 'db_update_failed' }, 500);
    }

    return json({ ok: true });
  } catch (e) {
    console.error(e);
    return json({ ok: false, reason: 'server_error' }, 500);
  }
};

function json(body, status = 200) {
  return { statusCode: status, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}
