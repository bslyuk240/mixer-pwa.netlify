// verify.js  -> GET /.netlify/functions/verify?key=XXXX
const { supabase } = require('./_supabase');

exports.handler = async (event) => {
  try {
    const key = (event.queryStringParameters?.key || '').trim();
    if (!key) return json({ valid: false, reason: 'missing_key' }, 400);

    const { data: lic, error } = await supabase
      .from('licenses')
      .select('key, plan, status, max_devices')
      .eq('key', key)
      .single();

    if (error || !lic) return json({ valid: false, reason: 'not_found' }, 404);
    if (lic.status !== 'active') return json({ valid: false, reason: 'revoked' }, 403);

    // Count distinct devices that have ever activated this key
    const { data: rows, error: e2 } = await supabase
      .from('activations')
      .select('device_id')
      .eq('license_key', key);

    const uniqueCount = e2 ? 0 : new Set((rows || []).map(r => r.device_id)).size;

    return json({
      valid: true,
      plan: lic.plan,
      status: lic.status,
      max_devices: lic.max_devices,
      devices_used: uniqueCount
    });
  } catch (e) {
    console.error(e);
    return json({ valid: false, reason: 'server_error' }, 500);
  }
};

function json(body, status = 200) {
  return { statusCode: status, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}
