const crypto = require("crypto");
const { trackKey, trackUrl, originOf } = require("./_track");
const { createClient } = require("@supabase/supabase-js");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const money = (n) => "₦" + Number(n).toLocaleString("en-NG");
const str = (v, n) => (typeof v === "string" ? v.slice(0, n) : "");
function paymentDetails(m) {
  const c = m.config || {};
  if (m.type === "bank_transfer") {
    return { bank_name: str(c.bank_name, 60), account_number: str(c.account_number, 20), account_name: str(c.account_name, 100) };
  }
  if (m.type === "online" && typeof c.url === "string" && c.url.startsWith("https://")) {
    return { url: c.url.slice(0, 300) };
  }
  return null;
}
const fail = (res, status, error) => res.status(status).json({ success: false, error });

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") return fail(res, 405, "Method not allowed.");

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) return fail(res, 500, "Server configuration is incomplete.");

  let body = req.body;
  try {
    if (typeof body === "string") body = JSON.parse(body);
  } catch (e) {
    return fail(res, 400, "Invalid request.");
  }
  body = body && typeof body === "object" ? body : {};

  // ---- Validate input (nothing from the browser is trusted for prices) ----
  const slug = typeof body.slug === "string" ? body.slug.trim().toLowerCase() : "";
  if (!/^[a-z0-9-]{1,60}$/.test(slug)) return fail(res, 400, "Invalid store.");

  const methodId = typeof body.payment_method_id === "string" ? body.payment_method_id : "";
  if (methodId && methodId !== "whatsapp" && !UUID.test(methodId)) {
    return fail(res, 400, "Please choose how you would like to pay.");
  }

  const wanted = new Map();
  const rawItems = Array.isArray(body.items) ? body.items.slice(0, 30) : [];
  for (const item of rawItems) {
    const id = item && item.product_id;
    const qty = item && Number(item.quantity);
    if (typeof id !== "string" || !UUID.test(id) || !Number.isInteger(qty) || qty < 1 || qty > 20) {
      return fail(res, 400, "Your cart has an invalid item.");
    }
    wanted.set(id, Math.min(20, (wanted.get(id) || 0) + qty));
  }
  if (!wanted.size) return fail(res, 400, "Your cart is empty.");

  const c = body.customer && typeof body.customer === "object" ? body.customer : {};
  const text = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  const name = text(c.name, 100);
  const phone = text(c.phone, 30).replace(/[\s()-]/g, "");
  const address = text(c.address, 300);
  const city = text(c.city, 80);
  const note = text(c.note, 500);

  if (name.length < 2) return fail(res, 400, "Please enter your name.");
  if (!/^\+?\d{8,15}$/.test(phone)) return fail(res, 400, "Please enter a valid phone number.");
  if (address.length < 5) return fail(res, 400, "Please enter your delivery address.");
  if (city.length < 2) return fail(res, 400, "Please enter your city.");

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false }
  });

  let customerId = null;
  let orderId = null;
  const claimToken = crypto.randomBytes(16).toString("hex");

  try {
    const { data: store, error: storeError } = await supabase
      .from("stores").select("id, name").eq("slug", slug).eq("status", "published").maybeSingle();
    if (storeError) throw storeError;
    if (!store) return fail(res, 404, "This store is not open right now.");

    // Payment options come from the seller's saved settings, never the browser.
    const { data: settingsRow } = await supabase
      .from("store_settings").select("settings").eq("store_id", store.id).maybeSingle();
    const waNumber = settingsRow && settingsRow.settings && settingsRow.settings.contact
      ? String(settingsRow.settings.contact.whatsapp || "").replace(/\D/g, "") : "";

    const { data: methodRows, error: methodError } = await supabase
      .from("store_payment_methods").select("id, method_type, display_name, public_config")
      .eq("store_id", store.id).eq("is_enabled", true).order("sort_order").order("created_at");
    if (methodError) throw methodError;

    let method;
    if (methodId === "whatsapp" || (!methodId && waNumber)) {
      if (!waNumber) return fail(res, 400, "Please choose how you would like to pay.");
      method = { type: "whatsapp", label: "WhatsApp", config: {} };
    } else {
      const row = methodId ? (methodRows || []).find((m) => m.id === methodId) : (methodRows || [])[0];
      if (methodId && !row) return fail(res, 400, "That payment option is no longer available.");
      method = row
        ? { type: row.method_type, label: row.display_name, config: row.public_config || {} }
        : { type: "other", label: "Pay the seller directly", config: {} };
    }

    // Prices and availability always come from the database.
    const ids = Array.from(wanted.keys());
    const { data: products, error: productError } = await supabase
      .from("products").select("id, name, price_ngn, track_inventory")
      .eq("store_id", store.id).eq("status", "published").in("id", ids);
    if (productError) throw productError;
    if (!products || products.length !== ids.length) {
      return fail(res, 409, "Some items in your cart are no longer available.");
    }

    const { data: stock, error: stockError } = await supabase
      .from("inventory").select("product_id, quantity, variant_id").in("product_id", ids);
    if (stockError) throw stockError;

    const lines = [];
    let subtotal = 0;
    for (const p of products) {
      const qty = wanted.get(p.id);
      const row = (stock || []).find((r) => r.product_id === p.id && !r.variant_id);
      if (p.track_inventory && row && row.quantity < qty) {
        return fail(res, 409, p.name + " only has " + row.quantity + " left in stock.");
      }
      const lineTotal = Number(p.price_ngn) * qty;
      subtotal += lineTotal;
      lines.push({ p, qty, lineTotal });
    }

    const { data: customer, error: customerError } = await supabase
      .from("customers").insert({ store_id: store.id, full_name: name, phone }).select("id").single();
    if (customerError) throw customerError;
    customerId = customer.id;

    let order = null;
    for (let attempt = 0; attempt < 5 && !order; attempt++) {
      const orderNumber = "KIV-" + crypto.randomBytes(4).toString("hex").toUpperCase().slice(0, 6);
      const { data, error } = await supabase.from("orders").insert({
        store_id: store.id,
        customer_id: customerId,
        order_number: orderNumber,
        source: method.type === "whatsapp" ? "whatsapp" : "storefront",
        payment_method: method.type,
        tracking_token_hash: crypto.createHash("sha256").update(claimToken).digest("hex"),
        order_status: "pending",
        payment_status: "unpaid",
        subtotal_ngn: subtotal,
        shipping_ngn: 0,
        discount_ngn: 0,
        tax_ngn: 0,
        total_ngn: subtotal,
        shipping_address: { name, phone, address, city },
        customer_note: note || null
      }).select("id, order_number").single();

      if (error && error.code !== "23505") throw error;
      if (!error) order = data;
    }
    if (!order) throw new Error("Could not create an order number.");
    orderId = order.id;

    const { error: itemsError } = await supabase.from("order_items").insert(
      lines.map((l) => ({
        order_id: orderId,
        store_id: store.id,
        product_id: l.p.id,
        product_name: l.p.name,
        unit_price_ngn: Number(l.p.price_ngn),
        quantity: l.qty,
        discount_ngn: 0,
        line_total_ngn: l.lineTotal
      }))
    );
    if (itemsError) throw itemsError;

    const trackLink = trackUrl(originOf(req), slug, order.order_number, trackKey(serviceRoleKey, order.id));
    let whatsappUrl = null;
    const wa = waNumber;

    if (wa) {
      const message =
        "Hi " + store.name + (["bank_transfer", "online"].includes(method.type) ? ", I have paid for order " : ", I just placed order ") + order.order_number + ":\n" +
        lines.map((l) => "- " + l.qty + " x " + l.p.name + " (" + money(l.lineTotal) + ")").join("\n") +
        "\nTotal: " + money(subtotal) + "\nPayment: " + method.label +
        "\nName: " + name + "\nPhone: " + phone +
        "\nAddress: " + address + ", " + city +
        (note ? "\nNote: " + note : "") +
        (["bank_transfer", "online"].includes(method.type) ? "\nI will attach my payment receipt here." : "") +
        "\nTrack this order: " + trackLink;
      whatsappUrl = "https://wa.me/" + wa + "?text=" + encodeURIComponent(message);
    }

    return res.status(201).json({
      success: true,
      order_number: order.order_number,
      claim_token: claimToken,
      track_url: trackLink,
      total_ngn: subtotal,
      payment: { type: method.type, label: method.label, details: paymentDetails(method) },
      whatsapp_url: whatsappUrl
    });
  } catch (error) {
    console.error("Order creation failed:", error);
    try {
      if (orderId) {
        await supabase.from("order_items").delete().eq("order_id", orderId);
        await supabase.from("orders").delete().eq("id", orderId);
      }
      if (customerId) await supabase.from("customers").delete().eq("id", customerId);
    } catch (cleanupError) {
      console.error("Order cleanup failed:", cleanupError);
    }
    return fail(res, 500, "We could not place your order. Please try again.");
  }
};
        
