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

  const { key } = JSON.parse(event.body || '{}');
  if (!key) return cors({ valid: false, reason: 'missing_key' });

  const { data: lic, error } = await supabase
    .from('licenses')
    .select('*')
    .eq('key', key)
    .single();

  if (error || !lic) return cors({ valid: false, reason: 'not_found' });
  if (lic.status !== 'active') return cors({ valid: false, reason: 'revoked' });
  if (lic.expires && new Date(lic.expires) < new Date()) return cors({ valid: false, reason: 'expired' });

  const { count } = await supabase
    .from('activations')
    .select('*', { count: 'exact', head: true })
    .eq('license_key', key);

  const remaining = Math.max(0, (lic.max_devices || 1) - (count || 0));

  return cors({
    valid: true,
    plan: lic.plan,
    expires: lic.expires,
    max_devices: lic.max_devices,
    remaining
  });
};
