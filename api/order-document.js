const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");
const { trackKey } = require("./_track");
const { clientKey, allow, tooMany } = require("./_ratelimit");

const fail = (res, status, error) => res.status(status).json({ success: false, error });
const text = (v, n) => (typeof v === "string" ? v.slice(0, n) : "");

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
    return fail(res, 404, "We could not find that document.");
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });
  if (!(await allow(supabase, "doc:ip:" + clientKey(req), 60, 600))) return tooMany(res, 600);

  try {
    const { data: store, error: storeError } = await supabase.from("stores").select("id, name, logo_url").eq("slug", slug).maybeSingle();
    if (storeError) throw storeError;
    if (!store) return fail(res, 404, "We could not find that document.");

    const { data: order, error: orderError } = await supabase
      .from("orders")
      .select("id, order_number, order_status, payment_status, payment_method, subtotal_ngn, shipping_ngn, discount_ngn, tax_ngn, total_ngn, created_at, shipping_address, order_items(product_name, variant_name, quantity, unit_price_ngn, line_total_ngn)")
      .eq("store_id", store.id).eq("order_number", num).maybeSingle();
    if (orderError) throw orderError;

    // Same private key as the tracking link: only the customer and seller hold it.
    const expected = order ? Buffer.from(trackKey(serviceRoleKey, order.id)) : null;
    const given = Buffer.from(key);
    if (!expected || expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) {
      return fail(res, 404, "We could not find that document.");
    }

    const paid = order.payment_status === "paid";
    let paidAt = null;
    if (paid) {
      const { data: pay } = await supabase.from("sales_payments").select("paid_at")
        .eq("order_id", order.id).eq("status", "successful").order("paid_at", { ascending: false }).limit(1);
      paidAt = pay && pay[0] ? pay[0].paid_at : null;
    }

    const { data: settingsRow } = await supabase.from("store_settings").select("settings").eq("store_id", store.id).maybeSingle();
    const c = (settingsRow && settingsRow.settings && settingsRow.settings.contact) || {};

    // How to pay, shown on invoices only.
    let payInfo = null;
    if (!paid && order.order_status !== "cancelled" && order.payment_method) {
      const { data: m } = await supabase.from("store_payment_methods").select("display_name, public_config")
        .eq("store_id", store.id).eq("method_type", order.payment_method).eq("is_enabled", true).limit(1);
      const cfg = (m && m[0] && m[0].public_config) || {};
      payInfo = { type: order.payment_method, label: m && m[0] ? m[0].display_name : null };
      if (order.payment_method === "bank_transfer") {
        payInfo.bank_name = text(cfg.bank_name, 60);
        payInfo.account_number = text(cfg.account_number, 20);
        payInfo.account_name = text(cfg.account_name, 100);
      } else if (order.payment_method === "online" && typeof cfg.url === "string" && cfg.url.startsWith("https://")) {
        payInfo.url = cfg.url.slice(0, 300);
      }
    }

    const a = order.shipping_address || {};
    return res.status(200).json({
      success: true,
      store: { name: store.name, logo_url: store.logo_url || null },
      contact: {
        whatsapp: text(c.whatsapp, 30).replace(/\D/g, "") || null,
        phone: text(c.phone, 30) || null,
        email: text(c.email, 120) || null
      },
      pay_info: payInfo,
      order: {
        order_number: order.order_number,
        order_status: order.order_status,
        payment_status: order.payment_status,
        payment_method: order.payment_method,
        created_at: order.created_at,
        paid_at: paidAt,
        subtotal_ngn: order.subtotal_ngn,
        shipping_ngn: order.shipping_ngn,
        discount_ngn: order.discount_ngn,
        tax_ngn: order.tax_ngn,
        total_ngn: order.total_ngn,
        customer: { name: text(a.name, 100), phone: text(a.phone, 30), address: text(a.address, 300), city: text(a.city, 80) },
        items: (order.order_items || []).map((i) => ({
          name: i.product_name, variant: i.variant_name || null, quantity: i.quantity,
          unit_price_ngn: i.unit_price_ngn, line_total_ngn: i.line_total_ngn
        }))
      }
    });
  } catch (error) {
    console.error("Order document failed:", error);
    return fail(res, 500, "We could not load this document. Please try again.");
  }
};
                              
