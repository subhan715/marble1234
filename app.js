/* Port of app.py (the Flask routes). Same URLs, same form fields, same flash
   messages and same logic - but everything runs in the browser.
   Pages are addressed with "#/path" (e.g. index.html#/inventory) so it works on
   GitHub Pages without any server. Each page is the original template rendered
   into the <iframe>, exactly like a normal page load would have been. */
(() => {
  const frame = document.getElementById('page');
  const ALLOWED_DRAWING_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'pdf', 'webp']);
  const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', pdf: 'application/pdf' };

  /* ---------- session (real login via Supabase, see cloud.js) & flash ---------- */
  const session = {
    get: k => (k === 'username' ? Auth.username() : k === 'logged_in' ? Auth.isLoggedIn() : k === 'role' ? Auth.role() : undefined),
  };
  let flashes = [];
  const flash = (msg, category = 'message') => flashes.push([category, msg]);
  const get_flashed_messages = () => { const m = flashes; flashes = []; return m; };

  /* ---------- url_for ---------- */
  const ROUTES = {
    dashboard: () => '/', login: () => '/login', logout: () => '/logout',
    inventory_list: () => '/inventory', inventory_add: () => '/inventory/add',
    inventory_edit: a => `/inventory/edit/${a.item_id}`, inventory_delete: a => `/inventory/delete/${a.item_id}`,
    api_inventory: () => '/api/inventory',
    pos: () => '/pos', pos_checkout: () => '/pos/checkout',
    orders_list: () => '/orders', orders_new: () => '/orders/new',
    order_detail: a => `/orders/${a.order_id}`, order_process: a => `/orders/${a.order_id}/process`,
    order_cancel: a => `/orders/${a.order_id}/cancel`,
    product_report: () => '/reports/product',
    invoice_delete: a => `/invoices/${a.invoice_id}/delete`, delivery_delete: a => `/deliveries/${a.delivery_id}/delete`,
    order_delete: a => `/orders/${a.order_id}/delete`,
    invoices_list: () => '/invoices', invoice_view: a => `/invoices/${a.invoice_id}`,
    invoice_mark_paid: a => `/invoices/${a.invoice_id}/mark-paid`,
    deliveries_list: () => '/deliveries', delivery_view: a => `/deliveries/${a.delivery_id}`,
    delivery_status: a => `/deliveries/${a.delivery_id}/status`,
    backup_page: () => '/backup', backup_download: () => '/backup/download', backup_restore: () => '/backup/restore',
  };
  const blobUrls = new Map();
  function drawingUrl(filename) { return blobUrls.get(filename) || '#'; }
  async function prefetchDrawing(filename) {            // download the picture/PDF once, show it from memory
    if (!filename || blobUrls.has(filename)) return;
    const dataUrl = await DB.get_drawing(filename);
    if (!dataUrl) return;
    const bytes = Uint8Array.from(atob(dataUrl.split(',')[1] || ''), c => c.charCodeAt(0));
    const mime = (dataUrl.match(/^data:([^;]+);/) || [])[1] || 'application/octet-stream';
    blobUrls.set(filename, URL.createObjectURL(new Blob([bytes], { type: mime })));
  }
  const fileToDataUrl = file => new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = rej; fr.readAsDataURL(file); });
  function url_for(endpoint, ...rest) {
    const last = rest[rest.length - 1];
    const kwargs = {};
    if (last && typeof last === 'object') for (const [k, v] of Object.entries(last)) if (k !== '__keywords') kwargs[k] = v;
    if (endpoint === 'static') {
      const fn = kwargs.filename;
      return fn.startsWith('uploads/drawings/') ? drawingUrl(fn.slice('uploads/drawings/'.length)) : (fn === 'style.css' ? 'style.css?v=13' : fn);
    }
    const build = ROUTES[endpoint];
    if (!build) throw new Error('Unknown endpoint ' + endpoint);
    const path = build(kwargs);
    const used = new Set(build.toString().match(/a\.(\w+)/g)?.map(s => s.slice(2)) || []);
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(kwargs)) if (!used.has(k) && v !== undefined && v !== null) q.set(k, v);
    const qs = q.toString();
    return '#' + path + (qs ? '?' + qs : '');
  }

  /* ---------- responses ---------- */
  const redirect = (path) => ({ redirect: path });
  const render_template = (name, ctx = {}) => ({ html: Templates.render(name, ctx) });
  const rows = list => list.map(r => ({ ...r }));                 // dict(row)
  const trim = s => String(s).trim();

  /* ---------- route handlers ---------- */
  const routes = [];
  const route = (method, pattern, fn) => routes.push([method, new RegExp('^' + pattern + '$'), fn]);

  // ----- auth -----
  route('GET', '/login', async r => render_template('login.html', { next: r.args.get('next') || '' }));
  route('POST', '/login', async r => {
    const username = r.form.get('username', ''), password = r.form.get('password', '');
    const nextQ = r.form.get('next', '') ? '?next=' + encodeURIComponent(r.form.get('next', '')) : '';
    let ok = false;
    try { ok = await Auth.login(username, password); }
    catch (e) { flash(e.message || 'Could not log in.', 'error'); return redirect('/login' + nextQ); }
    if (ok) {
      const next = r.form.get('next');
      return redirect(next && next.startsWith('/') ? next : '/');
    }
    flash('Incorrect username or password.', 'error');
    return redirect('/login' + nextQ);
  });
  route('GET', '/logout', async () => {
    await Auth.logout();
    flash('You have been logged out.', 'success');
    return redirect('/login');
  });

  // ----- dashboard -----
  route('GET', '/', async () => {
    return render_template('dashboard.html', {
      stats: await DB.get_dashboard_stats(), low_stock: await DB.get_low_stock(), recent_profit: await DB.get_recent_sales_profit(10),
    });
  });

  // ----- inventory -----
  route('GET', '/inventory', async r => {
    const search = r.args.get('q') || '';
    const items = await DB.get_inventory(search), products = await DB.get_products(search);
    const low_names = (await DB.get_low_stock()).map(x => x.item_name.toLowerCase());
    return render_template('inventory_list.html', { items, products, search, low_names, low_sqft: DB.LOW_STOCK_SQFT });
  });

  function _calc_area(width, length, pieces, unit, purchase_price, selling_price) {
    const area_piece = unit === 'Sq.Ft' ? (width * length) / 144.0 : (width * 0.0254) * (length * 0.0254);
    const total_area = area_piece * pieces;
    return [area_piece, total_area, total_area * purchase_price, total_area * selling_price];
  }

  route('GET', '/inventory/add', async r => {
    const products = rows(await DB.get_products());
    let pre = null;
    const pid = r.args.get('product_id');
    if (pid !== null && /^\s*[+-]?\d+\s*$/.test(pid)) pre = parseInt(pid, 10);
    return render_template('inventory_form.html', { item: null, products, preselect_product_id: pre });
  });
  route('POST', '/inventory/add', async r => {
    const f = r.form;
    let width, length, thickness, pieces, purchase_price, selling_price;
    try {
      width = Py.float(f.get('width')); length = Py.float(f.get('length'));
      thickness = Py.float(f.get('thickness') || 0); pieces = Py.int(f.get('pieces'));
      purchase_price = Py.float(f.get('purchase_price_per_unit') || 0);
      selling_price = Py.float(f.get('selling_price_per_unit') || 0);
    } catch (e) {
      if (!(e instanceof ValueError)) throw e;
      flash('Please enter valid numbers for width, length, thickness, pieces and prices.', 'error');
      return redirect('/inventory/add');
    }
    if (width <= 0 || length <= 0 || pieces <= 0) {
      flash('Width, Length and Pieces must be greater than zero.', 'error');
      return redirect('/inventory/add');
    }
    const unit = f.get('unit', 'Sq.Ft');
    const supplier = trim(f.get('supplier', ''));
    const product_choice = f.get('product_id', '');
    let product_id, item_name, material_type, color;
    if (product_choice && product_choice !== '__new__') {
      let product;
      try { product = await DB.get_product(Py.int(product_choice)); } catch (e) { if (!(e instanceof ValueError)) throw e; product = null; }
      if (!product) {
        flash('Selected product was not found. Please choose again.', 'error');
        return redirect('/inventory/add');
      }
      product_id = product.id; item_name = product.name; material_type = product.material_type; color = product.color;
    } else {
      const new_name = trim(f.get('new_product_name', ''));
      if (!new_name) {
        flash('Enter a Product Name for the new product, or choose an existing one.', 'error');
        return redirect('/inventory/add');
      }
      material_type = f.get('material_type', 'Marble');
      color = trim(f.get('color', ''));
      let created;
      [product_id, created] = await DB.get_or_create_product({
        name: new_name, material_type, color, unit,
        purchase_price_per_unit: purchase_price, selling_price_per_unit: selling_price, supplier, notes: '',
      });
      item_name = new_name;
      if (!created) {
        const existing = await DB.get_product(product_id);
        material_type = existing.material_type; color = existing.color; item_name = existing.name;
      }
    }
    const [area_piece, total_area, total_cost_value, total_value] =
      _calc_area(width, length, pieces, unit, purchase_price, selling_price);
    await DB.add_inventory_item({
      product_id, item_name, material_type, color, width, length, thickness, pieces, unit,
      area_per_piece: area_piece, total_area, purchase_price_per_unit: purchase_price,
      selling_price_per_unit: selling_price, total_cost_value, total_value, supplier,
      notes: trim(f.get('notes', '')),
    });
    flash(`Stock added to "${item_name}" (${Py.g(width)} x ${Py.g(length)}, ${pieces} pcs).`, 'success');
    return redirect('/inventory/add');
  });

  route('GET', '/inventory/edit/(\\d+)', async (r, id) => {
    const item = await DB.get_inventory_item(+id);
    if (!item) { flash('Item not found.', 'error'); return redirect('/inventory'); }
    return render_template('inventory_form.html', { item });
  });
  route('POST', '/inventory/edit/(\\d+)', async (r, id) => {
    const item_id = +id, f = r.form;
    const item = await DB.get_inventory_item(item_id);
    if (!item) { flash('Item not found.', 'error'); return redirect('/inventory'); }
    let width, length, thickness, pieces, purchase_price, selling_price;
    try {
      width = Py.float(f.get('width')); length = Py.float(f.get('length'));
      thickness = Py.float(f.get('thickness') || 0); pieces = Py.int(f.get('pieces'));
      purchase_price = Py.float(f.get('purchase_price_per_unit') || 0);
      selling_price = Py.float(f.get('selling_price_per_unit') || 0);
    } catch (e) {
      if (!(e instanceof ValueError)) throw e;
      flash('Please enter valid numbers.', 'error');
      return redirect(`/inventory/edit/${item_id}`);
    }
    if (width <= 0 || length <= 0 || pieces <= 0) {
      flash('Width, Length and Pieces must be greater than zero.', 'error');
      return redirect(`/inventory/edit/${item_id}`);
    }
    const unit = f.get('unit', 'Sq.Ft');
    let [area_piece, total_area, total_cost_value, total_value] = _calc_area(width, length, pieces, unit, purchase_price, selling_price);
    // Size/qty/unit unchanged -> keep the remaining stock, only re-price it.
    if (width === item.width && length === item.length && pieces === item.pieces && unit === item.unit) {
      total_area = item.total_area;
      total_cost_value = total_area * purchase_price;
      total_value = total_area * selling_price;
    }
    await DB.update_inventory_item(item_id, {
      item_name: trim(f.get('item_name')), material_type: f.get('material_type', 'Marble'),
      color: trim(f.get('color', '')), width, length, thickness, pieces, unit,
      area_per_piece: area_piece, total_area, purchase_price_per_unit: purchase_price,
      selling_price_per_unit: selling_price, total_cost_value, total_value,
      supplier: trim(f.get('supplier', '')), notes: trim(f.get('notes', '')),
    });
    flash('Item updated.', 'success');
    return redirect('/inventory');
  });
  // ----- deleting (boss only; the database refuses anyone else even if a button is forced) -----
  const BOSS_ONLY = 'Only the boss can delete records.';
  const bossDelete = async (fn, id, okMsg, back) => {
    if (!Auth.isBoss()) { flash(BOSS_ONLY, 'error'); return redirect(back); }
    const err = await fn(+id);
    if (err) { flash(err, 'error'); return redirect(back); }
    flash(okMsg, 'success'); return redirect(back);
  };
  route('POST', '/inventory/delete/(\\d+)', (r, id) => bossDelete(DB.delete_inventory_item, id, 'Item deleted.', '/inventory'));
  route('POST', '/invoices/(\\d+)/delete', (r, id) => bossDelete(DB.delete_invoice, id, 'Invoice deleted.', '/invoices'));
  route('POST', '/deliveries/(\\d+)/delete', (r, id) => bossDelete(DB.delete_delivery, id, 'Delivery deleted.', '/deliveries'));
  route('POST', '/orders/(\\d+)/delete', (r, id) => bossDelete(DB.delete_order, id, 'Order deleted.', '/orders'));
  route('GET', '/api/inventory', async r => ({ html: '<pre>' + JSON.stringify(rows(await DB.get_inventory(r.args.get('q') || '')), null, 2).replace(/</g, '&lt;') + '</pre>' }));

  // transport box: empty / invalid / negative means 0
  const parseTransport = v => { const n = parseFloat(String(v).replace(/,/g, '')); return Number.isFinite(n) && n > 0 ? n : 0; };

  // Customer RFT tick boxes -> 'Laap, Gola' (the database keeps only the 4 allowed names)
  const parseServices = r => r.form.getlist('services').join(',');

  // ----- POS -----
  route('GET', '/pos', async () => render_template('pos.html', { items: await DB.get_inventory(), products: rows(await DB.get_products()) }));
  route('POST', '/pos/checkout', async r => {
    let cart;
    try { cart = JSON.parse(r.form.get('cart_data', '[]')); } catch (e) { cart = []; }
    if (!cart || (Array.isArray(cart) && !cart.length)) { flash('Cart is empty.', 'error'); return redirect('/pos'); }
    const customer_name = trim(r.form.get('customer_name', '')) || 'Walk-in Customer';
    const phone = trim(r.form.get('phone', ''));
    const payment_method = r.form.get('payment_method', 'Cash');
    const transport = parseTransport(r.form.get('transport', ''));
    let invoice_id, error;
    try {
      [invoice_id, error] = await DB.create_pos_sale(customer_name, phone, payment_method, cart, transport, parseServices(r), parseTransport(r.form.get('rft_ft', '')), parseTransport(r.form.get('rft_rate', '')), parseTransport(r.form.get('tip', '')), parseTransport(r.form.get('rft_in1', '')), parseTransport(r.form.get('rft_in2', '')));
    } catch (e) {
      if (!(e instanceof KeyError || e instanceof TypeErr || e instanceof ValueError || e instanceof TypeError)) throw e;
      flash('The cart data looked invalid. Please clear the cart and try again.', 'error');
      return redirect('/pos');
    }
    if (error) { flash(error, 'error'); return redirect('/pos'); }
    flash('Sale completed! Stock updated automatically.', 'success');
    return redirect(`/invoices/${invoice_id}`);
  });

  // ----- orders -----
  route('GET', '/orders', async r => {
    const search = r.args.get('q') || '';
    return render_template('orders_list.html', { orders: await DB.get_orders(search), search });
  });
  route('GET', '/orders/new', async () => render_template('order_form.html', { items: await DB.get_inventory(), products: rows(await DB.get_products()) }));
  route('POST', '/orders/new', async r => {
    let cart;
    try { cart = JSON.parse(r.form.get('cart_data', '[]')); } catch (e) { cart = []; }
    if (!cart || (Array.isArray(cart) && !cart.length)) { flash('Please add at least one item to the order.', 'error'); return redirect('/orders/new'); }
    const customer_name = trim(r.form.get('customer_name', ''));
    if (!customer_name) { flash('Customer name is required.', 'error'); return redirect('/orders/new'); }
    const phone = trim(r.form.get('phone', '')), address = trim(r.form.get('address', ''));
    const notes = trim(r.form.get('notes', '')), drawing_notes = trim(r.form.get('drawing_notes', ''));

    let drawing_filename = null;
    const drawing_file = r.files.get('drawing_file');
    const canvas_data = trim(r.form.get('drawing_canvas_data', ''));
    const stamp = () => Py.strftime(new Date(), '%Y%m%d%H%M%S');
    if (drawing_file && drawing_file.name) {
      const ext = drawing_file.name.includes('.') ? drawing_file.name.split('.').pop().toLowerCase() : '';
      if (!ALLOWED_DRAWING_EXTENSIONS.has(ext)) {
        flash('Drawing must be an image (PNG/JPG/WEBP) or a PDF.', 'error');
        return redirect('/orders/new');
      }
      const stamped_name = `${stamp()}_${Py.secureFilename(drawing_file.name)}`;
      if (drawing_file.size > 6 * 1024 * 1024) { flash('The drawing file is too large (maximum 6 MB).', 'error'); return redirect('/orders/new'); }
      await DB.save_drawing(stamped_name, await fileToDataUrl(drawing_file));
      drawing_filename = stamped_name;
    } else if (canvas_data.startsWith('data:image/png;base64,')) {
      try {
        const stamped_name = `${stamp()}_sketch.png`;
        await DB.save_drawing(stamped_name, canvas_data);
        drawing_filename = stamped_name;
      } catch (e) {
        flash('Could not save the drawing sketch — please try again.', 'error');
        return redirect('/orders/new');
      }
    }
    let order_id, order_no;
    try {
      [order_id, order_no] = await DB.create_order(customer_name, phone, address, notes, cart, drawing_filename, drawing_notes, parseTransport(r.form.get('transport', '')), parseServices(r), parseTransport(r.form.get('rft_ft', '')), parseTransport(r.form.get('rft_rate', '')), parseTransport(r.form.get('tip', '')), parseTransport(r.form.get('rft_in1', '')), parseTransport(r.form.get('rft_in2', '')));
    } catch (e) {
      if (!(e instanceof KeyError || e instanceof TypeErr || e instanceof ValueError || e instanceof TypeError)) throw e;
      flash('The order items looked invalid. Please re-add them and try again.', 'error');
      return redirect('/orders/new');
    }
    flash(`Order ${order_no} placed successfully.`, 'success');
    return redirect(`/orders/${order_id}`);
  });
  route('GET', '/orders/(\\d+)', async (r, id) => {
    const [order, items] = await DB.get_order(+id);
    if (!order) { flash('Order not found.', 'error'); return redirect('/orders'); }
    await prefetchDrawing(order.drawing_filename);
    return render_template('order_detail.html', { order, items });
  });
  route('POST', '/orders/(\\d+)/process', async (r, id) => {
    const [delivery_id, delivery_no, error] = await DB.process_order(+id);
    if (error) { flash(error, 'error'); return redirect(`/orders/${id}`); }
    flash(`Order processed! Delivery Note / Challan (${delivery_no}) created and stock was deducted. The Invoice will be generated automatically once this delivery is marked 'Delivered'.`, 'success');
    return redirect(`/deliveries/${delivery_id}`);
  });
  route('POST', '/orders/(\\d+)/cancel', async (r, id) => {
    await DB.cancel_order(+id);
    flash('Order cancelled.', 'success');
    return redirect('/orders');
  });

  // ----- product-wise sales report -----
  route('GET', '/reports/product', async r => {
    const search = trim(r.args.get('q') || '');
    const data = await DB.get_product_sales(search);
    return render_template('product_report.html', { search, summary: data.summary, rows: data.rows });
  });

  // ----- invoices -----
  route('GET', '/invoices', async r => {
    const search = r.args.get('q') || '';
    return render_template('invoices_list.html', { invoices: await DB.get_invoices(search), search });
  });
  route('GET', '/invoices/(\\d+)', async (r, id) => {
    const [invoice, items] = await DB.get_invoice(+id);
    if (!invoice) { flash('Invoice not found.', 'error'); return redirect('/invoices'); }
    let delivery = null;
    if (invoice.source === 'Order') delivery = await DB.get_delivery_for_invoice(+id);
    return render_template('invoice.html', { invoice, items, delivery });
  });
  route('POST', '/invoices/(\\d+)/mark-paid', async (r, id) => {
    await DB.mark_invoice_paid(+id, r.form.get('payment_method', 'Cash'));
    flash('Invoice marked as paid.', 'success');
    return redirect(`/invoices/${id}`);
  });

  // ----- deliveries -----
  route('GET', '/deliveries', async r => {
    const search = r.args.get('q') || '';
    return render_template('deliveries_list.html', { deliveries: await DB.get_deliveries(search), search });
  });
  route('GET', '/deliveries/(\\d+)', async (r, id) => {
    const [delivery, items, invoice, order] = await DB.get_delivery(+id);
    if (!delivery) { flash('Delivery not found.', 'error'); return redirect('/deliveries'); }
    if (order) await prefetchDrawing(order.drawing_filename);
    return render_template('delivery.html', { delivery, items, invoice, order });
  });
  route('POST', '/deliveries/(\\d+)/status', async (r, id) => {
    const new_invoice_id = await DB.update_delivery_status(+id, r.form.get('status', 'Ready for Delivery'));
    flash(new_invoice_id ? 'Delivery marked as Delivered! Invoice generated automatically.' : 'Delivery status updated.', 'success');
    return redirect(`/deliveries/${id}`);
  });

  // ----- backup & restore -----
  route('GET', '/backup', async () => {
    if (!Auth.isBoss()) { flash('Only the boss can use Backup & Restore.', 'error'); return redirect('/'); }
    if (CONFIG.TRIAL_MODE) return render_template('backup.html', { trial_mode: true, db_size_kb: 0 });
    return render_template('backup.html', { trial_mode: false, db_size_kb: await DB.db_size_kb() });
  });
  const downloadBytes = (bytes, filename) => {
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
    const a = document.createElement('a');
    a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  };
  // The "Backup Password" is your own login password (checked with the server, never stored in this code)
  route('POST', '/backup/download', async r => {
    if (!Auth.isBoss()) { flash('Only the boss can use Backup & Restore.', 'error'); return redirect('/'); }
    if (CONFIG.TRIAL_MODE) { flash('Backup & Restore is available in the licensed version.', 'error'); return redirect('/backup'); }
    if (!(await Auth.verifyPassword(r.form.get('password', '')))) { flash('Incorrect backup password.', 'error'); return redirect('/backup'); }
    downloadBytes(await DB.backup_bytes(), `marble_granite_backup_${Py.strftime(new Date(), '%Y-%m-%d_%H%M')}.db`);
    return { stay: true };
  });
  route('POST', '/backup/restore', async r => {
    if (!Auth.isBoss()) { flash('Only the boss can use Backup & Restore.', 'error'); return redirect('/'); }
    if (CONFIG.TRIAL_MODE) { flash('Backup & Restore is available in the licensed version.', 'error'); return redirect('/backup'); }
    if (!(await Auth.verifyPassword(r.form.get('password', '')))) {
      flash('Incorrect backup password. Restore cancelled - your current data is untouched.', 'error');
      return redirect('/backup');
    }
    const file = r.files.get('backup_file');
    if (!file || file.name === '') { flash('Please choose a backup file (.db) to restore.', 'error'); return redirect('/backup'); }
    if (!Py.secureFilename(file.name).toLowerCase().endsWith('.db')) {
      flash("That doesn't look like a backup file. Please choose the .db backup file.", 'error');
      return redirect('/backup');
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    // safety copy of what is online right now (downloaded to this computer before anything is replaced)
    try { downloadBytes(await DB.backup_bytes(), `_before_restore_${Py.strftime(new Date(), '%Y%m%d_%H%M%S')}.db`); } catch (e) { console.error(e); }
    let ok;
    try { ok = await DB.restore_from_bytes(bytes); }
    catch (e) {
      if (e instanceof AuthExpired) throw e;
      console.error(e);
      flash('Could not read that file - it may be corrupted or not a valid backup.', 'error');
      return redirect('/backup');
    }
    if (!ok) { flash("This file doesn't look like a valid backup of this system.", 'error'); return redirect('/backup'); }
    flash('Backup restored successfully! Your data from the other computer is now loaded here.', 'success');
    return redirect('/');
  });

  /* ---------- request dispatch ---------- */
  const formWrap = fd => ({
    get: (k, d = null) => { const v = fd.get(k); return typeof v === 'string' ? v : d; },
    getlist: k => fd.getAll(k).filter(v => typeof v === 'string'),
  });
  const filesWrap = fd => ({ get: k => { const v = fd.get(k); return (v instanceof File) ? v : null; } });

  async function dispatch(method, fullPath, fd) {
    const [path, qs] = fullPath.split('?');
    const req = { method, path, args: new URLSearchParams(qs || ''), form: formWrap(fd || new FormData()), files: filesWrap(fd || new FormData()) };
    if (!path.startsWith('/login') && !path.startsWith('/static') && !Auth.isLoggedIn()) {
      return redirect('/login?next=' + encodeURIComponent(path));
    }
    for (const [m, re, fn] of routes) {
      if (m !== method) continue;
      const mt = re.exec(path);
      if (mt) return fn(req, ...mt.slice(1));
    }
    return { html: '<!doctype html><title>404 Not Found</title><h1>Not Found</h1><p>The requested URL was not found.</p><a href="#/">Home</a>' };
  }

  let current = '/';
  async function handle(method, fullPath, fd, viaGet) {
    let res;
    try { res = await dispatch(method, fullPath, fd); }
    catch (e) {
      if (e instanceof AuthExpired) { flash('Your session expired. Please log in again.', 'error'); return go('/login', true); }
      console.error(e);
      res = { html: '<!doctype html><title>Error</title><h1>Something went wrong</h1><pre>' + String(e && e.stack || e).replace(/</g, '&lt;') + '</pre><a href="#/">Home</a>' };
    }
    if (res.redirect !== undefined) return go(res.redirect, viaGet);
    if (res.stay) return;
    if (method === 'GET') current = fullPath;
    show(res.html);
  }

  /* ---------- in-page dialogs ----------
     Browsers can silently block alert()/confirm() (e.g. "Prevent this page from
     creating additional dialogs" was ticked once). The original pages then looked
     dead: Process Order, Cancel, Delete... did nothing. So the pop-ups are shown
     inside the page instead, where they cannot be blocked. */
  function dialogBox(d, message, withCancel) {
    return new Promise(resolve => {
      const ov = d.createElement('div');
      ov.setAttribute('style', 'position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:2147483647;display:flex;align-items:center;justify-content:center;font-family:Arial,sans-serif;');
      const box = d.createElement('div');
      box.setAttribute('style', 'background:#fff;border-radius:8px;max-width:460px;width:88%;padding:22px 24px;box-shadow:0 10px 40px rgba(0,0,0,.35);');
      const msg = d.createElement('div');
      msg.setAttribute('style', 'font-size:15px;line-height:1.5;color:#2c3e50;white-space:pre-wrap;margin-bottom:18px;');
      msg.textContent = message;
      const row = d.createElement('div');
      row.setAttribute('style', 'display:flex;gap:10px;justify-content:flex-end;');
      const mk = (label, bg, val) => {
        const b = d.createElement('button'); b.type = 'button'; b.textContent = label;
        b.setAttribute('style', `padding:9px 20px;border:0;border-radius:5px;font-size:14px;font-weight:bold;cursor:pointer;color:#fff;background:${bg};`);
        b.onclick = () => { ov.remove(); resolve(val); };
        return b;
      };
      if (withCancel) row.appendChild(mk('Cancel', '#7f8c8d', false));
      const ok = mk('OK', '#2980b9', true);
      row.appendChild(ok);
      box.append(msg, row); ov.appendChild(box); d.body.appendChild(ov);
      ok.focus();
    });
  }
  function installDialogs(d, w) {
    // alert(): non-blocking in-page message
    w.alert = msg => { dialogBox(d, String(msg), false); };
    // confirm() inside page scripts must answer synchronously, so keep the native box,
    // but if the browser blocked it (answers "false" instantly) continue and tell the user.
    const nativeConfirm = w.confirm.bind(w);
    w.confirm = msg => {
      const t0 = performance.now();
      const r = nativeConfirm(msg);
      if (!r && performance.now() - t0 < 60) {
        dialogBox(d, 'Your browser is blocking pop-up boxes for this site, so this question could not be shown:\n\n' + msg + '\n\nIt was answered "OK" automatically.', false);
        return true;
      }
      return r;
    };
    // forms that used  onsubmit="return confirm('...')"  -> in-page confirmation
    d.querySelectorAll('form[onsubmit*="confirm("]').forEach(f => {
      const m = /confirm\((['"])([\s\S]*?)\1\)/.exec(f.getAttribute('onsubmit'));
      if (m) { f.dataset.confirm = m[2]; f.removeAttribute('onsubmit'); }
    });
  }

  function show(html) {
    frame.onload = () => {
      const d = frame.contentDocument, w = frame.contentWindow;
      if (d.title) document.title = d.title;
      installDialogs(d, w);
      d.addEventListener('click', e => {                 // links
        const a = e.target.closest && e.target.closest('a[href^="#/"]');
        if (!a || e.defaultPrevented || e.ctrlKey || e.metaKey || e.shiftKey || a.target === '_blank') return;
        e.preventDefault();
        go(a.getAttribute('href').slice(1), false);
      });
      d.addEventListener('submit', e => {                // forms (runs after the page's own handlers)
        if (e.defaultPrevented) return;
        e.preventDefault();
        const form = e.target;
        if (form.dataset.confirm && !form.dataset.ok) {  // in-page confirmation (see installDialogs)
          dialogBox(d, form.dataset.confirm, true).then(ok => {
            if (ok) { form.dataset.ok = '1'; form.requestSubmit(); }
          });
          return;
        }
        delete form.dataset.ok;
        const method = (form.getAttribute('method') || 'get').toUpperCase();
        const action = form.getAttribute('action');
        let target = action && action.startsWith('#/') ? action.slice(1) : current.split('?')[0];
        const fd = new FormData(form);
        if (method === 'GET') {
          const q = new URLSearchParams();
          for (const [k, v] of fd.entries()) if (typeof v === 'string') q.append(k, v);
          go(target + (q.toString() ? '?' + q.toString() : ''), false);
        } else {
          handle('POST', target, fd, false);
        }
      });
    };
    frame.hidden = false;
    document.getElementById('boot').hidden = true;
    frame.srcdoc = html;
  }

  function go(target, replace) {
    if (!target.startsWith('/')) target = '/' + target;
    const hash = '#' + target;
    if (location.hash === hash || (target === '/' && (location.hash === '' || location.hash === '#'))) {
      return handle('GET', target, null, true);          // same address: just re-render
    }
    if (replace) location.replace(hash); else location.hash = hash;   // -> hashchange
  }
  window.addEventListener('hashchange', () => handle('GET', location.hash.slice(1) || '/', null, true));

  /* ---------- start ---------- */
  (async () => {
    try {
      if (Auth.isLoggedIn()) await Auth.ensureRole();
      await Templates.load({ url_for, get_flashed_messages, session, TRIAL_MODE: CONFIG.TRIAL_MODE });
    } catch (e) {
      document.getElementById('boot').textContent = 'Could not start: ' + e.message +
        ' (open this site through a web server such as GitHub Pages, not by double-clicking index.html)';
      console.error(e);
      return;
    }
    handle('GET', location.hash.slice(1) || '/', null, true);
  })();
})();
