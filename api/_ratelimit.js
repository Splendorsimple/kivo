const crypto = require("crypto");

const hash = (v) => crypto.createHash("sha256").update(String(v)).digest("hex").slice(0, 24);

// A short, anonymous fingerprint of the caller. Raw IP addresses are never stored.
exports.clientKey = (req) => {
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0];
  return hash(String(req.headers["x-real-ip"] || forwarded || "unknown").trim());
};

exports.hash = hash;

// Returns true when the caller may continue. If the limiter itself has a
// problem, real customers are let through rather than blocked.
exports.allow = async (supabase, key, limit, windowSeconds) => {
  try {
    const { data, error } = await supabase.rpc("check_rate_limit", {
      p_key: key,
      p_limit: limit,
      p_window_seconds: windowSeconds
    });
    if (error) {
      console.error("Rate limit check failed:", error.message);
      return true;
    }
    return data !== false;
  } catch (e) {
    console.error("Rate limit check failed:", e.message);
    return true;
  }
};

exports.tooMany = (res, windowSeconds) => {
  res.setHeader("Retry-After", String(windowSeconds));
  return res.status(429).json({
    success: false,
    error: "Too many requests. Please wait a few minutes and try again."
  });
};

