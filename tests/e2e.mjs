const BASE = process.env.BASE ?? 'http://127.0.0.1:3000';
const PLACES_STATS = process.env.PLACES_STATS_URL ?? 'http://127.0.0.1:4010/stats';

let passed = 0;
function ok(condition, label, extra = '') {
  if (!condition) {
    console.error(`FAIL  ${label} ${extra}`);
    process.exitCode = 1;
    throw new Error(`assertion failed: ${label}`);
  }
  passed += 1;
  console.log(`ok    ${label}${extra ? ` — ${extra}` : ''}`);
}

async function request(path, { token, method = 'GET', body, redirect = 'manual' } = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    redirect,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Cookie: token } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: response.status, json, text, headers: response.headers };
}

async function login(email, password) {
  const response = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const json = await response.json();
  ok(response.status === 200, `login ${email}`, `status ${response.status}`);
  const cookie = response.headers.getSetCookie()[0]?.split(';')[0];
  ok(Boolean(cookie?.startsWith('cf_session=')), 'cookie sesi httpOnly diterbitkan');
  return cookie;
}

const superEmail = process.env.E2E_SUPERADMIN_EMAIL;
const superPass = process.env.E2E_SUPERADMIN_PASSWORD;
if (!superEmail || !superPass) {
  console.error('Set E2E_SUPERADMIN_EMAIL dan E2E_SUPERADMIN_PASSWORD (akun seed pada database uji).');
  process.exit(1);
}

// ── Superadmin ────────────────────────────────────────────────────────────
const superToken = await login(superEmail, superPass);
let res = await request('/api/auth/me', { token: superToken });
ok(res.status === 200 && res.json.data.user.role === 'SUPERADMIN', 'me mengembalikan role SUPERADMIN');

const adminEmail = `admin@test.local`;
const userEmail = `user@test.local`;
res = await request('/api/admin/users', {
  token: superToken,
  method: 'POST',
  body: { name: 'Admin Uji', email: adminEmail, password: 'AdminPass123!', role: 'ADMIN' },
});
ok(res.status === 201, 'superadmin membuat user ADMIN', `status ${res.status}`);
res = await request('/api/admin/users', {
  token: superToken,
  method: 'POST',
  body: { name: 'User Uji', email: userEmail, password: 'UserPass123!', role: 'USER' },
});
ok(res.status === 201, 'superadmin membuat user USER', `status ${res.status}`);
const createdUserId = res.json.data.user.id;

res = await request(`/api/admin/users/${createdUserId}`, {
  token: superToken,
  method: 'PATCH',
  body: { role: 'USER' },
});
ok(res.status === 200 && res.json.data.user.role === 'USER', 'superadmin mengubah role user');

res = await request('/api/admin/users', { token: superToken });
ok(res.status === 200 && res.json.data.users.length === 3, 'daftar user berisi 3 akun');

// ── Admin ─────────────────────────────────────────────────────────────────
const adminToken = await login(adminEmail, 'AdminPass123!');
res = await request('/api/admin/usage', { token: adminToken });
ok(res.status === 200, 'admin boleh mengakses metrik API');
res = await request('/api/admin/users', { token: adminToken });
ok(res.status === 403, 'admin dilarang mengelola user (403)');

res = await request('/api/categories', { token: adminToken });
const adminGlobalCount = res.json.data.categories.length;
ok(res.status === 200 && adminGlobalCount >= 10, 'admin melihat kategori global', `${adminGlobalCount} kategori`);

// ── User & RBAC ───────────────────────────────────────────────────────────
const userToken = await login(userEmail, 'UserPass123!');
res = await request('/api/admin/usage', { token: userToken });
ok(res.status === 403, 'user dilarang mengakses metrik API (403)');
res = await request('/api/leads', {
  token: userToken,
  method: 'POST',
  body: { name: 'Manual User', city: 'Bandung' },
});
ok(res.status === 403, 'user dilarang menambah lead manual (403)');
res = await request('/console/users', { token: userToken });
ok([307, 308].includes(res.status) && res.headers.get('location')?.includes('denied=1'), 'user diarahkan keluar dari /console/users');
res = await request('/console/api-usage', { token: userToken });
ok([307, 308].includes(res.status), 'user diarahkan keluar dari /console/api-usage');

res = await request('/api/categories', { token: userToken });
ok(res.status === 200 && res.json.data.categories.length === 0, 'user tidak melihat kategori global', `${res.json.data.categories.length}`);

