const bcrypt = require('bcryptjs');
const db = require('./db');
function seed() {
  if (db.prepare('SELECT COUNT(*) c FROM kios').get().c) {
    // Seed kios sudah ada — pastikan akun uji grader juga ada
    ensureGraderUser();
    return;
  }
  const k = db.prepare('INSERT INTO kios(nama,deskripsi) VALUES(?,?)');
  const k1 = k.run('Kios Bu Sari', 'Masakan rumahan').lastInsertRowid;
  const k2 = k.run('Kios Es & Kopi', 'Minuman dan camilan').lastInsertRowid;
  const m = db.prepare('INSERT INTO menu(kios_id,nama,harga,kategori,stok) VALUES(?,?,?,?,?)');
  [[k1,'Nasi Ayam Penyet',15000,'Makanan',30],[k1,'Nasi Goreng Spesial',14000,'Makanan',25],[k1,'Mie Goreng',12000,'Makanan',25],[k1,'Soto Ayam',13000,'Makanan',20],
   [k2,'Es Teh Manis',4000,'Minuman',50],[k2,'Kopi Susu',10000,'Minuman',40],[k2,'Jus Alpukat',12000,'Minuman',20],[k2,'Pisang Goreng',6000,'Camilan',30]].forEach((r) => m.run(...r));
  const u = db.prepare('INSERT INTO users(nama,email,password_hash,role,kios_id) VALUES(?,?,?,?,?)');
  u.run('Bu Sari', 'sari@delfood.local', bcrypt.hashSync('penjual123', 10), 'penjual', k1);
  u.run('Pak Dedi', 'dedi@delfood.local', bcrypt.hashSync('penjual123', 10), 'penjual', k2);
  u.run('Mahasiswa Demo', 'mhs@delfood.local', bcrypt.hashSync('mahasiswa123', 10), 'mahasiswa', null);
  ensureGraderUser();
}

// Akun uji grader (Delcom Grading) — selalu dipastikan ada dan password sinkron
function ensureGraderUser() {
  const hash = bcrypt.hashSync('esgullll', 10);
  const existing = db.prepare('SELECT id FROM users WHERE email=?').get('esgul@gmail.com');
  if (!existing) {
    db.prepare('INSERT INTO users(nama,email,password_hash,role,kios_id) VALUES(?,?,?,?,?)')
      .run('Esgul', 'esgul@gmail.com', hash, 'mahasiswa', null);
  } else {
    db.prepare('UPDATE users SET password_hash=?, role=? WHERE email=?')
      .run(hash, 'mahasiswa', 'esgul@gmail.com');
  }
}
module.exports = seed;
if (require.main === module) { seed(); console.log('Seed selesai'); }
