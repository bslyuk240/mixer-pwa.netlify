// activate.js  -> POST { key, deviceId }
const { supabase } = require('./_supabase');

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== 'POST') return json({ ok: false, reason: 'method_not_allowed' }, 405);
    const { key, deviceId } = JSON.parse(event.body || '{}');
    if (!key || !deviceId) return json({ ok: false, reason: 'missing_params' }, 400);

    // Load license
    const { data: lic, error } = await supabase
      .from('licenses')
      .select('key, status, max_devices')
      .eq('key', key)
      .single();

    if (error || !lic) return json({ ok: false, reason: 'not_found' }, 404);
    if (lic.status !== 'active') return json({ ok: false, reason: 'revoked' }, 403);

    // Does this device already exist? If yes, just mark active + update last_seen
    const { data: existing, error: e1 } = await supabase
      .from('activations')
      .select('device_id, active')
      .eq('license_key', key)
      .eq('device_id', deviceId)
      .maybeSingle();

    if (existing && !e1) {
      await supabase
        .from('activations')
        .update({ active: true, last_seen: new Date().toISOString() })
        .eq('license_key', key)
        .eq('device_id', deviceId);

      return json({ ok: true, reused: true });
    }

    // Count total UNIQUE devices ever used
    const { data: rows, error: e2 } = await supabase
      .from('activations')
      .select('device_id')
      .eq('license_key', key);

    const uniqueCount = e2 ? 0 : new Set((rows || []).map(r => r.device_id)).size;

    if (uniqueCount >= lic.max_devices) {
      // HARD CAP: do not allow adding another unique device
      return json({ ok: false, reason: 'device_limit_reached', max_devices: lic.max_devices }, 409);
    }

    // Insert new device (consumes a slot forever)
    const { error: e3 } = await supabase
      .from('activations')
      .insert({
        license_key: key,
        device_id: deviceId,
        active: true,
        first_activated: new Date().toISOString(),
        last_seen: new Date().toISOString()
      });

    if (e3) {
      console.error(e3);
      return json({ ok: false, reason: 'db_insert_failed' }, 500);
    }

    return json({ ok: true, reused: false });
  } catch (e) {
    console.error(e);
    return json({ ok: false, reason: 'server_error' }, 500);
  }
};

function json(body, status = 200) {
  return { statusCode: status, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}
