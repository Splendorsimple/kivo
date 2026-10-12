
const { createClient } = require("@supabase/supabase-js");
const crypto = require("crypto");

const supabaseUrl = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const paystackSecretKey = process.env.PAYSTACK_SECRET_KEY;

const appUrl = "https://kivo-bay.vercel.app";

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
      error: "Please sign in before subscribing."
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

    if (authError || !user || !user.email) {
      return res.status(401).json({
        success: false,
        error: "Your session is invalid. Please sign in again."
      });
    }

    const { plan_code, billing_interval } = req.body || {};

    if (
      typeof plan_code !== "string" ||
      !["beginner", "growth", "pro", "platinum"].includes(plan_code) ||
      !["monthly", "annual"].includes(billing_interval)
    ) {
      return res.status(400).json({
        success: false,
        error: "Choose a valid Kivo plan and billing interval."
      });
    }

    const { data: plan, error: planError } = await supabase
      .from("plans")
      .select("code, name, monthly_price_ngn, annual_price_ngn, is_active")
      .eq("code", plan_code)
      .eq("is_active", true)
      .single();

    if (planError || !plan) {
      return res.status(400).json({
        success: false,
        error: "This plan is unavailable."
      });
    }

    const amountNgn =
      billing_interval === "annual"
        ? plan.annual_price_ngn
        : plan.monthly_price_ngn;

    if (!Number.isSafeInteger(amountNgn) || amountNgn <= 0) {
      return res.status(500).json({
        success: false,
        error: "The plan price is invalid."
      });
    }

    const reference = `kivo_${crypto.randomUUID()}`;

    const { data: subscription, error: subscriptionError } =
      await supabase
        .from("subscriptions")
        .insert({
          user_id: user.id,
          plan_code: plan.code,
          billing_interval,
          status: "incomplete",
          provider: "paystack"
        })
        .select("id")
        .single();

    if (subscriptionError || !subscription) {
      console.error("Subscription creation failed:", subscriptionError);

      return res.status(500).json({
        success: false,
        error: "Could not start your subscription. Please try again."
      });
    }

    const { error: paymentError } = await supabase
      .from("billing_payments")
      .insert({
        subscription_id: subscription.id,
        user_id: user.id,
        provider: "paystack",
        provider_reference: reference,
        amount_ngn: amountNgn,
        currency: "NGN",
        status: "pending"
      });

    if (paymentError) {
      console.error("Payment record creation failed:", paymentError);

      return res.status(500).json({
        success: false,
        error: "Could not prepare your payment. Please try again."
      });
    }

    let paystackResponse;

    try {
      const response = await fetch(
        "https://api.paystack.co/transaction/initialize",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${paystackSecretKey}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            email: user.email,
            amount: amountNgn * 100,
            currency: "NGN",
            reference,
            callback_url: `${appUrl}/dashboard/?billing=return`,
            metadata: {
              user_id: user.id,
              subscription_id: subscription.id,
              plan_code: plan.code,
              billing_interval
            }
          })
        }
      );

      paystackResponse = await response.json();

      if (!response.ok || paystackResponse.status !== true) {
        throw new Error("Paystack initialization was unsuccessful.");
      }
    } catch (error) {
      console.error("Paystack initialization failed:", error);

      await supabase
        .from("billing_payments")
        .update({ status: "failed" })
        .eq("provider_reference", reference)
        .eq("user_id", user.id);

      return res.status(502).json({
        success: false,
        error: "Paystack could not start checkout. Please try again."
      });
    }

    return res.status(200).json({
      success: true,
      authorization_url: paystackResponse.data.authorization_url,
      reference
    });
  } catch (error) {
    console.error("Billing initialization error:", error);

    return res.status(500).json({
      success: false,
      error: "Something went wrong while starting checkout."
    });
  }
};
