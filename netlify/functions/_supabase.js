// _supabase.js
const { createClient } = require('@supabase/supabase-js');

// Load from Netlify environment variables
const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_KEY; // must be the service_role key

if (!url || !key) {
  console.error('Supabase environment variables are missing:', {
    hasUrl: !!url,
    hasKey: !!key,
  });
}

const supabase = createClient(url, key, {
  auth: { persistSession: false },
});

module.exports = { supabase };
