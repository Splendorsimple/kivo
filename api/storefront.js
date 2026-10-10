
const { createClient } = require("@supabase/supabase-js");

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
        "id, name, slug, description, price_ngn, compare_at_price_ngn"
      )
      .eq("store_id", store.id)
      .eq("status", "published")
      .order("created_at", { ascending: false });

    if (productsError) {
      throw productsError;
    }

    return res.status(200).json({
      success: true,
      store,
      products: products || []
    });
  } catch (error) {
    console.error("Storefront API error:", error.message);

    return res.status(500).json({
      success: false,
      error: "Unable to load this storefront."
    });
  }
};
