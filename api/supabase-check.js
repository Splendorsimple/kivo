
module.exports = async function handler(req, res) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseKey) {
    return res.status(500).json({
      success: false,
      message: "Supabase environment variables are missing."
    });
  }

  try {
    const response = await fetch(
      `${supabaseUrl.replace(/\/$/, "")}/rest/v1/`,
      {
        headers: {
          apikey: supabaseKey,
          Authorization: `Bearer ${supabaseKey}`
        }
      }
    );

    if (!response.ok) {
      return res.status(502).json({
        success: false,
        message: "Supabase responded with an error.",
        status: response.status
      });
    }

    return res.status(200).json({
      success: true,
      message: "Kivo backend connected to Supabase."
    });
  } catch {
    return res.status(502).json({
      success: false,
      message: "Could not connect to Supabase."
    });
  }
};
