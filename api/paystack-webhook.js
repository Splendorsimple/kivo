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

  const signature = req.headers["x-paystack-signature"];

  if (typeof signature !== "string") {
    return res.status(401).json({
      success: false,
      error: "Missing webhook signature."
    });
  }

  let rawBody;

  try {
    const chunks = [];

    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

    rawBody = Buffer.concat(chunks);
  } catch (error) {
    console.error("Webhook body reading failed:", error);

    return res.status(400).json({
      success: false,
      error: "Could not read webhook request body."
    });
  }

  const expectedSignature = crypto
    .createHmac("sha512", paystackSecretKey)
    .update(rawBody)
    .digest("hex");

  const receivedBuffer = Buffer.from(signature, "utf8");
  const expectedBuffer = Buffer.from(expectedSignature, "utf8");

  if (
    receivedBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(receivedBuffer, expectedBuffer)
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

  // Other Paystack events require no action here.
  if (event.event !== "charge.success") {
    return res.status(200).json({
      received: true
    });
  }

  const transaction = event.data;

  if (
    !transaction ||
    transaction.status !== "success" ||
    typeof transaction.reference !== "string"
  ) {
    return res.status(200).json({
      received: true
    });
  }

  const supabase = createClient(
    supabaseUrl,
    serviceRoleKey,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      }
    }
  );

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

      return res.status(500).json({
        received: false
      });
    }

    // Never create a payment record from untrusted webhook data.
    if (!payment) {
      console.warn("Ignoring unknown Paystack reference.");

      return res.status(200).json({
        received: true
      });
    }

    // Already completed payments are safe to acknowledge.
    if (payment.status === "successful") {
      return res.status(200).json({
        received: true
      });
    }

    if (payment.status !== "pending") {
      return res.status(200).json({
        received: true
      });
    }

    const expectedAmountKobo = payment.amount_ngn * 100;

    if (
      transaction.reference !== payment.provider_reference ||
      transaction.currency !== payment.currency ||
      transaction.amount !== expectedAmountKobo ||
      transaction.metadata?.user_id !== payment.user_id ||
      transaction.metadata?.subscription_id !== payment.subscription_id
    ) {
      console.error("Webhook transaction did not match the payment record.");

      return res.status(200).json({
        received: true
      });
    }

    // Independently verify the transaction with Paystack.
    const verifyResponse = await fetch(
      `https://api.paystack.co/transaction/verify/${encodeURIComponent(
        payment.provider_reference
      )}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${paystackSecretKey}`,
          Accept: "application/json"
        }
      }
    );

    if (!verifyResponse.ok) {
      console.error(
        "Paystack verification request failed:",
        verifyResponse.status
      );

      return res.status(502).json({
        received: false
      });
    }

    const verification = await verifyResponse.json();
    const verified = verification.data;

    if (
      verification.status !== true ||
      !verified ||
      verified.status !== "success" ||
      verified.reference !== payment.provider_reference ||
      verified.amount !== expectedAmountKobo ||
      verified.currency !== payment.currency ||
      verified.metadata?.user_id !== payment.user_id ||
      verified.metadata?.subscription_id !== payment.subscription_id
    ) {
      console.error("Paystack verification did not match the payment record.");

      return res.status(200).json({
        received: true
      });
    }

    // Atomically record the successful payment and activate its subscription.
    const { data: activationResult, error: activationError } =
      await supabase.rpc("activate_verified_paystack_payment", {
        p_provider_reference: payment.provider_reference,
        p_verified_amount_kobo: verified.amount,
        p_verified_currency: verified.currency,
        p_paid_at: verified.paid_at || null
      });

    if (activationError) {
      console.error(
        "Payment activation failed:",
        activationError
      );

      return res.status(500).json({
        received: false
      });
    }

    if (!activationResult || activationResult.success !== true) {
      console.error("Unexpected payment activation result.");

      return res.status(500).json({
        received: false
      });
    }

    return res.status(200).json({
      received: true
    });
  } catch (error) {
    console.error("Paystack webhook processing failed:", error);

    return res.status(500).json({
      received: false
    });
  }
};

// Vercel must not parse the body before signature verification.
module.exports.config = {
  api: {
    bodyParser: false
  }
};
