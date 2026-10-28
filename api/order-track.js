const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");
const { clientKey, allow, tooMany } = require("./_ratelimit");
const { trackKey } = require("./_track");

const fail = (res, status, error) => res.status(status).json({ success: false, error });

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") return fail(res, 405, "Method not allowed.");

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) return fail(res, 500, "Server configuration is incomplete.");

  const q = req.query || {};
  const slug = String(q.slug || "").toLowerCase();
  const num = String(q.o || "").toUpperCase();
  const key = String(q.k || "");
  if (!/^[a-z0-9-]{1,60}$/.test(slug) || !/^KIV-[0-9A-F]{6}$/.test(num) || !/^[0-9a-f]{24}$/.test(key)) {
    return fail(res, 404, "We could not find that order.");
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });
  if (!(await allow(supabase, "track:ip:" + clientKey(req), 60, 600))) return tooMany(res, 600);

  try {
    const { data: store, error: storeError } = await supabase.from("stores").select("id, name").eq("slug", slug).maybeSingle();
    if (storeError) throw storeError;
    if (!store) return fail(res, 404, "We could not find that order.");

    const { data: order, error: orderError } = await supabase
      .from("orders")
      .select("id, order_number, order_status, payment_status, payment_method, total_ngn, created_at, updated_at, order_items(product_name, quantity)")
      .eq("store_id", store.id).eq("order_number", num).maybeSingle();
    if (orderError) throw orderError;

    const expected = order ? Buffer.from(trackKey(serviceRoleKey, order.id)) : null;
    const given = Buffer.from(key);
    if (!expected || expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) {
      return fail(res, 404, "We could not find that order.");
    }

    const { data: settingsRow } = await supabase.from("store_settings").select("settings").eq("store_id", store.id).maybeSingle();
    const wa = settingsRow && settingsRow.settings && settingsRow.settings.contact
      ? String(settingsRow.settings.contact.whatsapp || "").replace(/\D/g, "") : "";

    return res.status(200).json({
      success: true,
      store: { name: store.name },
      whatsapp: wa || null,
      order: {
        order_number: order.order_number,
        order_status: order.order_status,
        payment_status: order.payment_status,
        payment_method: order.payment_method,
        total_ngn: order.total_ngn,
        created_at: order.created_at,
        updated_at: order.updated_at,
        items: (order.order_items || []).map((i) => ({ name: i.product_name, quantity: i.quantity }))
      }
    });
  } catch (error) {
    console.error("Order tracking failed:", error);
    return fail(res, 500, "We could not load your order. Please try again.");
  }
};
