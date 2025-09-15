const { supabase } = require('./_supabase');

function cors(body, statusCode = 200) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type'
    },
    body: JSON.stringify(body),
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return cors({});
  if (event.httpMethod !== 'POST') return cors({ error: 'Method Not Allowed' }, 405);

  const { key, deviceId } = JSON.parse(event.body || '{}');
  if (!key || !deviceId) return cors({ ok: false, reason: 'missing_params' });

  const { data: lic, error } = await supabase
    .from('licenses')
    .select('*')
    .eq('key', key)
    .single();

  if (error || !lic || lic.status !== 'active') return cors({ ok: false, reason: 'invalid' });
  if (lic.expires && new Date(lic.expires) < new Date()) return cors({ ok: false, reason: 'expired' });

  // Upsert activation for this device
  await supabase
    .from('activations')
    .upsert(
      { license_key: key, device_id: deviceId, last_seen: new Date().toISOString() },
      { onConflict: 'license_key,device_id' }
    );

  // Count unique devices after upsert
  const { count } = await supabase
    .from('activations')
    .select('*', { count: 'exact', head: true })
    .eq('license_key', key);

  if ((count || 0) > (lic.max_devices || 1)) {
    return cors({ ok: false, reason: 'device_limit' });
  }

  return cors({ ok: true, plan: lic.plan, expires: lic.expires });
};
