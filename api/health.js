
module.exports = function handler(req, res) {
  res.status(200).json({
    success: true,
    message: "Kivo backend is running."
  });
};
