const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const db = require('./db');
const { sign, auth } = require('./auth');

const app = express();
app.use(cors());
app.use(express.json());

const STATUS = ['Diterima', 'Dimasak', 'Siap', 'Dikirim', 'Selesai'];

app.get('/api/health', (_, res) => res.json({ status: 'ok' }));

// ---- Auth
app.post('/api/auth/register', (req, res) => {
  const { nama, email, password, role = 'mahasiswa' } = req.body || {};
  if (!nama || !email || !password || password.length < 6) return res.status(400).json({ error: 'Nama, email, dan password (min 6 karakter) wajib diisi' });
  if (role !== 'mahasiswa') return res.status(400).json({ error: 'Pendaftaran publik hanya untuk mahasiswa' });
  if (db.prepare('SELECT 1 FROM users WHERE email=?').get(email)) return res.status(409).json({ error: 'Email sudah terdaftar' });
  const info = db.prepare('INSERT INTO users(nama,email,password_hash,role) VALUES(?,?,?,?)').run(nama, email, bcrypt.hashSync(password, 10), role);
  const user = db.prepare('SELECT id,nama,email,role,kios_id FROM users WHERE id=?').get(info.lastInsertRowid);
  res.status(201).json({ token: sign(user), user });
});
app.post('/api/auth/login', (req, res) => {
  const { email, password, username } = req.body || {};
  // Login bisa memakai email, nama, atau bagian email sebelum '@' (mis. "esgul")
  const loginId = String(email || username || '').trim().toLowerCase();
  const u = loginId && db.prepare(
    `SELECT * FROM users
     WHERE lower(email)=? OR lower(nama)=? OR lower(substr(email,1,instr(email,'@')-1))=?
     ORDER BY CASE WHEN lower(email)=? THEN 0 ELSE 1 END
     LIMIT 1`
  ).get(loginId, loginId, loginId, loginId);
  if (!u || !bcrypt.compareSync(String(password || ''), u.password_hash)) return res.status(401).json({ error: 'Email atau password salah' });
  const user = { id: u.id, nama: u.nama, email: u.email, role: u.role, kios_id: u.kios_id };
  res.json({ token: sign(user), user });
});

// ---- Kios & Menu
app.get('/api/kios', (_, res) => res.json(db.prepare('SELECT * FROM kios').all()));
app.get('/api/menu', (req, res) => {
  const { q = '', kategori, kios_id } = req.query;
  let sql = 'SELECT m.*, k.nama AS kios_nama FROM menu m JOIN kios k ON k.id=m.kios_id WHERE m.nama LIKE ?';
  const p = [`%${q}%`];
  if (kategori) { sql += ' AND m.kategori=?'; p.push(kategori); }
  if (kios_id) { sql += ' AND m.kios_id=?'; p.push(kios_id); }
  res.json(db.prepare(sql + ' ORDER BY m.id').all(...p));
});
function validMenu(b) {
  return b && b.nama && Number.isInteger(b.harga) && b.harga >= 0 && b.kategori && Number.isInteger(b.stok) && b.stok >= 0;
}
app.post('/api/menu', auth(['penjual']), (req, res) => {
  if (!validMenu(req.body)) return res.status(400).json({ error: 'Data menu tidak valid' });
  const b = req.body;
  const info = db.prepare('INSERT INTO menu(kios_id,nama,harga,kategori,stok,tersedia) VALUES(?,?,?,?,?,?)').run(req.user.kios_id, b.nama, b.harga, b.kategori, b.stok, b.tersedia === false ? 0 : 1);
  res.status(201).json(db.prepare('SELECT * FROM menu WHERE id=?').get(info.lastInsertRowid));
});
app.put('/api/menu/:id', auth(['penjual']), (req, res) => {
  const m = db.prepare('SELECT * FROM menu WHERE id=?').get(req.params.id);
  if (!m) return res.status(404).json({ error: 'Menu tidak ditemukan' });
  if (m.kios_id !== req.user.kios_id) return res.status(403).json({ error: 'Bukan menu kios Anda' });
  const b = { ...m, ...req.body };
  if (!validMenu(b)) return res.status(400).json({ error: 'Data menu tidak valid' });
  db.prepare('UPDATE menu SET nama=?,harga=?,kategori=?,stok=?,tersedia=? WHERE id=?').run(b.nama, b.harga, b.kategori, b.stok, b.tersedia ? 1 : 0, m.id);
  res.json(db.prepare('SELECT * FROM menu WHERE id=?').get(m.id));
});
app.delete('/api/menu/:id', auth(['penjual']), (req, res) => {
  const m = db.prepare('SELECT * FROM menu WHERE id=?').get(req.params.id);
  if (!m) return res.status(404).json({ error: 'Menu tidak ditemukan' });
  if (m.kios_id !== req.user.kios_id) return res.status(403).json({ error: 'Bukan menu kios Anda' });
  try { db.prepare('DELETE FROM menu WHERE id=?').run(m.id); }
  catch { db.prepare('UPDATE menu SET tersedia=0 WHERE id=?').run(m.id); return res.json({ message: 'Menu sudah pernah dipesan, ditandai tidak tersedia' }); }
  res.json({ message: 'Menu dihapus' });
});

