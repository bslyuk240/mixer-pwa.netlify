// netlify/functions/verify.js
const { supabase } = require('./_supabase');

exports.handler = async (event) => {
  try {
    // Allow POST with JSON body OR GET with ?key=
    let key = '';
    if (event.httpMethod === 'POST') {
      try {
        const body = JSON.parse(event.body || '{}');
        key = (body.key || '').trim();
      } catch {}
    } else if (event.httpMethod === 'GET') {
      const params = new URLSearchParams(event.rawQuery || event.queryStringParameters || {});
      key = (params.get ? params.get('key') : (params.key || '')).trim();
    }

    if (!key) {
      return json(400, { valid: false, reason: 'missing_key' });
    }

    // Query licenses table
    const { data, error } = await supabase
      .from('licenses')
      .select('key, plan, status, expires_date')
      .eq('key', key)
      .single();

    if (error) {
      // Surface the DB error to help us debug
      return json(500, { valid: false, reason: 'db_error', detail: error.message });
    }

    if (!data) {
      return json(200, { valid: false, reason: 'not_found' });
    }

    if (data.status !== 'active') {
      return json(200, { valid: false, reason: 'inactive', row: data });
    }

    // (Optional) expiry check
    if (data.expires_date && new Date(data.expires_date) < new Date()) {
      return json(200, { valid: false, reason: 'expired', row: data });
    }

    return json(200, { valid: true, plan: data.plan || 'full', row: data });
  } catch (e) {
    return json(500, { valid: false, reason: 'server_exception', detail: String(e) });
  }
};

function json(statusCode, obj) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(obj),
  };
}
