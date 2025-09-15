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

  await supabase.from('activations').delete().match({ license_key: key, device_id: deviceId });
  return cors({ ok: true });
};