// ---- Orders
const withItems = (o) => ({ ...o, items: db.prepare('SELECT menu_id,nama,harga,jumlah FROM order_items WHERE order_id=?').all(o.id) });

app.post('/api/orders', auth(['mahasiswa']), (req, res) => {
  const { items, jam_ambil, metode_pembayaran = 'QRIS', status_pembayaran = 'Sudah Dibayar' } = req.body || {};
  if (!Array.isArray(items) || !items.length || !jam_ambil) return res.status(400).json({ error: 'Item pesanan dan jam ambil wajib diisi' });
  try {
    const result = db.transaction(() => {
      let kios = null, total = 0;
      const rows = [];
      for (const it of items) {
        const jumlah = Number(it.jumlah);
        if (!Number.isInteger(jumlah) || jumlah < 1) throw new Error('Jumlah tidak valid');
        const m = db.prepare('SELECT * FROM menu WHERE id=?').get(it.menu_id);
        if (!m || !m.tersedia) throw new Error('Menu tidak tersedia');
        if (kios !== null && kios !== m.kios_id) throw new Error('Satu pesanan hanya untuk satu kios');
        if (m.stok < jumlah) throw new Error(`Stok ${m.nama} tidak cukup`);
        kios = m.kios_id; total += m.harga * jumlah; rows.push({ m, jumlah });
      }
      const no = db.prepare("SELECT COUNT(*)+1 AS n FROM orders WHERE kios_id=? AND date(created_at)=date('now')").get(kios).n;
      const isPaid = status_pembayaran === 'Sudah Dibayar';
      const waktuBayar = isPaid ? new Date().toISOString() : null;
      const info = db.prepare('INSERT INTO orders(user_id,kios_id,jam_ambil,nomor_antrean,total,status_pembayaran,metode_pembayaran,waktu_bayar) VALUES(?,?,?,?,?,?,?,?)')
        .run(req.user.id, kios, jam_ambil, no, total, isPaid ? 'Sudah Dibayar' : 'Belum Dibayar', metode_pembayaran, waktuBayar);

      const orderId = info.lastInsertRowid;
      for (const { m, jumlah } of rows) {
        db.prepare('INSERT INTO order_items(order_id,menu_id,nama,harga,jumlah) VALUES(?,?,?,?,?)').run(orderId, m.id, m.nama, m.harga, jumlah);
        db.prepare('UPDATE menu SET stok=stok-? WHERE id=?').run(jumlah, m.id);
      }

      // Notifikasi otomatis ke penjual ketika pembayaran telah dilakukan
      if (isPaid) {
        db.prepare(`
          INSERT INTO notifications(user_id, kios_id, order_id, judul, pesan, tipe)
          VALUES(?,?,?,?,?,?)
        `).run(
          null,
          kios,
          orderId,
          'Pembayaran Diterima',
          `Pesanan #${no} dari ${req.user.nama} telah dibayar (${metode_pembayaran}) sebesar Rp${total.toLocaleString('id-ID')}.`,
          'pembayaran'
        );
      }

      return orderId;
    })();
    res.status(201).json(withItems(db.prepare('SELECT * FROM orders WHERE id=?').get(result)));
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.get('/api/orders', auth(), (req, res) => {
  const rows = req.user.role === 'penjual'
    ? db.prepare('SELECT o.*, u.nama AS pemesan, k.nama AS kios_nama FROM orders o JOIN users u ON u.id=o.user_id JOIN kios k ON k.id=o.kios_id WHERE o.kios_id=? ORDER BY o.id DESC').all(req.user.kios_id)
    : db.prepare('SELECT o.*, k.nama AS kios_nama FROM orders o JOIN kios k ON k.id=o.kios_id WHERE o.user_id=? ORDER BY o.id DESC').all(req.user.id);
  res.json(rows.map(withItems));
});

// Pembeli melakukan pembayaran untuk pesanan yang belum dibayar
app.post('/api/orders/:id/bayar', auth(['mahasiswa']), (req, res) => {
  const o = db.prepare('SELECT o.*, u.nama AS pemesan FROM orders o JOIN users u ON u.id=o.user_id WHERE o.id=?').get(req.params.id);
  if (!o) return res.status(404).json({ error: 'Pesanan tidak ditemukan' });
  if (o.user_id !== req.user.id) return res.status(403).json({ error: 'Bukan pesanan Anda' });
  if (o.status_pembayaran === 'Sudah Dibayar') return res.status(400).json({ error: 'Pesanan sudah dibayar' });

  const { metode_pembayaran = 'QRIS' } = req.body || {};
  const waktuBayar = new Date().toISOString();
  db.prepare('UPDATE orders SET status_pembayaran=?, metode_pembayaran=?, waktu_bayar=? WHERE id=?')
    .run('Sudah Dibayar', metode_pembayaran, waktuBayar, o.id);

  // Kirim notifikasi pembayaran ke penjual
  db.prepare(`
    INSERT INTO notifications(user_id, kios_id, order_id, judul, pesan, tipe)
    VALUES(?,?,?,?,?,?)
  `).run(
    null,
    o.kios_id,
    o.id,
    'Pembayaran Diterima',
    `Pesanan #${o.nomor_antrean} dari ${req.user.nama} telah dibayar (${metode_pembayaran}) sebesar Rp${o.total.toLocaleString('id-ID')}.`,
    'pembayaran'
  );

  res.json(withItems(db.prepare('SELECT * FROM orders WHERE id=?').get(o.id)));
});

// Penjual memperbarui status pesanan
app.patch('/api/orders/:id/status', auth(['penjual']), (req, res) => {
  const { status } = req.body || {};
  if (!STATUS.includes(status)) return res.status(400).json({ error: 'Status tidak valid' });
  const o = db.prepare('SELECT o.*, k.nama AS kios_nama FROM orders o JOIN kios k ON k.id=o.kios_id WHERE o.id=?').get(req.params.id);
  if (!o) return res.status(404).json({ error: 'Pesanan tidak ditemukan' });
  if (o.kios_id !== req.user.kios_id) return res.status(403).json({ error: 'Bukan pesanan kios Anda' });

  let waktuKirim = o.waktu_kirim;
  let waktuSelesai = o.waktu_selesai;
  if (status === 'Dikirim' && !waktuKirim) waktuKirim = new Date().toISOString();
  if (status === 'Selesai' && !waktuSelesai) waktuSelesai = new Date().toISOString();

  db.prepare('UPDATE orders SET status=?, waktu_kirim=?, waktu_selesai=? WHERE id=?').run(status, waktuKirim, waktuSelesai, o.id);

  // Jika penjual mengubah status menjadi Dikirim -> kirim notifikasi ke pembeli
  if (status === 'Dikirim') {
    db.prepare(`
      INSERT INTO notifications(user_id, kios_id, order_id, judul, pesan, tipe)
      VALUES(?,?,?,?,?,?)
    `).run(
      o.user_id,
      o.kios_id,
      o.id,
      'Pesanan Sedang Dikirim',
      `Kios ${o.kios_nama} telah mengirimkan pesanan #${o.nomor_antrean}. Silakan konfirmasi jika sudah menerima pesanan.`,
      'pengiriman'
    );
  }

  res.json(withItems(db.prepare('SELECT * FROM orders WHERE id=?').get(o.id)));
});

// Penjual mengirimkan konfirmasi sudah mengirim pesanan
app.post('/api/orders/:id/kirim', auth(['penjual']), (req, res) => {
  const o = db.prepare('SELECT o.*, k.nama AS kios_nama FROM orders o JOIN kios k ON k.id=o.kios_id WHERE o.id=?').get(req.params.id);
  if (!o) return res.status(404).json({ error: 'Pesanan tidak ditemukan' });
  if (o.kios_id !== req.user.kios_id) return res.status(403).json({ error: 'Bukan pesanan kios Anda' });
  if (o.status === 'Selesai') return res.status(400).json({ error: 'Pesanan sudah selesai' });

  const waktuKirim = new Date().toISOString();
  db.prepare("UPDATE orders SET status='Dikirim', waktu_kirim=? WHERE id=?").run(waktuKirim, o.id);

  // Kirim notifikasi ke pembeli
  db.prepare(`
    INSERT INTO notifications(user_id, kios_id, order_id, judul, pesan, tipe)
    VALUES(?,?,?,?,?,?)
  `).run(
    o.user_id,
    o.kios_id,
    o.id,
    'Pesanan Sedang Dikirim',
    `Kios ${o.kios_nama} telah mengirimkan pesanan #${o.nomor_antrean}. Silakan konfirmasi jika pesanan sudah Anda terima.`,
    'pengiriman'
  );

  res.json(withItems(db.prepare('SELECT * FROM orders WHERE id=?').get(o.id)));
});

// Pembeli memberikan konfirmasi sudah menerima pesanan
app.post('/api/orders/:id/konfirmasi-terima', auth(['mahasiswa']), (req, res) => {
  const o = db.prepare('SELECT o.*, u.nama AS pemesan, k.nama AS kios_nama FROM orders o JOIN users u ON u.id=o.user_id JOIN kios k ON k.id=o.kios_id WHERE o.id=?').get(req.params.id);
  if (!o) return res.status(404).json({ error: 'Pesanan tidak ditemukan' });
  if (o.user_id !== req.user.id) return res.status(403).json({ error: 'Bukan pesanan Anda' });
  if (o.status === 'Selesai') return res.status(400).json({ error: 'Pesanan sudah selesai' });

  const waktuSelesai = new Date().toISOString();
  db.prepare("UPDATE orders SET status='Selesai', waktu_selesai=? WHERE id=?").run(waktuSelesai, o.id);

  // Kirim notifikasi ke penjual bahwa pembeli telah menerima pesanan
  db.prepare(`
    INSERT INTO notifications(user_id, kios_id, order_id, judul, pesan, tipe)
    VALUES(?,?,?,?,?,?)
  `).run(
    null,
    o.kios_id,
    o.id,
    'Pesanan Telah Diterima',
    `Pembeli ${o.pemesan} telah mengonfirmasi bahwa pesanan #${o.nomor_antrean} sudah diterima dengan baik. Pesanan selesai!`,
    'penerimaan'
  );

  res.json(withItems(db.prepare('SELECT * FROM orders WHERE id=?').get(o.id)));
});

// ---- Notifications
app.get('/api/notifications', auth(), (req, res) => {
  const rows = req.user.role === 'penjual'
    ? db.prepare('SELECT * FROM notifications WHERE kios_id=? ORDER BY id DESC LIMIT 50').all(req.user.kios_id)
    : db.prepare('SELECT * FROM notifications WHERE user_id=? ORDER BY id DESC LIMIT 50').all(req.user.id);
  res.json(rows);
});

app.patch('/api/notifications/:id/baca', auth(), (req, res) => {
  const notif = db.prepare('SELECT * FROM notifications WHERE id=?').get(req.params.id);
  if (!notif) return res.status(404).json({ error: 'Notifikasi tidak ditemukan' });
  if (req.user.role === 'penjual' && notif.kios_id !== req.user.kios_id) return res.status(403).json({ error: 'Akses ditolak' });
  if (req.user.role === 'mahasiswa' && notif.user_id !== req.user.id) return res.status(403).json({ error: 'Akses ditolak' });

  db.prepare('UPDATE notifications SET dibaca=1 WHERE id=?').run(notif.id);
  res.json({ message: 'Notifikasi ditandai dibaca' });
});

app.post('/api/notifications/baca-semua', auth(), (req, res) => {
  if (req.user.role === 'penjual') {
    db.prepare('UPDATE notifications SET dibaca=1 WHERE kios_id=?').run(req.user.kios_id);
  } else {
    db.prepare('UPDATE notifications SET dibaca=1 WHERE user_id=?').run(req.user.id);
  }
  res.json({ message: 'Semua notifikasi ditandai dibaca' });
});

module.exports = app;
