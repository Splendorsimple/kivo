const { createClient } = require("@supabase/supabase-js");

const supabaseUrl = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const paystackSecretKey = process.env.PAYSTACK_SECRET_KEY;

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

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
      error: "Billing configuration is incomplete."
    });
  }

  const authorization = req.headers.authorization || "";
  const tokenMatch = authorization.match(/^Bearer\s+(.+)$/i);

  if (!tokenMatch) {
    return res.status(401).json({
      success: false,
      error: "Please sign in to verify your payment."
    });
  }

  const reference = req.body?.reference;

  if (
    typeof reference !== "string" ||
    reference.length < 1 ||
    reference.length > 200
  ) {
    return res.status(400).json({
      success: false,
      error: "A valid payment reference is required."
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
    // Authenticate the actual signed-in user.
    const {
      data: { user },
      error: authError
    } = await supabase.auth.getUser(tokenMatch[1]);

    if (authError || !user) {
      return res.status(401).json({
        success: false,
        error: "Your session is invalid. Please sign in again."
      });
    }

    // Only retrieve a payment belonging to this user.
    const { data: payment, error: paymentError } = await supabase
      .from("billing_payments")
      .select(
        "id, subscription_id, user_id, provider_reference, amount_ngn, currency, status"
      )
      .eq("provider_reference", reference)
      .eq("provider", "paystack")
      .eq("user_id", user.id)
      .maybeSingle();

    if (paymentError) {
      console.error("Billing payment lookup failed:", paymentError);

      return res.status(500).json({
        success: false,
        error: "Could not retrieve your payment status."
      });
    }

    if (!payment) {
      return res.status(404).json({
        success: false,
        error: "No payment was found for this account."
      });
    }

    if (!["pending", "successful"].includes(payment.status)) {
      return res.status(409).json({
        success: false,
        paid: false,
        status: payment.status,
        error: "This payment is not eligible for activation."
      });
    }

    const expectedAmountKobo = payment.amount_ngn * 100;

    if (
      !Number.isSafeInteger(expectedAmountKobo) ||
      expectedAmountKobo <= 0
    ) {
      return res.status(500).json({
        success: false,
        error: "The recorded payment amount is invalid."
      });
    }

    // Verify the transaction directly with Paystack.
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
        success: false,
        error: "Paystack could not verify the payment. Please try again."
      });
    }

    const verification = await verifyResponse.json();
    const verified = verification.data;

    if (
      verification.status !== true ||
      !verified ||
      verified.status !== "success"
    ) {
      return res.status(200).json({
        success: true,
        paid: false,
        status: verified?.status || "unverified",
        message:
          "Payment has not been confirmed. Your subscription has not been activated."
      });
    }

    // Match Paystack's verified transaction to our own records.
    if (
      verified.reference !== payment.provider_reference ||
      verified.amount !== expectedAmountKobo ||
      verified.currency !== payment.currency ||
      payment.currency !== "NGN" ||
      verified.metadata?.user_id !== payment.user_id ||
      verified.metadata?.subscription_id !== payment.subscription_id
    ) {
      console.error(
        "Verified transaction did not match the billing record."
      );

      return res.status(409).json({
        success: false,
        error: "Payment details could not be matched to this subscription."
      });
    }

    // The database function records the payment and activates
    // the subscription within one database transaction.
    const { data: activationResult, error: activationError } =
      await supabase.rpc("activate_verified_paystack_payment", {
        p_provider_reference: payment.provider_reference,
        p_verified_amount_kobo: verified.amount,
        p_verified_currency: verified.currency,
        p_paid_at: verified.paid_at || null
      });

    if (activationError) {
      console.error("Subscription activation failed:", activationError);

      return res.status(500).json({
        success: false,
        error:
          "Your payment was verified, but activation could not be completed. Please try again."
      });
    }

    if (!activationResult || activationResult.success !== true) {
      console.error("Unexpected activation result.");

      return res.status(500).json({
        success: false,
        error: "Could not confirm subscription activation."
      });
    }

    return res.status(200).json({
      success: true,
      paid: true,
      status: "successful",
      already_activated: activationResult.already_activated === true,
      subscription_id: activationResult.subscription_id,
      plan_code: activationResult.plan_code || null,
      billing_interval: activationResult.billing_interval || null,
      message: "Your payment has been verified successfully."
    });
  } catch (error) {
    console.error("Billing status verification failed:", error);

    return res.status(500).json({
      success: false,
      error: "An unexpected error occurred while verifying your payment."
    });
  }
};
