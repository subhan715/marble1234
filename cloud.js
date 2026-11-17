/* Cloud data layer. Replaces the browser-only database of the first GitHub version.
   - Auth: real Supabase login (email + password). Nobody can read or change data
     without logging in; the passwords are never stored in this code.
   - DB:   same function names as the original db.py, but each one calls a function
     inside the Supabase (Postgres) database - see setup.sql. All business rules
     (stock deduction, profit, numbering, all-or-nothing saving) run there.      */
class CloudError extends Error { constructor(msg, code) { super(msg); this.code = code; } }
class AuthExpired extends Error {}

const Auth = (() => {
  const KEY = 'dmg_auth';
  const read = () => { try { return JSON.parse(sessionStorage.getItem(KEY) || 'null'); } catch (e) { return null; } };
  const write = o => { try { sessionStorage.setItem(KEY, JSON.stringify(o)); } catch (e) {} };
  const clear = () => { try { sessionStorage.removeItem(KEY); } catch (e) {} };
  const configured = () => CONFIG.SUPABASE_URL && !/PASTE/i.test(CONFIG.SUPABASE_URL) && CONFIG.SUPABASE_ANON_KEY && !/PASTE/i.test(CONFIG.SUPABASE_ANON_KEY);
  const email = u => { u = String(u).trim().toLowerCase(); return u.includes('@') ? u : `${u}@${CONFIG.EMAIL_DOMAIN}`; };
  const hdr = () => ({ apikey: CONFIG.SUPABASE_ANON_KEY, 'Content-Type': 'application/json' });

  async function tokenCall(grant, body) {
    if (!configured()) throw new CloudError('The online database is not connected yet. Open config.js and paste your Supabase URL and key (see SETUP.md).');
    const r = await fetch(`${CONFIG.SUPABASE_URL}/auth/v1/token?grant_type=${grant}`, { method: 'POST', headers: hdr(), body: JSON.stringify(body) });
    let data = null; try { data = await r.json(); } catch (e) {}
    return { ok: r.ok, status: r.status, data };
  }
  const store = (d, username, role) => write({
    access_token: d.access_token, refresh_token: d.refresh_token,
    expires_at: Date.now() + ((d.expires_in || 3600) - 60) * 1000, username, email: email(username),
    role: role !== undefined ? role : (read() || {}).role,
  });
  /* the role ('boss' or 'staff') is decided by the database; the page only uses it to show or hide buttons.
     Even if someone edits it in the browser, the database still refuses what staff are not allowed to do. */
  async function fetchRole(token) {
    try {
      const r = await fetch(`${CONFIG.SUPABASE_URL}/rest/v1/rpc/my_role`, { method: 'POST', body: '{}',
        headers: { apikey: CONFIG.SUPABASE_ANON_KEY, Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' } });
      const v = r.ok ? await r.json() : null;
      return v === 'boss' ? 'boss' : 'staff';
    } catch (e) { return 'staff'; }
  }

  return {
    configured,
    isLoggedIn: () => !!read(),
    username: () => (read() || {}).username,
    role: () => (read() || {}).role || 'staff',
    isBoss: () => (read() || {}).role === 'boss',
    async ensureRole() {                                // sessions started before roles existed
      const s = read(); if (!s || s.role) return;
      try { const t = await this.token(); const cur = read(); if (cur) { cur.role = await fetchRole(t); write(cur); } } catch (e) {}
    },
    async login(username, password) {
      const r = await tokenCall('password', { email: email(username), password });
      if (!r.ok) { if (r.status >= 500) throw new CloudError('The server is not responding. Try again in a minute.'); return false; }
      store(r.data, String(username).trim().toLowerCase(), await fetchRole(r.data.access_token));
      return true;
    },
    async verifyPassword(password) {                   // used for the Backup password prompt
      const s = read(); if (!s) return false;
      const r = await tokenCall('password', { email: s.email, password });
      return r.ok;
    },
    async token() {
      const s = read(); if (!s) throw new AuthExpired();
      if (Date.now() < s.expires_at) return s.access_token;
      const r = await tokenCall('refresh_token', { refresh_token: s.refresh_token });
      if (!r.ok) { clear(); throw new AuthExpired(); }
      store(r.data, s.username);
      return r.data.access_token;
    },
    async logout() {
      const s = read(); clear();
      try { if (s) await fetch(`${CONFIG.SUPABASE_URL}/auth/v1/logout`, { method: 'POST', headers: { ...hdr(), Authorization: 'Bearer ' + s.access_token } }); } catch (e) {}
    },
  };
})();

const DB = (() => {
  const LOW_STOCK_SQFT = 100;
  const nowStr = () => Py.strftime(new Date(), '%Y-%m-%d %H:%M');

  async function rpc(fn, args = {}, retry = true) {
    const token = await Auth.token();
    let r;
    try {
      r = await fetch(`${CONFIG.SUPABASE_URL}/rest/v1/rpc/${fn}`, {
        method: 'POST', body: JSON.stringify(args),
        headers: { apikey: CONFIG.SUPABASE_ANON_KEY, Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      });
    } catch (e) { throw new CloudError('Cannot reach the online database. Check the internet connection and try again.'); }
    const text = await r.text();
    let data = null; try { data = text ? JSON.parse(text) : null; } catch (e) { data = { message: text }; }
    if (r.status === 401 || (data && data.code === 'PGRST301')) throw new AuthExpired();
    if (!r.ok) throw new CloudError((data && (data.message || data.error)) || ('Database error ' + r.status), data && data.code);
    return data;
  }
  /* turn "bad cart" database errors into ValueError (same as the original), keep real problems as they are */
  const isInvalid = e => e instanceof CloudError && (/^INVALID/.test(e.message) || /^22/.test(e.code || ''));
  const biz = e => (e instanceof CloudError && /^BIZ: /.test(e.message)) ? e.message.slice(5) : null;

  /* ---------- products / inventory ---------- */
  const get_products = (search = '') => rpc('get_products', { p_search: search });
  const get_product = id => rpc('get_product', { p_id: id });
  async function get_or_create_product(d) { const r = await rpc('get_or_create_product', { p: d, p_now: nowStr() }); return [r.id, r.created]; }
  const add_inventory_item = d => rpc('add_inventory_item', { p: d, p_now: nowStr() });
  const update_inventory_item = (id, d) => rpc('update_inventory_item', { p_id: id, p: d });
  /* deletes: return null when done, or the reason it was refused (e.g. staff are not allowed) */
  const del = async (fn, id) => { try { await rpc(fn, { p_id: id }); return null; } catch (e) { const m = biz(e); if (m) return m; throw e; } };
  const delete_inventory_item = id => del('delete_inventory_item', id);
  const delete_invoice = id => del('delete_invoice', id);
  const delete_delivery = id => del('delete_delivery', id);
  const delete_order = id => del('delete_order', id);
  const get_inventory = (search = '') => rpc('get_inventory', { p_search: search });
  const get_inventory_item = id => rpc('get_inventory_item', { p_id: id });
  const get_low_stock = () => rpc('get_low_stock');
  const get_dashboard_stats = () => rpc('get_dashboard_stats', { p_today: Py.strftime(new Date(), '%Y-%m-%d') });
  const get_recent_sales_profit = (limit = 10) => rpc('get_recent_sales_profit', { p_limit: limit });

  /* ---------- orders / POS ---------- */
  async function create_order(customer_name, phone, address, notes, items, drawing_filename = null, drawing_notes = '', transport = 0, services = '', rft_ft = 0, rft_rate = 0, tip = 0, rft_in1 = 0, rft_in2 = 0) {
    try {
      const r = await rpc('create_order', { p_customer: customer_name, p_phone: phone, p_address: address, p_notes: notes,
        p_items: items, p_drawing_filename: drawing_filename, p_drawing_notes: drawing_notes, p_now: nowStr(), p_transport: transport, p_services: services, p_rft_ft: rft_ft, p_rft_rate: rft_rate, p_tip: tip, p_rft_in1: rft_in1, p_rft_in2: rft_in2 });
      return [r.order_id, r.order_no];
    } catch (e) { if (isInvalid(e)) throw new ValueError(e.message); throw e; }
  }
  const get_orders = (search = '') => rpc('get_orders', { p_search: search });
  async function get_order(id) { const r = await rpc('get_order', { p_id: id }); return [r.order, r.items]; }
  async function process_order(id) {
    try { const r = await rpc('process_order', { p_order_id: id, p_now: nowStr() }); return [r.delivery_id, r.delivery_no, null]; }
    catch (e) { const m = biz(e); if (m) return [null, null, m]; throw e; }
  }
  const cancel_order = id => rpc('cancel_order', { p_id: id });
  async function create_pos_sale(customer_name, phone, payment_method, items, transport = 0, services = '', rft_ft = 0, rft_rate = 0, tip = 0, rft_in1 = 0, rft_in2 = 0) {
    try {
      const r = await rpc('create_pos_sale', { p_customer: customer_name, p_phone: phone, p_payment: payment_method, p_items: items, p_now: nowStr(), p_transport: transport, p_services: services, p_rft_ft: rft_ft, p_rft_rate: rft_rate, p_tip: tip, p_rft_in1: rft_in1, p_rft_in2: rft_in2 });
      return [r.invoice_id, null];
    } catch (e) { const m = biz(e); if (m) return [null, m]; if (isInvalid(e)) throw new ValueError(e.message); throw e; }
  }

  /* ---------- invoices / deliveries ---------- */
  const get_product_sales = (search = '') => rpc('get_product_sales', { p_search: search });
  const get_invoices = (search = '') => rpc('get_invoices', { p_search: search });
  async function get_invoice(id) { const r = await rpc('get_invoice', { p_id: id }); return [r.invoice, r.items]; }
  const mark_invoice_paid = (id, method) => rpc('mark_invoice_paid', { p_id: id, p_method: method });
  const get_delivery_for_invoice = id => rpc('get_delivery_for_invoice', { p_invoice_id: id });
  const get_deliveries = (search = '') => rpc('get_deliveries', { p_search: search });
  async function get_delivery(id) { const r = await rpc('get_delivery', { p_id: id }); return [r.delivery, r.items, r.invoice, r.order]; }
  async function update_delivery_status(id, status) { const r = await rpc('update_delivery_status', { p_id: id, p_status: status, p_now: nowStr() }); return r.invoice_id; }

  /* ---------- drawings ---------- */
  const save_drawing = (filename, dataUrl) => rpc('save_drawing', { p_filename: filename, p_data: dataUrl });
  const get_drawing = filename => rpc('get_drawing', { p_filename: filename });

  /* ---------- backup (.db file, same format as the original Windows app) ---------- */
  const TABLES = {
    products: ['id', 'name', 'material_type', 'color', 'unit', 'purchase_price_per_unit', 'selling_price_per_unit', 'supplier', 'notes', 'date_added'],
    inventory: ['id', 'product_id', 'item_name', 'material_type', 'color', 'width', 'length', 'thickness', 'pieces', 'unit', 'area_per_piece', 'total_area', 'purchase_price_per_unit', 'selling_price_per_unit', 'total_cost_value', 'total_value', 'supplier', 'notes', 'date_added'],
    orders: ['id', 'order_no', 'customer_name', 'phone', 'address', 'status', 'order_date', 'notes', 'total_amount', 'drawing_filename', 'drawing_notes', 'transport', 'services', 'rft_ft', 'rft_rate', 'rft_amount', 'tip', 'rft_in1', 'rft_in2'],
    order_items: ['id', 'order_id', 'inventory_id', 'item_name', 'pieces', 'width', 'length', 'unit', 'area', 'price_per_unit', 'amount'],
    invoices: ['id', 'invoice_no', 'source', 'order_id', 'customer_name', 'phone', 'payment_method', 'invoice_date', 'total_amount', 'total_profit', 'transport', 'services', 'rft_ft', 'rft_rate', 'rft_amount', 'tip', 'rft_in1', 'rft_in2'],
    invoice_items: ['id', 'invoice_id', 'inventory_id', 'item_name', 'pieces', 'width', 'length', 'unit', 'area', 'price_per_unit', 'cost_price_per_unit', 'amount', 'profit'],
    deliveries: ['id', 'delivery_no', 'order_id', 'invoice_id', 'customer_name', 'phone', 'address', 'status', 'delivery_date'],
  };
  const SCHEMA = `
    CREATE TABLE products (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE COLLATE NOCASE, material_type TEXT, color TEXT, unit TEXT DEFAULT 'Sq.Ft', purchase_price_per_unit REAL DEFAULT 0, selling_price_per_unit REAL DEFAULT 0, supplier TEXT, notes TEXT, date_added TEXT);
    CREATE TABLE inventory (id INTEGER PRIMARY KEY AUTOINCREMENT, product_id INTEGER, item_name TEXT NOT NULL, material_type TEXT, color TEXT, width REAL, length REAL, thickness REAL, pieces INTEGER, unit TEXT DEFAULT 'Sq.Ft', area_per_piece REAL, total_area REAL, purchase_price_per_unit REAL DEFAULT 0, selling_price_per_unit REAL DEFAULT 0, total_cost_value REAL DEFAULT 0, total_value REAL DEFAULT 0, supplier TEXT, notes TEXT, date_added TEXT, FOREIGN KEY(product_id) REFERENCES products(id));
    CREATE TABLE orders (id INTEGER PRIMARY KEY AUTOINCREMENT, order_no TEXT, customer_name TEXT, phone TEXT, address TEXT, status TEXT DEFAULT 'Pending', order_date TEXT, notes TEXT, total_amount REAL DEFAULT 0, drawing_filename TEXT, drawing_notes TEXT, transport REAL DEFAULT 0, services TEXT DEFAULT '', rft_ft REAL DEFAULT 0, rft_rate REAL DEFAULT 0, rft_amount REAL DEFAULT 0, tip REAL DEFAULT 0, rft_in1 REAL DEFAULT 0, rft_in2 REAL DEFAULT 0);
    CREATE TABLE order_items (id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER, inventory_id INTEGER, item_name TEXT, pieces INTEGER, width REAL, length REAL, unit TEXT, area REAL, price_per_unit REAL, amount REAL, FOREIGN KEY(order_id) REFERENCES orders(id) ON DELETE CASCADE);
    CREATE TABLE invoices (id INTEGER PRIMARY KEY AUTOINCREMENT, invoice_no TEXT, source TEXT, order_id INTEGER, customer_name TEXT, phone TEXT, payment_method TEXT, invoice_date TEXT, total_amount REAL, total_profit REAL DEFAULT 0, transport REAL DEFAULT 0, services TEXT DEFAULT '', rft_ft REAL DEFAULT 0, rft_rate REAL DEFAULT 0, rft_amount REAL DEFAULT 0, tip REAL DEFAULT 0, rft_in1 REAL DEFAULT 0, rft_in2 REAL DEFAULT 0);
    CREATE TABLE invoice_items (id INTEGER PRIMARY KEY AUTOINCREMENT, invoice_id INTEGER, inventory_id INTEGER, item_name TEXT, pieces INTEGER, width REAL, length REAL, unit TEXT, area REAL, price_per_unit REAL, cost_price_per_unit REAL DEFAULT 0, amount REAL, profit REAL DEFAULT 0, FOREIGN KEY(invoice_id) REFERENCES invoices(id) ON DELETE CASCADE);
    CREATE TABLE deliveries (id INTEGER PRIMARY KEY AUTOINCREMENT, delivery_no TEXT, order_id INTEGER, invoice_id INTEGER, customer_name TEXT, phone TEXT, address TEXT, status TEXT DEFAULT 'Ready for Delivery', delivery_date TEXT);
    CREATE TABLE drawings (filename TEXT PRIMARY KEY, data BLOB);`;
  const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', pdf: 'application/pdf' };
  let SQL = null;
  const sqlJs = async () => SQL || (SQL = await initSqlJs({ locateFile: f => f }));
  const dataUrlToBytes = u => { const b = atob(String(u).split(',')[1] || ''); return Uint8Array.from(b, c => c.charCodeAt(0)); };
  const bytesToDataUrl = (bytes, name) => {
    let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return `data:${MIME[String(name).split('.').pop().toLowerCase()] || 'application/octet-stream'};base64,${btoa(s)}`;
  };

  const db_size_kb = () => rpc('db_size_kb');
  async function backup_bytes() {
    const data = await rpc('export_all');
    const sdb = new (await sqlJs()).Database();
    sdb.run(SCHEMA);
    for (const [t, cols] of Object.entries(TABLES)) {
      const st = sdb.prepare(`INSERT INTO ${t} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`);
      for (const row of data[t] || []) st.run(cols.map(c => (row[c] === undefined ? null : row[c])));
      st.free();
    }
    const st = sdb.prepare('INSERT INTO drawings (filename, data) VALUES (?,?)');
    for (const d of data.drawings || []) st.run([d.filename, dataUrlToBytes(d.data)]);
    st.free();
    const bytes = sdb.export(); sdb.close();
    return bytes;
  }
  /* returns false when the file is not a backup of this system */
  async function restore_from_bytes(bytes) {
    const sdb = new (await sqlJs()).Database(bytes);
    let payload = {};
    try {
      const names = new Set((sdb.exec("SELECT name FROM sqlite_master WHERE type='table'")[0] || { values: [] }).values.map(r => r[0]));
      if (!['inventory', 'invoices', 'orders', 'deliveries'].every(t => names.has(t))) return false;
      const all = t => { if (!names.has(t)) return []; const r = sdb.exec(`SELECT * FROM ${t}`)[0]; if (!r) return []; return r.values.map(v => Object.fromEntries(r.columns.map((c, i) => [c, v[i]]))); };
      for (const t of Object.keys(TABLES)) payload[t] = all(t);
      payload.drawings = all('drawings').filter(d => d.data && d.data.length).map(d => ({ filename: d.filename, data: bytesToDataUrl(d.data, d.filename) }));
    } finally { sdb.close(); }
    await rpc('restore_all', { p: payload });
    return true;
  }

  return {
    LOW_STOCK_SQFT, get_products, get_product, get_or_create_product, add_inventory_item, update_inventory_item,
    delete_inventory_item, delete_invoice, delete_delivery, delete_order, get_inventory, get_inventory_item, get_low_stock, get_dashboard_stats, get_recent_sales_profit,
    create_order, get_orders, get_order, process_order, cancel_order, create_pos_sale,
    get_product_sales, get_invoices, get_invoice, mark_invoice_paid, get_delivery_for_invoice, get_deliveries, get_delivery, update_delivery_status,
    save_drawing, get_drawing, db_size_kb, backup_bytes, restore_from_bytes,
  };
})();