res = await request('/api/categories', {
  token: userToken,
  method: 'POST',
  body: {
    sector: 'Uji Sektor',
    subCategory: 'Uji Kategori User',
    keyword: 'coffee shop',
    pitch: 'Website profil dan katalog digital untuk bisnis ini.',
  },
});
ok(res.status === 201, 'user membuat kategori sendiri', `status ${res.status}`);
const userCategoryId = res.json.data.category.id;
ok(res.json.data.category.ownerId === createdUserId, 'kategori ter-scope ke user pembuat');

res = await request('/api/categories', { token: superToken, method: 'POST', body: {
  sector: 'Uji Sektor',
  subCategory: 'Kategori Tugas',
  keyword: 'toko kue',
  pitch: 'Halaman katalog kue dan form pesanan custom.',
  ownerId: createdUserId,
} });
ok(res.status === 201, 'superadmin menugaskan kategori ke user');

res = await request('/api/categories', { token: userToken });
ok(res.json.data.categories.length === 2, 'user melihat 2 kategori miliknya', `${res.json.data.categories.length}`);

res = await request('/api/categories', { token: adminToken });
ok(!res.json.data.categories.some((c) => c.ownerId === createdUserId), 'admin tidak melihat kategori user lain');

res = await request(`/api/categories/${userCategoryId}`, {
  token: adminToken,
  method: 'PUT',
  body: { sector: 'Hack', subCategory: 'Hack', keyword: 'hack', pitch: 'Mencoba mengubah kategori user lain.' },
});
ok(res.status === 403, 'admin dilarang mengubah kategori user lain (403)');

// ── Pencarian + filter + tracker ──────────────────────────────────────────
const placesStats = await fetch(PLACES_STATS).then((r) => r.json());

res = await request('/api/search', {
  token: userToken,
  method: 'POST',
  body: { mode: 'category', categoryId: userCategoryId, city: 'Jakarta Selatan', websiteFilter: 'no_website' },
});
ok(res.status === 200, 'pencarian user berhasil', `status ${res.status}`);
const data = res.json.data;
ok(data.meta.websiteFilter === 'no_website', 'filter website dari request diteruskan ke meta', `${data.meta.websiteFilter}`);
ok(data.meta.pagesScanned === 6 && data.meta.scanned === 120, 'pagination 6 halaman × 20', `${data.meta.pagesScanned}/${data.meta.scanned}`);
ok(data.leads.length === 79, 'filter website + detail dedupe menyisakan 79 prospek', `${data.leads.length}`);
ok(data.meta.skippedWithWebsite === 41, 'website dibuang total 41', `${data.meta.skippedWithWebsite}`);
ok(data.meta.detailsCalls === 12, 'Place Details hanya untuk 12 lead tanpa nomor', `${data.meta.detailsCalls}`);
ok(data.leads.every((lead) => lead.website === null), 'tidak ada lead dengan website');
ok(data.leads.every((lead) => lead.whatsapp === null || /^62\d{8,13}$/.test(lead.whatsapp)), 'semua nomor ternormalisasi 62xxx');
ok(data.leads.every((lead) => lead.status === 'New'), 'lead baru berstatus New');

const placesAfter = await fetch(PLACES_STATS).then((r) => r.json());
ok(placesAfter.requests - placesStats.requests === 18, 'Google menerima 18 request (6 search + 12 details)', `${placesAfter.requests - placesStats.requests}`);

res = await request('/api/auth/me', { token: userToken });
ok(res.json.data.usage.userHits === 18, 'counter user = 18 hit', `${res.json.data.usage.userHits}`);
ok(res.json.data.usage.globalHits === 18, 'counter global = 18 hit');

res = await request('/api/leads', { token: userToken });
ok(res.status === 200 && res.json.data.leads.length === 79, 'user melihat lead miliknya', `${res.json.data.leads.length}`);
const firstLead = res.json.data.leads[0];

res = await request(`/api/leads/${firstLead.id}`, {
  token: userToken,
  method: 'PATCH',
  body: { status: 'Contacted' },
});
ok(res.status === 200 && res.json.data.lead.status === 'Contacted', 'user memperbarui status lead miliknya');
res = await request(`/api/leads/${firstLead.id}`, {
  token: userToken,
  method: 'PATCH',
  body: { status: 'Interested', name: 'Diubah User' },
});
ok(res.status === 403, 'user tidak bisa mengubah profil lead (403)');
res = await request(`/api/leads/${firstLead.id}`, { token: userToken, method: 'DELETE' });
ok(res.status === 403, 'user tidak bisa menghapus lead (403)');

