process.env.DB_FILE = ':memory:';
const { test, before } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const app = require('../src/app');
require('../src/seed')();
let mhs, seller;
before(async () => {
  mhs = (await request(app).post('/api/auth/login').send({ email: 'mhs@delfood.local', password: 'mahasiswa123' })).body.token;
  seller = (await request(app).post('/api/auth/login').send({ email: 'sari@delfood.local', password: 'penjual123' })).body.token;
});
test('health', async () => { assert.equal((await request(app).get('/api/health')).body.status, 'ok'); });
test('registrasi dan login', async () => {
  const r = await request(app).post('/api/auth/register').send({ nama: 'A', email: 'a@x.id', password: 'secret1' });
  assert.equal(r.status, 201);
  assert.equal((await request(app).post('/api/auth/register').send({ nama: 'A', email: 'a@x.id', password: 'secret1' })).status, 409);
  assert.equal((await request(app).post('/api/auth/login').send({ email: 'a@x.id', password: 'salah' })).status, 401);
});
test('katalog menu dengan filter', async () => {
  const r = await request(app).get('/api/menu?kategori=Minuman');
  assert.ok(r.body.length > 0 && r.body.every((m) => m.kategori === 'Minuman'));
});
test('menu hanya bisa dikelola penjual', async () => {
  const body = { nama: 'Bakso', harga: 12000, kategori: 'Makanan', stok: 10 };
  assert.equal((await request(app).post('/api/menu').set('Authorization', 'Bearer ' + mhs).send(body)).status, 403);
  assert.equal((await request(app).post('/api/menu').set('Authorization', 'Bearer ' + seller).send(body)).status, 201);
});
test('alur pesanan: buat, kurangi stok, ubah status', async () => {
  const before = (await request(app).get('/api/menu?q=Nasi Ayam')).body[0];
  const o = await request(app).post('/api/orders').set('Authorization', 'Bearer ' + mhs).send({ jam_ambil: '12:30', items: [{ menu_id: before.id, jumlah: 2 }] });
  assert.equal(o.status, 201); assert.equal(o.body.total, 30000); assert.equal(o.body.nomor_antrean, 1);
  const after = (await request(app).get('/api/menu?q=Nasi Ayam')).body[0];
  assert.equal(after.stok, before.stok - 2);
  const s = await request(app).patch(`/api/orders/${o.body.id}/status`).set('Authorization', 'Bearer ' + seller).send({ status: 'Siap' });
  assert.equal(s.body.status, 'Siap');
  assert.equal((await request(app).get('/api/orders').set('Authorization', 'Bearer ' + mhs)).body.length, 1);
});
test('pesanan ditolak jika stok kurang atau beda kios', async () => {
  const menu = (await request(app).get('/api/menu')).body;
  const a = menu.find((m) => m.kios_id === 1), b = menu.find((m) => m.kios_id === 2);
  assert.equal((await request(app).post('/api/orders').set('Authorization', 'Bearer ' + mhs).send({ jam_ambil: '12:00', items: [{ menu_id: a.id, jumlah: 9999 }] })).status, 400);
  assert.equal((await request(app).post('/api/orders').set('Authorization', 'Bearer ' + mhs).send({ jam_ambil: '12:00', items: [{ menu_id: a.id, jumlah: 1 }, { menu_id: b.id, jumlah: 1 }] })).status, 400);
});
test('alur lengkap: bayar -> notif penjual -> konfirmasi kirim -> notif pembeli -> konfirmasi terima -> selesai', async () => {
  const menu = (await request(app).get('/api/menu?q=Soto Ayam')).body[0];
  // 1. Buat pesanan dengan status Belum Dibayar
  const orderRes = await request(app).post('/api/orders')
    .set('Authorization', 'Bearer ' + mhs)
    .send({ jam_ambil: '13:00', status_pembayaran: 'Belum Dibayar', items: [{ menu_id: menu.id, jumlah: 1 }] });
  assert.equal(orderRes.status, 201);
  assert.equal(orderRes.body.status_pembayaran, 'Belum Dibayar');

  // 2. Mahasiswa melakukan pembayaran
  const payRes = await request(app).post(`/api/orders/${orderRes.body.id}/bayar`)
    .set('Authorization', 'Bearer ' + mhs)
    .send({ metode_pembayaran: 'QRIS' });
  assert.equal(payRes.status, 200);
  assert.equal(payRes.body.status_pembayaran, 'Sudah Dibayar');
  assert.ok(payRes.body.waktu_bayar);

  // 3. Penjual mendapatkan notifikasi pembayaran
  const sellerNotifs = await request(app).get('/api/notifications').set('Authorization', 'Bearer ' + seller);
  assert.ok(sellerNotifs.body.some((n) => n.tipe === 'pembayaran' && n.order_id === orderRes.body.id));

  // 4. Penjual mengirimkan konfirmasi sudah mengirim pesanan
  const kirimRes = await request(app).post(`/api/orders/${orderRes.body.id}/kirim`)
    .set('Authorization', 'Bearer ' + seller);
  assert.equal(kirimRes.status, 200);
  assert.equal(kirimRes.body.status, 'Dikirim');
  assert.ok(kirimRes.body.waktu_kirim);

  // 5. Pembeli mendapatkan notifikasi bahwa pesanan sedang dikirim
  const mhsNotifs = await request(app).get('/api/notifications').set('Authorization', 'Bearer ' + mhs);
  assert.ok(mhsNotifs.body.some((n) => n.tipe === 'pengiriman' && n.order_id === orderRes.body.id));

  // 6. Pembeli memberikan konfirmasi sudah menerima pesanan
  const terimaRes = await request(app).post(`/api/orders/${orderRes.body.id}/konfirmasi-terima`)
    .set('Authorization', 'Bearer ' + mhs);
  assert.equal(terimaRes.status, 200);
  assert.equal(terimaRes.body.status, 'Selesai');
  assert.ok(terimaRes.body.waktu_selesai);

  // 7. Penjual mendapatkan notifikasi bahwa pembeli telah menerima pesanan
  const sellerNotifsAfter = await request(app).get('/api/notifications').set('Authorization', 'Bearer ' + seller);
  assert.ok(sellerNotifsAfter.body.some((n) => n.tipe === 'penerimaan' && n.order_id === orderRes.body.id));

  // 8. Tandai notifikasi telah dibaca
  const notifId = sellerNotifsAfter.body[0].id;
  const bacaRes = await request(app).patch(`/api/notifications/${notifId}/baca`).set('Authorization', 'Bearer ' + seller);
  assert.equal(bacaRes.status, 200);
});
