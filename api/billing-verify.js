
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
      error: "Billing configuration is incomplete."
    });
  }

  const authorization = req.headers.authorization || "";
  const tokenMatch = authorization.match(/^Bearer\s+(.+)$/i);

  if (!tokenMatch) {
    return res.status(401).json({
      success: false,
      error: "Please sign in before verifying payment."
    });
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  });

  try {
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

    const reference = req.body?.reference;

    if (
      typeof reference !== "string" ||
      !/^kivo_[a-f0-9-]{36}$/i.test(reference)
    ) {
      return res.status(400).json({
        success: false,
        error: "A valid payment reference is required."
      });
    }

    const { data: payment, error: paymentError } = await supabase
      .from("billing_payments")
      .select(
        "id, subscription_id, user_id, provider, provider_reference, amount_ngn, currency, status"
      )
      .eq("provider_reference", reference)
      .eq("user_id", user.id)
      .eq("provider", "paystack")
      .maybeSingle();

    if (paymentError) {
      console.error("Payment lookup failed:", paymentError);
      return res.status(500).json({
        success: false,
        error: "Could not look up this payment."
      });
    }

    if (!payment) {
      return res.status(404).json({
        success: false,
        error: "Payment reference not found."
      });
    }

    const { data: subscription, error: subscriptionError } =
      await supabase
        .from("subscriptions")
        .select("id, user_id, plan_code, billing_interval, status")
        .eq("id", payment.subscription_id)
        .eq("user_id", user.id)
        .maybeSingle();

    if (subscriptionError || !subscription) {
      console.error("Subscription lookup failed:", subscriptionError);
      return res.status(500).json({
        success: false,
        error: "Could not verify the subscription."
      });
    }

    if (payment.status === "successful") {
      return res.status(200).json({
        success: true,
        verified: true,
        message: "This payment has already been verified."
      });
    }

    if (payment.status !== "pending") {
      return res.status(409).json({
        success: false,
        error: "This payment is no longer pending."
      });
    }

    if (subscription.status !== "incomplete") {
      return res.status(409).json({
        success: false,
        error: "This subscription cannot be activated by this payment."
      });
    }

    const response = await fetch(
      `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${paystackSecretKey}`,
          Accept: "application/json"
        }
      }
    );

    const result = await response.json();

    if (!response.ok || result.status !== true || !result.data) {
      return res.status(502).json({
        success: false,
        error: "Paystack could not verify this payment. Please try again."
      });
    }

    const transaction = result.data;

    if (
      transaction.reference !== payment.provider_reference ||
      transaction.status !== "success" ||
      transaction.currency !== payment.currency ||
      transaction.amount !== payment.amount_ngn * 100 ||
      transaction.metadata?.user_id !== user.id ||
      transaction.metadata?.subscription_id !== subscription.id ||
      transaction.metadata?.plan_code !== subscription.plan_code ||
      transaction.metadata?.billing_interval !== subscription.billing_interval
    ) {
      return res.status(400).json({
        success: false,
        error: "Payment details do not match this subscription."
      });
    }

    const paidAt = transaction.paid_at || new Date().toISOString();
    const periodStart = new Date(paidAt);
    const periodEnd = new Date(periodStart);

    if (subscription.billing_interval === "annual") {
      periodEnd.setUTCFullYear(periodEnd.getUTCFullYear() + 1);
    } else if (subscription.billing_interval === "monthly") {
      periodEnd.setUTCMonth(periodEnd.getUTCMonth() + 1);
    } else {
      return res.status(400).json({
        success: false,
        error: "Invalid subscription billing interval."
      });
    }

    const { data: updatedPayment, error: updatePaymentError } =
      await supabase
        .from("billing_payments")
        .update({
          status: "successful",
          paid_at: paidAt
        })
        .eq("id", payment.id)
        .eq("user_id", user.id)
        .eq("status", "pending")
        .select("id")
        .maybeSingle();

    if (updatePaymentError || !updatedPayment) {
      console.error("Payment update failed:", updatePaymentError);
      return res.status(409).json({
        success: false,
        error: "Payment status changed or could not be updated. Please retry."
      });
    }

    const { data: updatedSubscription, error: updateSubscriptionError } =
      await supabase
        .from("subscriptions")
        .update({
          status: "active",
          provider: "paystack",
          current_period_start: periodStart.toISOString(),
          current_period_end: periodEnd.toISOString(),
          updated_at: new Date().toISOString()
        })
        .eq("id", subscription.id)
        .eq("user_id", user.id)
        .eq("status", "incomplete")
        .select("id")
        .maybeSingle();

    if (updateSubscriptionError || !updatedSubscription) {
      console.error(
        "Subscription activation failed:",
        updateSubscriptionError
      );

      return res.status(500).json({
        success: false,
        verified: true,
        error:
          "Payment was confirmed, but subscription activation needs recovery. Please contact support."
      });
    }

    return res.status(200).json({
      success: true,
      verified: true,
      message: "Payment verified and subscription activated."
    });
  } catch (error) {
    console.error("Payment verification error:", error);

    return res.status(500).json({
      success: false,
      error: "Something went wrong while verifying payment."
    });
  }
};