res = await request('/api/export', { token: userToken, method: 'POST', body: { ids: [firstLead.id], city: 'Jakarta Selatan' } });
const xlsxPayload = res.json?.data ?? {};
ok(res.status === 200 && typeof xlsxPayload.fileBase64 === 'string' && xlsxPayload.fileBase64.startsWith('UEsDB'), 'export XLSX server-side (base64 zip)');
ok(xlsxPayload.mime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'mime XLSX benar', `${xlsxPayload.mime}`);
ok(/\.xlsx$/.test(xlsxPayload.fileName ?? ''), 'nama file .xlsx', `${xlsxPayload.fileName}`);

// ── Claim / release ─────────────────────────────────────────────────────
res = await request(`/api/leads/${firstLead.id}/claim`, { token: userToken, method: 'POST' });
ok(res.status === 200 && res.json.data.lead.assignedToId, 'user meng-claim lead', `status ${res.status}`);
res = await request(`/api/leads/${firstLead.id}`, { token: userToken, method: 'PATCH', body: { status: 'Interested' } });
ok(res.status === 200 && res.json.data.lead.status === 'Interested', 'pemegang claim tetap bisa ubah status');
res = await request(`/api/leads/${firstLead.id}/release`, { token: userToken, method: 'POST' });
ok(res.status === 200 && res.json.data.lead.assignedToId === null, 'user melepas claim', `status ${res.status}`);

// ── Metrik admin ──────────────────────────────────────────────────────────
res = await request('/api/admin/usage', { token: adminToken });
const overview = res.json.data.overview;
ok(overview.globalHits === 18, 'metrik global 18 hit', `${overview.globalHits}`);
ok(overview.perUser.find((row) => row.email === userEmail)?.hits === 18, 'metrik per user benar');
ok(overview.logs.length === 18, 'audit log 18 entri', `${overview.logs.length}`);
ok(overview.logs.filter((log) => log.endpoint === 'TEXT_SEARCH').length === 6, 'log Text Search 6');
ok(overview.logs.filter((log) => log.endpoint === 'PLACE_DETAILS').length === 12, 'log Place Details 12');

// ── Proteksi akun ─────────────────────────────────────────────────────────
res = await request(`/api/admin/users/${(await request('/api/auth/me', { token: superToken })).json.data.user.id}`, {
  token: superToken,
  method: 'DELETE',
});
ok(res.status === 400, 'superadmin tidak bisa menghapus akun sendiri');

// ── Logout & redirect ─────────────────────────────────────────────────────
res = await request('/api/auth/logout', { token: userToken, method: 'POST' });
ok(res.status === 200, 'logout sukses');
res = await request('/api/auth/me', { token: userToken });
ok(res.status === 401, 'sesi lama tidak valid setelah logout');
res = await request('/console');
ok([307, 308].includes(res.status) && res.headers.get('location')?.includes('/console/login'), 'halaman console diproteksi');

// Landing page publik & URL lama
res = await request('/');
ok(res.status === 200 && res.text.includes('Temukan Ribuan Calon Klien'), 'landing page publik dapat diakses tanpa login');
res = await request('/dashboard');
ok([307, 308].includes(res.status) && res.headers.get('location')?.includes('/console'), '/dashboard dialihkan permanen ke /console');
res = await request('/login');
ok([307, 308].includes(res.status) && res.headers.get('location')?.includes('/console/login'), '/login dialihkan permanen ke /console/login');

// Mode demo: tanpa login, cookie demo ditanam, API tetap tertutup
res = await request('/console?mode=demo', { redirect: 'manual' });
ok(res.status === 200 && res.text.includes('Demo Interaktif ClientFinder'), 'console demo read-only terbuka tanpa login');
const demoCookie = res.headers.getSetCookie().find((cookie) => cookie.startsWith('cf_demo=1'));
ok(Boolean(demoCookie), 'cookie demo ditanam pada navigasi dokumen');
res = await request('/api/search', { method: 'POST', body: { mode: 'category', categoryId: 'padel-futsal-badminton', city: 'Kota Bandung' }, token: demoCookie?.split(';')[0] });
ok(res.status === 401, 'API asli tetap menolak request tanpa sesi walau mode demo aktif');

console.log(`\n${passed} assertion lulus`);

