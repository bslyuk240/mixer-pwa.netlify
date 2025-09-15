exports.handler = async () => {
  const hasUrl = !!process.env.SUPABASE_URL;
  const hasService = !!process.env.SUPABASE_SERVICE_KEY;

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify({
      ok: true,
      env_seen: {
        SUPABASE_URL_present: hasUrl,
        SUPABASE_SERVICE_KEY_present: hasService
      },
      // Safety: do NOT return actual keys. Just show the URL so you can confirm project.
      url_preview: process.env.SUPABASE_URL || null
    })
  };
};
