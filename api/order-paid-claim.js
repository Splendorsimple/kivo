const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");
const { clientKey, allow, tooMany } = require("./_ratelimit");

const fail = (res, status, error) => res.status(status).json({ success: false, error });
const sha256 = (v) => crypto.createHash("sha256").update(v).digest("hex");

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return fail(res, 405, "Method not allowed.");

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) return fail(res, 500, "Server configuration is incomplete.");

  let body = req.body;
  try { if (typeof body === "string") body = JSON.parse(body); } catch (e) { return fail(res, 400, "Invalid request."); }
  body = body && typeof body === "object" ? body : {};

  const slug = typeof body.slug === "string" ? body.slug.trim().toLowerCase() : "";
  const orderNumber = typeof body.order_number === "string" ? body.order_number.trim().toUpperCase() : "";
  const token = typeof body.token === "string" ? body.token : "";
  if (!/^[a-z0-9-]{1,60}$/.test(slug) || !/^KIV-[0-9A-F]{6}$/.test(orderNumber) || !/^[0-9a-f]{32}$/.test(token)) {
    return fail(res, 400, "Invalid request.");
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });
  if (!(await allow(supabase, "claim:ip:" + clientKey(req), 20, 600))) return tooMany(res, 600);

  try {
    const { data: store, error: storeError } = await supabase.from("stores").select("id").eq("slug", slug).maybeSingle();
    if (storeError) throw storeError;
    if (!store) return fail(res, 404, "Order not found.");

    const { data: order, error: orderError } = await supabase
      .from("orders").select("id, order_status, payment_status, tracking_token_hash")
      .eq("store_id", store.id).eq("order_number", orderNumber).maybeSingle();
    if (orderError) throw orderError;

    // The secret token is only known to the customer who placed the order.
    const stored = order && order.tracking_token_hash ? Buffer.from(order.tracking_token_hash, "hex") : null;
    const given = Buffer.from(sha256(token), "hex");
    if (!order || !stored || stored.length !== given.length || !crypto.timingSafeEqual(stored, given)) {
      return fail(res, 404, "Order not found.");
    }

    // Only a new, unpaid order can be flagged. Anything else is already past this step.
    if (order.order_status === "pending" && order.payment_status === "unpaid") {
      const { error: updateError } = await supabase.from("orders").update({ payment_status: "pending" }).eq("id", order.id);
      if (updateError) throw updateError;
    }

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error("Payment claim failed:", error);
    return fail(res, 500, "Could not record that. Please tell the seller on WhatsApp.");
  }
};