// ── Pembayaran DOKU (opsional: butuh E2E_DOKU_CLIENT_ID + E2E_DOKU_SECRET yang sama dengan server) ─────────────
// Server diarahkan ke DOKU tiruan (DOKU_IS_PRODUCTION=false, DOKU_CHECKOUT_URL_SANDBOX=http://127.0.0.1:4010/checkout/v1/payment).
// Safety: runs only against a LOCAL server with an explicit opt-in, so it can never create a real DOKU payment session.
const localBase = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(BASE);
if (process.env.E2E_DOKU_CLIENT_ID && process.env.E2E_DOKU_SECRET && process.env.E2E_DOKU_FAKE === '1' && localBase) {
  const { createHash, createHmac, randomUUID } = await import('node:crypto');
  const clientId = process.env.E2E_DOKU_CLIENT_ID; const secret = process.env.E2E_DOKU_SECRET;
  const notify = async (payload, { sign = true, client = clientId } = {}) => {
    const raw = JSON.stringify(payload); const requestId = randomUUID(); const ts = `${new Date().toISOString().slice(0, 19)}Z`;
    const digest = createHash('sha256').update(raw, 'utf8').digest('base64');
    const component = [`Client-Id:${client}`, `Request-Id:${requestId}`, `Request-Timestamp:${ts}`, 'Request-Target:/api/doku/notification', `Digest:${digest}`].join('\n');
    const signature = sign ? `HMACSHA256=${createHmac('sha256', secret).update(component, 'utf8').digest('base64')}` : 'HMACSHA256=invalid';
    const r = await fetch(`${BASE}/api/doku/notification`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Client-Id': client, 'Request-Id': requestId, 'Request-Timestamp': ts, Signature: signature }, body: raw });
    return r.status;
  };
  const orderStatus = async (inv) => (await request(`/api/orders/${inv}`)).json?.data?.order;

  res = await request('/api/checkout', { method: 'POST', body: { planId: 'STARTER', name: 'Pembeli Uji', email: 'pembeli@test.local', phone: '081234567890' } });
  ok(res.status === 200 && res.json?.data?.invoiceNumber && res.json.data.paymentUrl === 'http://127.0.0.1:4010/pay/fake', 'checkout membuat order + URL pembayaran DOKU tiruan', `status ${res.status} url ${res.json?.data?.paymentUrl}`);
  const inv = res.json.data.invoiceNumber; const amount = res.json.data.plan.amount;
  ok((await orderStatus(inv))?.status === 'PENDING', 'order baru berstatus PENDING');

  ok((await notify({ order: { invoice_number: inv, amount }, transaction: { status: 'SUCCESS' } }, { sign: false })) === 401, 'notifikasi dengan signature salah ditolak 401');
  ok((await notify({ order: { invoice_number: inv, amount }, transaction: { status: 'SUCCESS' } }, { client: 'BRN-OTHER' })) === 401, 'notifikasi dari Client-Id lain ditolak 401');
  // Ignored notifications must be acknowledged with 200 (no DOKU retry storm) AND leave the order unchanged.
  const ignored = async (payload, label) => { const st = await notify(payload); ok(st === 200 && (await orderStatus(inv))?.status === 'PENDING', label, `status ${st}`); };
  await ignored({ order: { invoice_number: inv, amount }, transaction: { status: 'FAILED' } }, 'status FAILED diabaikan (200, order tetap PENDING)');
  await ignored({ order: { invoice_number: inv }, transaction: { status: 'SUCCESS' } }, 'SUCCESS tanpa nominal TIDAK melunasi order (200)');
  await ignored({ order: { invoice_number: inv, amount: 0 }, transaction: { status: 'SUCCESS' } }, 'SUCCESS dengan nominal 0 TIDAK melunasi order (200)');
  await ignored({ order: { invoice_number: inv, amount: amount - 1 }, transaction: { status: 'SUCCESS' } }, 'SUCCESS dengan nominal berbeda TIDAK melunasi order (200)');
  await ignored(null, 'body null bersignature valid diabaikan (200, bukan 500)');
  await ignored({ order: { invoice_number: 12345, amount }, transaction: { status: 'SUCCESS' } }, 'invoice_number bukan string diabaikan (200)');
  await ignored({ order: { invoice_number: inv, amount }, transaction: { status: 7 } }, 'status bukan string diabaikan (200)');
  ok((await notify({ order: { invoice_number: inv, amount: `${amount}.00` }, transaction: { status: 'SUCCESS' } })) === 200, 'notifikasi SUCCESS bernominal benar (string ".00") diterima');
  const paid = await orderStatus(inv);
  ok(paid?.status === 'PAID' && paid.paidAt, 'order PAID dengan paidAt');
  await notify({ order: { invoice_number: inv, amount }, transaction: { status: 'SUCCESS' } });
  await notify({ order: { invoice_number: inv, amount }, transaction: { status: 'FAILED' } });
  const again = await orderStatus(inv);
  ok(again?.status === 'PAID' && again.paidAt === paid.paidAt, 'notifikasi berulang idempotent: tetap PAID, paidAt tidak berubah');
  console.log(`\n${passed} assertion lulus (termasuk pembayaran DOKU)`);
}
