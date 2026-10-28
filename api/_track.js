const crypto = require("crypto");

// A private tracking key for each order. It is derived on the server, so it
// never needs to be stored, and nobody can guess it without the secret.
exports.trackKey = (secret, orderId) =>
  crypto.createHmac("sha256", secret).update("track:" + orderId).digest("hex").slice(0, 24);

exports.trackUrl = (origin, slug, orderNumber, key) =>
  origin + "/t/" + slug + "?o=" + orderNumber + "&k=" + key;

exports.originOf = (req) => "https://" + String(req.headers.host || "kivo-bay.vercel.app");
