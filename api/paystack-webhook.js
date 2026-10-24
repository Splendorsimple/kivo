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
    console.error("Paystack webhook configuration is incomplete.");

    return res.status(500).json({
      received: false
    });
  }

  const signature = req.headers["x-paystack-signature"];

  if (typeof signature !== "string") {
    return res.status(401).json({
      received: false,
      error: "Missing webhook signature."
    });
  }

  let rawBody;

  try {
    const chunks = [];

    for await (const chunk of req) {
      chunks.push(
        Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      );
    }

    rawBody = Buffer.concat(chunks);
  } catch (error) {
    console.error("Webhook body reading failed:", error);

    return res.status(400).json({
      received: false
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
      received: false,
      error: "Invalid webhook signature."
    });
  }

  let event;

  try {
    event = JSON.parse(rawBody.toString("utf8"));
  } catch {
    return res.status(400).json({
      received: false,
      error: "Invalid JSON payload."
    });
  }

  // Other Paystack events do not require processing here.
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
    // Only process payment records created by Kivo.
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

    // Never create a payment record from webhook data.
    if (!payment) {
      console.warn("Ignoring unknown Paystack reference.");

      return res.status(200).json({
        received: true
      });
    }

    // Retry pending payments and successful payments whose
    // subscription activation may need reconciliation.
    if (
      payment.status !== "pending" &&
      payment.status !== "successful"
    ) {
      return res.status(200).json({
        received: true
      });
    }

    const expectedAmountKobo = payment.amount_ngn * 100;

    if (
      !Number.isSafeInteger(expectedAmountKobo) ||
      expectedAmountKobo <= 0
    ) {
      console.error("Recorded payment amount is invalid.");

      return res.status(200).json({
        received: true
      });
    }

    // Retrieve the authoritative subscription details from Supabase.
    const { data: subscription, error: subscriptionError } =
      await supabase
        .from("subscriptions")
        .select("id, user_id, plan_code, billing_interval, status")
        .eq("id", payment.subscription_id)
        .eq("user_id", payment.user_id)
        .maybeSingle();

    if (subscriptionError) {
      console.error(
        "Webhook subscription lookup failed:",
        subscriptionError
      );

      return res.status(500).json({
        received: false
      });
    }

    if (!subscription) {
      console.error(
        "No matching subscription exists for the payment."
      );

      return res.status(200).json({
        received: true
      });
    }

    // Match the signed webhook event to our stored payment and subscription.
    if (
      transaction.reference !== payment.provider_reference ||
      transaction.currency !== payment.currency ||
      transaction.amount !== expectedAmountKobo ||
      payment.currency !== "NGN" ||
      transaction.metadata?.user_id !== payment.user_id ||
      transaction.metadata?.subscription_id !== payment.subscription_id ||
      transaction.metadata?.plan_code !== subscription.plan_code ||
      transaction.metadata?.billing_interval !== subscription.billing_interval
    ) {
      console.error(
        "Webhook event did not match the stored payment and subscription."
      );

      return res.status(200).json({
        received: true
      });
    }

    // Independently verify the transaction with Paystack.
    const verifyResponse = await fetch(
      "https://api.paystack.co/transaction/verify/" +
        encodeURIComponent(payment.provider_reference),
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
      verified.status !== "success"
    ) {
      console.error("Paystack has not confirmed a successful transaction.");

      return res.status(200).json({
        received: true
      });
    }

    // Independently match Paystack's verified record to Kivo's records.
    if (
      verified.reference !== payment.provider_reference ||
      verified.amount !== expectedAmountKobo ||
      verified.currency !== payment.currency ||
      verified.currency !== "NGN" ||
      verified.metadata?.user_id !== payment.user_id ||
      verified.metadata?.subscription_id !== payment.subscription_id ||
      verified.metadata?.plan_code !== subscription.plan_code ||
      verified.metadata?.billing_interval !== subscription.billing_interval
    ) {
      console.error(
        "Verified Paystack transaction did not match the stored subscription."
      );

      return res.status(200).json({
        received: true
      });
    }

    // Atomically record the verified payment and activate the subscription.
    // The database function is responsible for final state checks and retries.
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

    if (
      !activationResult ||
      activationResult.success !== true
    ) {
      console.error(
        "Unexpected payment activation result:",
        activationResult
      );

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
