// functions/webhook.js
exports.handler = async (event) => {
  try {
    const body = JSON.parse(event.body);

    // Log it (so you can see it in Netlify logs)
    console.log("Webhook received:", body);

    // Example: if this is a new license
    if (body.type === "INSERT") {
      const newLicense = body.record;
      console.log("New license added:", newLicense.key);
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, received: body }),
    };
  } catch (err) {
    console.error("Webhook error:", err);
    return { statusCode: 400, body: "Invalid request" };
  }
};
