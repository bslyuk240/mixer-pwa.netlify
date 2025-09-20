// _supabase.js
const { createClient } = require('@supabase/supabase-js');

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_KEY; // service_role required

if (!url || !key) {
  console.error('Supabase env missing:', { hasUrl: !!url, hasKey: !!key });
}

const supabase = createClient(url, key, {
  auth: { persistSession: false }
});

module.exports = { supabase };
