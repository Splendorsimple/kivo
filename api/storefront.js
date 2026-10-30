
const { createClient } = require("@supabase/supabase-js");
const { clientKey, allow, tooMany } = require("./_ratelimit");

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "GET") {
    return res.status(405).json({
      success: false,
      error: "Method not allowed."
    });
  }

  const slug =
    typeof req.query.slug === "string"
      ? req.query.slug.trim()
      : "";

  if (!slug || !/^[a-z0-9-]+$/.test(slug)) {
    return res.status(400).json({
      success: false,
      error: "A valid store slug is required."
    });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    return res.status(500).json({
      success: false,
      error: "Server configuration is incomplete."
    });
  }

  try {
    const supabase = createClient(
      supabaseUrl,
      serviceRoleKey,
      {
        auth: {
          persistSession: false,
          autoRefreshToken: false
        }
      }
    );

    if (!(await allow(supabase, "storefront:ip:" + clientKey(req), 120, 60))) {
      return tooMany(res, 60);
    }

    const { data: store, error: storeError } = await supabase
      .from("stores")
      .select("id, name, slug, description, logo_url, currency")
      .eq("slug", slug)
      .eq("status", "published")
      .maybeSingle();

    if (storeError) {
      throw storeError;
    }

    if (!store) {
      return res.status(404).json({
        success: false,
        error: "Store not found."
      });
    }

    const { data: products, error: productsError } = await supabase
      .from("products")
      .select(
        "id, name, slug, description, price_ngn, compare_at_price_ngn, track_inventory, product_images(storage_path, is_primary, sort_order), inventory(quantity, reserved_quantity, variant_id)"
      )
      .eq("store_id", store.id)
      .eq("status", "published")
      .order("created_at", { ascending: false });

    if (productsError) {
      throw productsError;
    }

    // Shape products for the public page: image URLs and an in-stock flag.
    // Exact stock quantities are never exposed.
    const imageBase =
      supabaseUrl.replace(/\/$/, "") +
      "/storage/v1/object/public/product-images/";

    const publicProducts = (products || []).map((product) => {
      const images = (product.product_images || [])
        .slice()
        .sort(
          (a, b) =>
            Number(b.is_primary) - Number(a.is_primary) ||
            a.sort_order - b.sort_order
        )
        .map(
          (image) =>
            imageBase +
            image.storage_path.split("/").map(encodeURIComponent).join("/")
        );

      const stockRow = (product.inventory || []).find(
        (row) => !row.variant_id
      );

      // How many a customer can order right now: stock minus what is held
      // for confirmed orders, capped at 20 so large stock levels stay private.
      const tracked = product.track_inventory && stockRow;
      const free = tracked
        ? Math.max(0, stockRow.quantity - (stockRow.reserved_quantity || 0))
        : 20;
      const maxQty = Math.min(free, 20);

      return {
        id: product.id,
        name: product.name,
        slug: product.slug,
        description: product.description,
        price_ngn: product.price_ngn,
        compare_at_price_ngn: product.compare_at_price_ngn,
        images,
        in_stock: maxQty > 0,
        max_qty: maxQty
      };
    });

    // Public contact details. Only these four fields are ever exposed,
    // and only for a published store. A failure here must not break the
    // storefront, so the contact simply comes back empty.
    let contact = {
      whatsapp: null,
      phone: null,
      email: null,
      socials: []
    };

    // Social links are built here from a fixed list of platforms, so the
    // public page only ever receives safe https links.
    const SOCIAL_URLS = {
      instagram: ["Instagram", (h) => "https://instagram.com/" + h],
      tiktok: ["TikTok", (h) => "https://www.tiktok.com/@" + h],
      facebook: ["Facebook", (h) => "https://facebook.com/" + h],
      x: ["X", (h) => "https://x.com/" + h],
      youtube: ["YouTube", (h) => "https://youtube.com/@" + h],
      snapchat: ["Snapchat", (h) => "https://snapchat.com/add/" + h],
      telegram: ["Telegram", (h) => "https://t.me/" + h]
    };

    const { data: settingsRow, error: settingsError } = await supabase
      .from("store_settings")
      .select("settings")
      .eq("store_id", store.id)
      .maybeSingle();

    if (settingsError) {
      console.error("Storefront contact lookup failed:", settingsError.message);
    } else {
      const saved =
        settingsRow &&
        settingsRow.settings &&
        typeof settingsRow.settings.contact === "object" &&
        settingsRow.settings.contact
          ? settingsRow.settings.contact
          : {};

      const clean = (value) =>
        typeof value === "string" && value.trim()
          ? value.trim().slice(0, 200)
          : null;

      let savedSocials = Array.isArray(saved.socials) ? saved.socials : [];

      // Older stores saved a single Instagram handle.
      if (!savedSocials.length && clean(saved.instagram)) {
        savedSocials = [{ platform: "instagram", handle: saved.instagram }];
      }

      const socials = [];

      for (const item of savedSocials.slice(0, 7)) {
        const entry = item && SOCIAL_URLS[item.platform];
        const handle = item && typeof item.handle === "string" ? item.handle.trim() : "";

        if (entry && /^[A-Za-z0-9._-]{1,50}$/.test(handle)) {
          socials.push({
            platform: item.platform,
            label: entry[0],
            url: entry[1](encodeURIComponent(handle))
          });
        }
      }

      contact = {
        whatsapp: clean(saved.whatsapp),
        phone: clean(saved.phone),
        email: clean(saved.email),
        socials
      };
    }

    const { data: methodRows } = await supabase
      .from("store_payment_methods")
      .select("id, method_type, display_name")
      .eq("store_id", store.id)
      .eq("is_enabled", true)
      .order("sort_order")
      .order("created_at");

    const paymentMethods = (methodRows || []).map((m) => ({
      id: m.id,
      type: m.method_type,
      label: m.display_name
    }));

    return res.status(200).json({
      success: true,
      store,
      payment_methods: paymentMethods,
      contact,
      products: publicProducts
    });
  } catch (error) {
    console.error("Storefront API error:", error.message);

    return res.status(500).json({
      success: false,
      error: "Unable to load this storefront."
    });
  }
};
        
