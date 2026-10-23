const { createClient } = require("@supabase/supabase-js");
const crypto = require("crypto");

const supabaseUrl = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const paystackSecretKey = process.env.PAYSTACK_SECRET_KEY;

const appUrl = "https://kivo-bay.vercel.app";

const VALID_PLANS = [
  "beginner",
  "growth",
  "pro",
  "platinum"
];

const VALID_INTERVALS = [
  "monthly",
  "annual"
];

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
      error: "Please sign in before starting checkout."
    });
  }

  const planCode = req.body?.plan_code;
  const billingInterval = req.body?.billing_interval;

  if (
    typeof planCode !== "string" ||
    !VALID_PLANS.includes(planCode) ||
    typeof billingInterval !== "string" ||
    !VALID_INTERVALS.includes(billingInterval)
  ) {
    return res.status(400).json({
      success: false,
      error: "Please select a valid plan and billing interval."
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

  let paymentId = null;
  let subscriptionId = null;

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

    if (!user.email) {
      return res.status(400).json({
        success: false,
        error: "Your account needs a valid email address for checkout."
      });
    }

    const { data: plan, error: planError } = await supabase
      .from("plans")
      .select(
        "code, name, monthly_price_ngn, annual_price_ngn, is_active"
      )
      .eq("code", planCode)
      .eq("is_active", true)
      .maybeSingle();

    if (planError) {
      console.error("Plan lookup failed:", planError);

      return res.status(500).json({
        success: false,
        error: "Could not retrieve the selected plan."
      });
    }

    if (!plan) {
      return res.status(400).json({
        success: false,
        error: "This plan is unavailable."
      });
    }

    const amountNgn =
      billingInterval === "annual"
        ? plan.annual_price_ngn
        : plan.monthly_price_ngn;

    const amountKobo = amountNgn * 100;

    if (
      !Number.isSafeInteger(amountNgn) ||
      amountNgn <= 0 ||
      !Number.isSafeInteger(amountKobo)
    ) {
      console.error("Invalid plan price:", plan.code);

      return res.status(500).json({
        success: false,
        error: "The selected plan has an invalid price."
      });
    }

    const reference = `kivo_${crypto.randomUUID()}`;

    const { data: subscription, error: subscriptionError } =
      await supabase
        .from("subscriptions")
        .insert({
          user_id: user.id,
          plan_code: plan.code,
          billing_interval: billingInterval,
          status: "incomplete",
          provider: "paystack"
        })
        .select("id")
        .single();

    if (subscriptionError || !subscription) {
      console.error(
        "Subscription creation failed:",
        subscriptionError
      );

      return res.status(500).json({
        success: false,
        error: "Could not create your subscription checkout."
      });
    }

    subscriptionId = subscription.id;

    const { data: payment, error: paymentError } = await supabase
      .from("billing_payments")
      .insert({
        subscription_id: subscriptionId,
        user_id: user.id,
        provider: "paystack",
        provider_reference: reference,
        amount_ngn: amountNgn,
        currency: "NGN",
        status: "pending"
      })
      .select("id")
      .single();

    if (paymentError || !payment) {
      console.error(
        "Pending payment creation failed:",
        paymentError
      );

      // Remove the incomplete subscription if no payment record
      // could be created for it.
      const { error: cleanupError } = await supabase
        .from("subscriptions")
        .delete()
        .eq("id", subscriptionId)
        .eq("user_id", user.id)
        .eq("status", "incomplete");

      if (cleanupError) {
        console.error(
          "Incomplete subscription cleanup failed:",
          cleanupError
        );
      }

      return res.status(500).json({
        success: false,
        error: "Could not create your payment record. Please try again."
      });
    }

    paymentId = payment.id;

    const paystackResponse = await fetch(
      "https://api.paystack.co/transaction/initialize",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${paystackSecretKey}`,
          "Content-Type": "application/json",
          Accept: "application/json"
        },
        body: JSON.stringify({
          email: user.email,
          amount: amountKobo,
          currency: "NGN",
          reference,
          callback_url: `${appUrl}/dashboard/?billing=return`,
          metadata: {
            user_id: user.id,
            subscription_id: subscriptionId,
            plan_code: plan.code,
            billing_interval: billingInterval
          }
        })
      }
    );

    let paystackResult;

    try {
      paystackResult = await paystackResponse.json();
    } catch {
      paystackResult = null;
    }

    if (
      !paystackResponse.ok ||
      paystackResult?.status !== true ||
      typeof paystackResult?.data?.authorization_url !== "string" ||
      !paystackResult.data.authorization_url.startsWith("https://")
    ) {
      console.error(
        "Paystack checkout initialization failed:",
        paystackResponse.status,
        paystackResult?.message || "Invalid Paystack response"
      );

      const { error: paymentUpdateError } = await supabase
        .from("billing_payments")
        .update({
          status: "failed"
        })
        .eq("id", paymentId)
        .eq("status", "pending");

      if (paymentUpdateError) {
        console.error(
          "Failed payment update failed:",
          paymentUpdateError
        );
      }

      return res.status(502).json({
        success: false,
        error: "Paystack could not start checkout. Please try again."
      });
    }

    return res.status(200).json({
      success: true,
      authorization_url: paystackResult.data.authorization_url,
      reference
    });
  } catch (error) {
    console.error("Checkout initialization error:", error);

    // If Paystack initialization may have been attempted, do not
    // mark the payment failed here: the request may have reached
    // Paystack even if the connection subsequently failed.
    return res.status(500).json({
      success: false,
      error: "Could not start checkout. Please try again."
    });
  }
};
