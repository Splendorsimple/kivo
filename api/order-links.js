const { createClient } = require("@supabase/supabase-js");
const { trackKey, trackUrl, originOf } = require("./_track");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
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
  const ids = body && Array.isArray(body.order_ids) ? body.order_ids.filter((x) => typeof x === "string" && UUID.test(x)).slice(0, 100) : [];
  if (!ids.length) return res.status(200).json({ success: true, links: {} });

  const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });

  try {
    const { data: auth, error: authError } = await supabase.auth.getUser(token);
    if (authError || !auth || !auth.user) return fail(res, 401, "Please sign in again.");

    // Only the owner's own stores are looked at, so a link can never be made for someone else's order.
    const { data: stores, error: storeError } = await supabase.from("stores").select("id, slug").eq("owner_id", auth.user.id);
    if (storeError) throw storeError;
    const slugs = new Map((stores || []).map((s) => [s.id, s.slug]));
    if (!slugs.size) return res.status(200).json({ success: true, links: {} });

    const { data: orders, error: orderError } = await supabase
      .from("orders").select("id, order_number, store_id").in("id", ids).in("store_id", Array.from(slugs.keys()));
    if (orderError) throw orderError;

    const origin = originOf(req), links = {};
    for (const o of orders || []) {
      links[o.id] = trackUrl(origin, slugs.get(o.store_id), o.order_number, trackKey(serviceRoleKey, o.id));
    }
    return res.status(200).json({ success: true, links });
  } catch (error) {
    console.error("Order links failed:", error);
    return fail(res, 500, "Could not prepare tracking links.");
  }
};
    
