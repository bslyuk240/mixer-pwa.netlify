// netlify/functions/activate.js
const { supabase } = require('./_supabase');

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== 'POST')
      return res({ ok: false, reason: 'method_not_allowed' }, 405);

    const { key, deviceId } = JSON.parse(event.body || '{}');
    if (!key || !deviceId)
      return res({ ok: false, reason: 'missing_params' }, 400);

    // 1) read license
    const { data: lic, error: eLic } = await supabase
      .from('licenses')
      .select('key,status,max_devices')
      .eq('key', key)
      .single();

    if (eLic || !lic) return res({ ok: false, reason: 'not_found', detail: eLic?.message });

    if (lic.status !== 'active')
      return res({ ok: false, reason: 'revoked' });

    // 2) reuse same device if it exists
    const { data: existing, error: eGet } = await supabase
      .from('activations')
      .select('device_id, active')
      .eq('license_key', key)
      .eq('device_id', deviceId)
      .maybeSingle();

    if (eGet) {
      return res({ ok: false, reason: 'db_select_failed', detail: eGet.message }, 500);
    }

    if (existing) {
      const { error: eUpd } = await supabase
        .from('activations')
        .update({ active: true, last_seen: new Date().toISOString() })
        .eq('license_key', key)
        .eq('device_id', deviceId);
      if (eUpd) return res({ ok: false, reason: 'db_update_failed', detail: eUpd.message }, 500);
      return res({ ok: true, reused: true });
    }

    // 3) enforce lifetime device cap
    const { data: rows, error: eRows } = await supabase
      .from('activations')
      .select('device_id')
      .eq('license_key', key);

    if (eRows) return res({ ok: false, reason: 'db_select_failed', detail: eRows.message }, 500);

    const used = new Set((rows || []).map(r => r.device_id)).size;
    if (used >= lic.max_devices) {
      return res({ ok: false, reason: 'device_limit_reached', max_devices: lic.max_devices }, 409);
    }

    // 4) insert new device (consumes a slot forever)
    const { error: eIns } = await supabase
      .from('activations')
      .insert({
        license_key: key,
        device_id: deviceId,
        active: true,
        first_activated: new Date().toISOString(),
        last_seen: new Date().toISOString()
      });

    if (eIns) {
      // <-- THIS WILL SHOW THE REAL CAUSE (RLS, constraint, etc.)
      return res({ ok: false, reason: 'db_insert_failed', detail: eIns.message }, 500);
    }

    return res({ ok: true, reused: false });
  } catch (err) {
    console.error(err);
    return res({ ok: false, reason: 'server_error', detail: String(err) }, 500);
  }
};

function res(body, status = 200) {
  return { statusCode: status, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}
