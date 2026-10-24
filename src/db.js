// SQLite bawaan Node.js (node:sqlite, Node 22.13+) -> tidak perlu kompilasi native
const { DatabaseSync: Database } = require('node:sqlite');
const path = require('path');
const file = process.env.DB_FILE || path.join(__dirname, '..', 'delfood.db');
const db = new Database(file);
db.exec('PRAGMA foreign_keys = ON');
db.exec(`
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY AUTOINCREMENT, nama TEXT NOT NULL, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN('mahasiswa','penjual')), kios_id INTEGER);
CREATE TABLE IF NOT EXISTS kios(id INTEGER PRIMARY KEY AUTOINCREMENT, nama TEXT NOT NULL, deskripsi TEXT);
CREATE TABLE IF NOT EXISTS menu(id INTEGER PRIMARY KEY AUTOINCREMENT, kios_id INTEGER NOT NULL REFERENCES kios(id), nama TEXT NOT NULL, harga INTEGER NOT NULL CHECK(harga>=0), kategori TEXT NOT NULL, stok INTEGER NOT NULL DEFAULT 0 CHECK(stok>=0), tersedia INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS orders(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  kios_id INTEGER NOT NULL REFERENCES kios(id),
  jam_ambil TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'Diterima',
  nomor_antrean INTEGER NOT NULL,
  total INTEGER NOT NULL,
  status_pembayaran TEXT NOT NULL DEFAULT 'Sudah Dibayar',
  metode_pembayaran TEXT DEFAULT 'QRIS',
  waktu_bayar TEXT,
  waktu_kirim TEXT,
  waktu_selesai TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS order_items(id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER NOT NULL REFERENCES orders(id), menu_id INTEGER NOT NULL REFERENCES menu(id), nama TEXT NOT NULL, harga INTEGER NOT NULL, jumlah INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS notifications(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  kios_id INTEGER,
  order_id INTEGER REFERENCES orders(id),
  judul TEXT NOT NULL,
  pesan TEXT NOT NULL,
  tipe TEXT NOT NULL,
  dibaca INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`);

// Migrasi untuk database yang sudah ada jika kolom belum ada
try {
  const cols = db.prepare('PRAGMA table_info(orders)').all().map((c) => c.name);
  if (!cols.includes('status_pembayaran')) db.exec("ALTER TABLE orders ADD COLUMN status_pembayaran TEXT NOT NULL DEFAULT 'Sudah Dibayar'");
  if (!cols.includes('metode_pembayaran')) db.exec("ALTER TABLE orders ADD COLUMN metode_pembayaran TEXT DEFAULT 'QRIS'");
  if (!cols.includes('waktu_bayar')) db.exec("ALTER TABLE orders ADD COLUMN waktu_bayar TEXT");
  if (!cols.includes('waktu_kirim')) db.exec("ALTER TABLE orders ADD COLUMN waktu_kirim TEXT");
  if (!cols.includes('waktu_selesai')) db.exec("ALTER TABLE orders ADD COLUMN waktu_selesai TEXT");
} catch (e) {
  // Abaikan jika tabel orders belum siap
}

// Pembungkus transaksi sederhana
db.transaction = (fn) => (...args) => {
  db.exec('BEGIN');
  try { const r = fn(...args); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
};
module.exports = db;
