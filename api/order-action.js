const { createClient } = require("@supabase/supabase-js");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NEXT = { confirm: "confirmed", process: "processing", ship: "shipped", deliver: "delivered", cancel: "cancelled" };
const fail = (res, status, error) => res.status(status).json({ success: false, error });

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return fail(res, 405, "Method not allowed.");

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) return fail(res, 500, "Server configuration is incomplete.");

  const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return fail(res, 401, "Please sign in again.");

  let body = req.body;
  try { if (typeof body === "string") body = JSON.parse(body); } catch (e) { return fail(res, 400, "Invalid request."); }
  body = body && typeof body === "object" ? body : {};

  const orderId = body.order_id;
  const action = body.action;
  if (typeof orderId !== "string" || !UUID.test(orderId)) return fail(res, 400, "Invalid order.");
  if (action !== "mark_paid" && !NEXT[action]) return fail(res, 400, "Invalid action.");

  const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });

  try {
    const { data: auth, error: authError } = await supabase.auth.getUser(token);
    if (authError || !auth || !auth.user) return fail(res, 401, "Please sign in again.");

    const { data: order, error: orderError } = await supabase
      .from("orders")
      .select("id, store_id, order_number, order_status, payment_status, payment_method, total_ngn")
      .eq("id", orderId).maybeSingle();
    if (orderError) throw orderError;
    if (!order) return fail(res, 404, "Order not found.");

    // Only the store owner may manage its orders.
    const { data: store, error: storeError } = await supabase
      .from("stores").select("owner_id").eq("id", order.store_id).maybeSingle();
    if (storeError) throw storeError;
    if (!store || store.owner_id !== auth.user.id) return fail(res, 403, "You cannot manage this order.");

    if (action === "mark_paid") {
      if (order.order_status === "cancelled" || order.order_status === "refunded") {
        return fail(res, 409, "This order can no longer be marked as paid.");
      }
      if (order.payment_status !== "paid") {
        // The database requires a successful payment record before an order can be paid.
        const { error: payError } = await supabase.from("sales_payments").insert({
          store_id: order.store_id,
          order_id: order.id,
          provider: "manual",
          provider_reference: "manual-" + order.order_number,
          amount_ngn: order.total_ngn,
          currency: "NGN",
          status: "successful",
          payment_method: order.payment_method || "other",
          paid_at: new Date().toISOString(),
          provider_metadata: { recorded_by: auth.user.id, note: "Confirmed by seller" }
        });
        if (payError) throw payError;

        const { error: updateError } = await supabase.from("orders").update({ payment_status: "paid" }).eq("id", order.id);
        if (updateError) throw updateError;
      }
    } else {
      // Stock is reserved at confirmation, while the order is still pending.
      if (action === "confirm") {
        const { error: reserveError } = await supabase.rpc("reserve_order_inventory", { p_order_id: order.id });
        if (reserveError) throw reserveError;
      }
      const { error: updateError } = await supabase.from("orders").update({ order_status: NEXT[action] }).eq("id", order.id);
      if (updateError) throw updateError;
    }

    const { data: fresh } = await supabase.from("orders").select("order_status, payment_status").eq("id", order.id).maybeSingle();
    return res.status(200).json({ success: true, order_status: fresh && fresh.order_status, payment_status: fresh && fresh.payment_status });
  } catch (error) {
    console.error("Order action failed:", error);
    return fail(res, 409, String(error && error.message ? error.message : "That action could not be completed.").slice(0, 200));
  }
};
