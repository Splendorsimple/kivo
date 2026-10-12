
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");

const supabaseUrl = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const paystackSecretKey = process.env.PAYSTACK_SECRET_KEY;

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({
      success: false,
      error: "Method not allowed."
    });
  }

  if (!supabaseUrl || !serviceRoleKey || !paystackSecretKey) {
    return res.status(500).json({
      success: false,
      error: "Webhook configuration is incomplete."
    });
  }

  // Paystack signs the exact raw request body.
  const rawBody = req.body;

  if (!Buffer.isBuffer(rawBody)) {
    return res.status(400).json({
      success: false,
      error: "Raw request body is required."
    });
  }

  const signature = req.headers["x-paystack-signature"];

  if (typeof signature !== "string") {
    return res.status(401).json({
      success: false,
      error: "Missing webhook signature."
    });
  }

  const expectedSignature = crypto
    .createHmac("sha512", paystackSecretKey)
    .update(rawBody)
    .digest("hex");

  const received = Buffer.from(signature, "utf8");
  const expected = Buffer.from(expectedSignature, "utf8");

  if (
    received.length !== expected.length ||
    !crypto.timingSafeEqual(received, expected)
  ) {
    return res.status(401).json({
      success: false,
      error: "Invalid webhook signature."
    });
  }

  let event;

  try {
    event = JSON.parse(rawBody.toString("utf8"));
  } catch {
    return res.status(400).json({
      success: false,
      error: "Invalid JSON payload."
    });
  }

  // We only process successful charge notifications.
  if (event.event !== "charge.success") {
    return res.status(200).json({ received: true });
  }

  const transaction = event.data;

  if (
    !transaction ||
    transaction.status !== "success" ||
    typeof transaction.reference !== "string"
  ) {
    return res.status(200).json({ received: true });
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  });

  try {
    const { data: payment, error: paymentError } = await supabase
      .from("billing_payments")
      .select(
        "id, subscription_id, user_id, provider_reference, amount_ngn, currency, status"
      )
      .eq("provider_reference", transaction.reference)
      .eq("provider", "paystack")
      .maybeSingle();

    if (paymentError) {
      console.error("Webhook payment lookup failed:", paymentError);
      return res.status(500).json({ received: false });
    }

    // Ignore unknown references. Do not create records from webhook data.
    if (!payment) {
      return res.status(200).json({ received: true });
    }

    if (payment.status === "successful") {
      return res.status(200).json({ received: true });
    }

    if (payment.status !== "pending") {
      return res.status(200).json({ received: true });
    }

    if (
      transaction.reference !== payment.provider_reference ||
      transaction.currency !== payment.currency ||
      transaction.amount !== payment.amount_ngn * 100 ||
      transaction.metadata?.user_id !== payment.user_id ||
      transaction.metadata?.subscription_id !== payment.subscription_id
    ) {
      console.error("Webhook transaction did not match payment record.");
      return res.status(200).json({ received: true });
    }

    // Independently verify the transaction with Paystack before granting access.
    const verifyResponse = await fetch(
      `https://api.paystack.co/transaction/verify/${encodeURIComponent(
        payment.provider_reference
      )}`,
      {
        headers: {
          Authorization: `Bearer ${paystackSecretKey}`,
          Accept: "application/json"
        }
      }
    );

    const verification = await verifyResponse.json();

    if (
      !verifyResponse.ok ||
      verification.status !== true ||
      verification.data?.status !== "success" ||
      verification.data?.reference !== payment.provider_reference ||
      verification.data?.amount !== payment.amount_ngn * 100 ||
      verification.data?.currency !== payment.currency ||
      verification.data?.metadata?.user_id !== payment.user_id ||
      verification.data?.metadata?.subscription_id !== payment.subscription_id
    ) {
      console.error("Paystack API verification did not match webhook.");
      return res.status(200).json({ received: true });
    }

    // Record payment only. Subscription activation will be handled by a
    // single database transaction in the next hardening step.
    const { error: updateError } = await supabase
      .from("billing_payments")
      .update({
        status: "successful",
        paid_at: verification.data.paid_at || new Date().toISOString()
      })
      .eq("id", payment.id)
      .eq("status", "pending");

    if (updateError) {
      console.error("Webhook payment update failed:", updateError);
      return res.status(500).json({ received: false });
    }

    return res.status(200).json({ received: true });
  } catch (error) {
    console.error("Paystack webhook processing failed:", error);
    return res.status(500).json({ received: false });
  }
};
