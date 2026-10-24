const jwt = require('jsonwebtoken');
const SECRET = process.env.JWT_SECRET || 'dev-secret-ganti-di-produksi';
const sign = (u) => jwt.sign({ id: u.id, role: u.role, kios_id: u.kios_id }, SECRET, { expiresIn: '1d' });
function auth(roles) {
  return (req, res, next) => {
    const h = req.headers.authorization || '';
    try {
      req.user = jwt.verify(h.replace('Bearer ', ''), SECRET);
    } catch { return res.status(401).json({ error: 'Silakan login terlebih dahulu' }); }
    if (roles && !roles.includes(req.user.role)) return res.status(403).json({ error: 'Akses ditolak' });
    next();
  };
}
module.exports = { sign, auth };
