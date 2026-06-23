/* ============================================================
   QUICKPAPA — UI controller (shared layout + page logic)
   ============================================================ */

const ICONS = {
  cart: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="21" r="1.6"/><circle cx="18" cy="21" r="1.6"/><path d="M2 3h3l2.4 13.4a2 2 0 0 0 2 1.6h8.7a2 2 0 0 0 2-1.6L22 7H6"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>',
  user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
  menu: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 6h18M3 12h18M3 18h18"/></svg>',
  close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
  check: '✓',
  shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>',
  bolt: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2 3 14h7l-1 8 10-12h-7z"/></svg>',
  wave: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12h2M20 12h2M6 8v8M10 5v14M14 7v10M18 10v4"/></svg>',
  mic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0M12 19v3"/></svg>',
  drop: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2s6 6 6 11a6 6 0 0 1-12 0c0-5 6-11 6-11z"/></svg>',
  battery: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="16" height="10" rx="2"/><path d="M22 11v2"/><path d="M6 10v4M10 10v4"/></svg>',
  bluetooth: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m7 7 10 10-5 5V2l5 5L7 17"/></svg>',
  game: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="6" y1="12" x2="10" y2="12"/><line x1="8" y1="10" x2="8" y2="14"/><circle cx="15" cy="11" r="1"/><circle cx="18" cy="13" r="1"/><rect x="2" y="6" width="20" height="12" rx="4"/></svg>',
  truck: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 3h15v13H1zM16 8h4l3 3v5h-7"/><circle cx="6" cy="18" r="2"/><circle cx="18" cy="18" r="2"/></svg>',
  return_: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7v6h6M3 13a9 9 0 1 0 3-7"/></svg>',
  lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>',
  star: '★',
  emptyBox: '<svg viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7 12 3l9 4v10l-9 4-9-4z"/><path d="M3 7l9 4 9-4M12 11v10"/></svg>',
  success: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
};

const NAV_LINKS = [
  { href: "index.html", label: "Home" },
  { href: "product.html", label: "Shop" },
  { href: "about.html", label: "About" },
  { href: "contact.html", label: "Contact" },
];

/* ---------- Shared layout ---------- */
function renderHeader(activePage) {
  const links = NAV_LINKS.map(l =>
    `<a href="${l.href}" class="${l.href === activePage ? "active" : ""}">${l.label}</a>`
  ).join("");
  return `
  <header class="header">
    <div class="container">
      <a href="index.html" class="brand">
        <span class="brand-mark">Q</span>
        <span>QUICKPAPA</span>
      </a>
      <nav class="nav" id="nav">${links}</nav>
      <div class="header-actions">
        <a href="product.html" class="icon-btn" aria-label="Search">${ICONS.search}</a>
        <a href="#" class="icon-btn" aria-label="Account">${ICONS.user}</a>
        <a href="cart.html" class="icon-btn" aria-label="Cart" id="cart-link">
          ${ICONS.cart}
          <span class="cart-badge empty" id="cart-badge">0</span>
        </a>
        <button class="icon-btn menu-toggle" id="menu-toggle" aria-label="Menu">${ICONS.menu}</button>
      </div>
    </div>
  </header>`;
}

function renderFooter() {
  return `
  <footer class="footer">
    <div class="container">
      <div class="footer-grid">
        <div class="footer-brand">
          <a href="index.html" class="brand"><span class="brand-mark">Q</span><span>QUICKPAPA</span></a>
          <p>Premium sound, honest prices. QUICKPAPA crafts wireless earbuds engineered for everyday life — workouts, commutes, calls and everything between.</p>
          <div class="socials">
            <a href="#" aria-label="Twitter">${ICON("twitter")}</a>
            <a href="#" aria-label="Instagram">${ICON("instagram")}</a>
            <a href="#" aria-label="YouTube">${ICON("youtube")}</a>
            <a href="#" aria-label="TikTok">${ICON("tiktok")}</a>
          </div>
        </div>
        <div class="footer-col">
          <h4>Shop</h4>
          <a href="product.html">All earbuds</a>
          <a href="product.html?p=qp-pro">QUICKPAPA Pro</a>
          <a href="product.html?p=qp-air">QUICKPAPA Air</a>
          <a href="product.html?p=qp-sport">QUICKPAPA Sport</a>
          <a href="#">Accessories</a>
          <a href="#">Gift cards</a>
        </div>
        <div class="footer-col">
          <h4>Support</h4>
          <a href="contact.html">Contact us</a>
          <a href="#">Shipping & returns</a>
          <a href="#">Warranty</a>
          <a href="#">Track order</a>
          <a href="#">FAQ</a>
        </div>
        <div class="footer-col">
          <h4>Company</h4>
          <a href="about.html">About</a>
          <a href="#">Careers</a>
          <a href="#">Press</a>
          <a href="#">Sustainability</a>
          <a href="#">Affiliates</a>
        </div>
      </div>
      <div class="footer-bottom">
        <span>© ${new Date().getFullYear()} QUICKPAPA Audio Inc. All rights reserved.</span>
        <span>Secure checkout · 24-month warranty · 30-day returns</span>
      </div>
    </div>
  </footer>`;
}

function ICON(name) {
  const m = {
    twitter: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M18.9 2H22l-7 8 8.2 12h-6.4l-5-6.6L6 22H3l7.5-8.6L2.5 2H9l4.5 6z"/></svg>',
    instagram: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.5" cy="6.5" r="1.2" fill="currentColor" stroke="none"/></svg>',
    youtube: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M23 12s0-3.2-.4-4.7a2.5 2.5 0 0 0-1.8-1.8C19.2 5 12 5 12 5s-7.2 0-8.8.5A2.5 2.5 0 0 0 1.4 7.3C1 8.8 1 12 1 12s0 3.2.4 4.7a2.5 2.5 0 0 0 1.8 1.8C4.8 19 12 19 12 19s7.2 0 8.8-.5a2.5 2.5 0 0 0 1.8-1.8C23 15.2 23 12 23 12zM10 15.5v-7l6 3.5z"/></svg>',
    tiktok: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M16 3c.3 2.2 1.6 4 4 4.4v3.1c-1.5 0-2.9-.5-4-1.3v6.1a5.8 5.8 0 1 1-5.8-5.8c.3 0 .6 0 .9.1v3.2a2.7 2.7 0 1 0 1.9 2.6V3z"/></svg>',
  };
  return m[name] || "";
}

/* ---------- Toast ---------- */
function toast(message) {
  let wrap = document.querySelector(".toast-wrap");
  if (!wrap) { wrap = document.createElement("div"); wrap.className = "toast-wrap"; document.body.appendChild(wrap); }
  const t = document.createElement("div");
  t.className = "toast";
  t.innerHTML = `<span class="check">${ICONS.check}</span><span>${message}</span>`;
  wrap.appendChild(t);
  setTimeout(() => { t.classList.add("out"); setTimeout(() => t.remove(), 250); }, 2600);
}

/* ---------- Cart badge ---------- */
function updateCartBadge() {
  const badges = document.querySelectorAll("#cart-badge");
  const count = Store.count();
  badges.forEach(b => {
    b.textContent = count;
    b.classList.toggle("empty", count === 0);
  });
}

/* ---------- Helpers ---------- */
function stars(rating) {
  const full = Math.round(rating);
  return ICONS.star.repeat(full) + "☆".repeat(5 - full);
}
function qs(name) {
  return new URLSearchParams(location.search).get(name);
}
function badgeLabel(b) {
  return b === "sale" ? "Sale" : b === "new" ? "New" : b === "hot" ? "Hot" : "";
}

function productCardHTML(p) {
  const color = p.defaultColor;
  return `
  <article class="product-card">
    <a href="product.html?p=${p.id}" class="product-thumb">
      ${p.badge ? `<span class="badge-flag ${p.badge}">${badgeLabel(p.badge)}</span>` : ""}
      ${Store.earbudSVG(color)}
    </a>
    <div class="product-body">
      <span class="cat">${p.category}</span>
      <h3><a href="product.html?p=${p.id}">${p.name}</a></h3>
      <p class="desc">${p.short}</p>
      <div class="rating"><span class="stars">${stars(p.rating)}</span> ${p.rating} <span class="dim">(${p.reviews.toLocaleString()})</span></div>
      <div class="product-foot">
        <div class="price">${Store.format(p.price)}${p.wasPrice ? `<span class="was">${Store.format(p.wasPrice)}</span>` : ""}</div>
        <button class="btn btn-primary btn-sm add-quick" data-id="${p.id}" data-color="${color}">Add</button>
      </div>
    </div>
  </article>`;
}

function bindQuickAdd(root = document) {
  root.querySelectorAll(".add-quick").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      Store.add(btn.dataset.id, btn.dataset.color, 1);
      toast("Added to cart");
      updateCartBadge();
    });
  });
}

/* ---------- Page controllers ---------- */
const Pages = {};

Pages.home = function () {
  const grid = document.getElementById("featured-grid");
  if (grid) {
    grid.innerHTML = Store.PRODUCTS.map(productCardHTML).join("");
    bindQuickAdd(grid);
  }
};

Pages.shop = function () {
  const grid = document.getElementById("catalog-grid");
  if (!grid) return;
  // show all variants of all products OR just the three products; we show the three main products
  grid.innerHTML = Store.PRODUCTS.map(productCardHTML).join("");
  bindQuickAdd(grid);

  // category filter
  const filterBtns = document.querySelectorAll(".filter-btn");
  filterBtns.forEach(b => b.addEventListener("click", () => {
    filterBtns.forEach(x => x.classList.remove("active"));
    b.classList.add("active");
    const cat = b.dataset.cat;
    const list = cat === "all" ? Store.PRODUCTS : Store.PRODUCTS.filter(p => p.category === cat);
    grid.innerHTML = list.map(productCardHTML).join("") ||
      `<div class="empty"><h3>Nothing here yet</h3><p>Check back soon for more QUICKPAPA gear.</p></div>`;
    bindQuickAdd(grid);
  }));
};

Pages.pdp = function () {
  const root = document.getElementById("pdp-root");
  if (!root) return;
  const id = qs("p") || "qp-pro";
  const p = Store.get(id);
  if (!p) { root.innerHTML = `<div class="empty"><h3>Product not found</h3><a class="btn btn-primary" href="product.html">Back to shop</a></div>`; return; }

  let stateColor = p.defaultColor;
  let stateQty = 1;
  let stateView = 0; // gallery view index (0 = bud, 1 = case, 2 = bud angle...)

  const views = [
    { label: "Buds", render: () => Store.earbudSVG(stateColor) },
    { label: "Case", render: () => Store.caseSVG(stateColor) },
    { label: "Pair", render: () => `<div style="display:flex;gap:14px;justify-content:center;width:80%">${Store.earbudSVG(stateColor)}<div style="transform:scaleX(-1)">${Store.earbudSVG(stateColor)}</div></div>` },
  ];

  document.getElementById("pdp-title").textContent = p.name;
  document.title = `${p.name} — QUICKPAPA`;

  root.innerHTML = `
    <div class="pdp">
      <div class="gallery">
        <div class="gallery-main" id="gallery-main">${views[0].render()}</div>
        <div class="gallery-thumbs" id="thumbs">
          ${views.map((v, i) => `<div class="thumb ${i === 0 ? "active" : ""}" data-i="${i}">${v.render()}</div>`).join("")}
        </div>
        <div class="row gap" style="margin-top:18px;flex-wrap:wrap">
          <span class="badge-flag" style="position:static;background:rgba(46,204,113,.15);color:var(--success)">${p.inStock ? "In stock" : "Sold out"}</span>
          <span class="dim" style="font-size:.85rem">SKU: ${p.sku}</span>
        </div>
      </div>
      <div class="pdp-info">
        <div class="breadcrumb"><a href="index.html">Home</a> / <a href="product.html">Shop</a> / <span>${p.name}</span></div>
        <span class="cat" style="font-size:.78rem;color:var(--text-dim);text-transform:uppercase;letter-spacing:.08em">${p.category}</span>
        <h1>${p.name}</h1>
        <div class="rating" style="margin-bottom:8px"><span class="stars">${stars(p.rating)}</span> <strong>${p.rating}</strong> <span class="dim">· ${p.reviews.toLocaleString()} reviews</span></div>
        <p class="sub muted">${p.short}</p>
        <div class="price-block">
          <span class="now">${Store.format(p.price)}</span>
          ${p.wasPrice ? `<span class="was">${Store.format(p.wasPrice)}</span><span class="save">Save ${Store.format(p.wasPrice - p.price)}</span>` : ""}
        </div>
        <div class="divider"></div>

        <div class="option-label">Color — <span id="color-name" style="color:var(--text);text-transform:none;letter-spacing:0">${Store.COLORS[p.defaultColor].name}</span></div>
        <div class="color-swatches" id="swatches">
          ${p.colors.map(c => `<div class="swatch ${c === p.defaultColor ? "active" : ""}" data-color="${c}" style="background:${Store.COLORS[c].body}"></div>`).join("")}
        </div>

        <div class="divider"></div>

        <div class="option-label">Quantity</div>
        <div class="pdp-actions">
          <div class="qty" id="qty">
            <button id="qty-minus" aria-label="Decrease">−</button>
            <input id="qty-input" type="number" value="1" min="1" max="10">
            <button id="qty-plus" aria-label="Increase">+</button>
          </div>
          <button class="btn btn-primary btn-lg" id="add-cart">Add to cart · ${Store.format(p.price)}</button>
        </div>
        <button class="btn btn-ghost btn-block" id="buy-now" style="margin-top:12px">Buy it now</button>

        <div class="divider"></div>
        <div class="row gap-lg" style="flex-wrap:wrap">
          <span class="muted" style="font-size:.9rem;display:inline-flex;align-items:center;gap:8px">${ICONS.truck} Free shipping over $75</span>
          <span class="muted" style="font-size:.9rem;display:inline-flex;align-items:center;gap:8px">${ICONS.return_} 30-day returns</span>
          <span class="muted" style="font-size:.9rem;display:inline-flex;align-items:center;gap:8px">${ICONS.shield} 24-month warranty</span>
        </div>
      </div>
    </div>

    <div class="tabs" id="tabs">
      <div class="tab-nav">
        <button class="tab-btn active" data-tab="highlights">Highlights</button>
        <button class="tab-btn" data-tab="specs">Specifications</button>
        <button class="tab-btn" data-tab="description">Description</button>
        <button class="tab-btn" data-tab="reviews">Reviews (${p.reviews.toLocaleString()})</button>
      </div>
      <div class="tab-panel active" id="tab-highlights">
        <ul class="bullets">${p.highlights.map(h => `<li>${h}</li>`).join("")}</ul>
      </div>
      <div class="tab-panel" id="tab-specs">
        <div class="spec-list">${Object.entries(p.specs).map(([k, v]) => `<div class="spec-item"><span class="k">${k}</span><span class="v">${v}</span></div>`).join("")}</div>
      </div>
      <div class="tab-panel" id="tab-description">
        <p>${p.description}</p>
        <p>Every QUICKPAPA Pro is tuned by our acoustic engineers for a balanced, engaging signature with articulate mids, smooth treble and a bass that stays controlled at any volume. The included app lets you remap touch controls, switch between ANC / Transparency / Off, and dial in your own EQ.</p>
        <p><strong>What's in the box:</strong> ${p.name}, wireless charging case, USB-C cable, 3 sizes of silicone ear tips (S/M/L), user manual, warranty card.</p>
      </div>
      <div class="tab-panel" id="tab-reviews">
        ${(Store.REVIEWS[p.id] || []).map(r => `
          <div class="review">
            <div class="who">
              <div class="avatar">${r.name.charAt(0)}</div>
              <div><div class="name">${r.name}</div><div class="date">${r.date} · <span class="stars">${stars(r.rating)}</span></div></div>
            </div>
            <h4 style="margin-bottom:6px">${r.title}</h4>
            <p class="muted">${r.body}</p>
          </div>`).join("")}
      </div>
    </div>
  `;

  // gallery thumbs
  const galleryMain = document.getElementById("gallery-main");
  document.querySelectorAll("#thumbs .thumb").forEach(t => {
    t.addEventListener("click", () => {
      stateView = +t.dataset.i;
      document.querySelectorAll("#thumbs .thumb").forEach(x => x.classList.remove("active"));
      t.classList.add("active");
      galleryMain.innerHTML = views[stateView].render();
    });
  });

  // swatches
  document.querySelectorAll("#swatches .swatch").forEach(s => {
    s.addEventListener("click", () => {
      stateColor = s.dataset.color;
      document.querySelectorAll("#swatches .swatch").forEach(x => x.classList.remove("active"));
      s.classList.add("active");
      document.getElementById("color-name").textContent = Store.COLORS[stateColor].name;
      galleryMain.innerHTML = views[stateView].render();
      document.querySelectorAll("#thumbs .thumb").forEach((t, i) => { t.innerHTML = ""; t.insertAdjacentHTML("afterbegin", views[i].render()); });
    });
  });

  // qty
  const qtyInput = document.getElementById("qty-input");
  document.getElementById("qty-minus").addEventListener("click", () => { qtyInput.value = Math.max(1, (+qtyInput.value) - 1); stateQty = +qtyInput.value; });
  document.getElementById("qty-plus").addEventListener("click", () => { qtyInput.value = Math.min(10, (+qtyInput.value) + 1); stateQty = +qtyInput.value; });
  qtyInput.addEventListener("change", () => { stateQty = Math.max(1, Math.min(10, +qtyInput.value || 1)); qtyInput.value = stateQty; });

  // add to cart
  document.getElementById("add-cart").addEventListener("click", () => {
    Store.add(p.id, stateColor, stateQty);
    updateCartBadge();
    toast(`Added ${stateQty} × ${Store.COLORS[stateColor].name} to cart`);
  });
  document.getElementById("buy-now").addEventListener("click", () => {
    Store.add(p.id, stateColor, stateQty);
    updateCartBadge();
    location.href = "checkout.html";
  });

  // tabs
  document.querySelectorAll(".tab-btn").forEach(b => {
    b.addEventListener("click", () => {
      document.querySelectorAll(".tab-btn").forEach(x => x.classList.remove("active"));
      document.querySelectorAll(".tab-panel").forEach(x => x.classList.remove("active"));
      b.classList.add("active");
      document.getElementById("tab-" + b.dataset.tab).classList.add("active");
    });
  });

  // related
  const rel = document.getElementById("related-grid");
  if (rel) {
    rel.innerHTML = Store.PRODUCTS.filter(x => x.id !== p.id).map(productCardHTML).join("");
    bindQuickAdd(rel);
  }

  // Hydrate the reviews tab from the backend (replaces the embedded fallback).
  Store.fetchReviews(p.id).then((revs) => {
    const panel = document.getElementById("tab-reviews");
    if (!panel || !revs || !revs.length) return;
    panel.innerHTML = revs.map(r => `
      <div class="review">
        <div class="who">
          <div class="avatar">${(r.name || "?").charAt(0)}</div>
          <div><div class="name">${r.name}</div><div class="date">${r.date} · <span class="stars">${stars(r.rating)}</span></div></div>
        </div>
        <h4 style="margin-bottom:6px">${r.title || ""}</h4>
        <p class="muted">${r.body || ""}</p>
      </div>`).join("");
  });
};

Pages.cart = function () {
  const root = document.getElementById("cart-root");
  if (!root) return;

  function render() {
    const items = Store.cart();
    if (items.length === 0) {
      root.innerHTML = `
        <div class="empty">
          ${ICONS.emptyBox}
          <h3>Your cart is empty</h3>
          <p>Looks like you haven't added any earbuds yet. Let's fix that.</p>
          <a class="btn btn-primary btn-lg" href="product.html">Shop earbuds</a>
        </div>`;
      return;
    }

    const totals = Store.totals();
    const promo = Store.activePromo();
    root.innerHTML = `
      <div class="cart-layout">
        <div class="cart-items" id="cart-items">
          ${items.map(i => {
            const p = Store.get(i.id);
            if (!p) return "";
            return `
            <div class="cart-item" data-id="${i.id}" data-color="${i.color}">
              <div class="thumb">${Store.earbudSVG(i.color)}</div>
              <div class="meta">
                <h4>${p.name}</h4>
                <div class="variant">Color: ${Store.COLORS[i.color].name}</div>
                <div class="price-each">${Store.format(p.price)} each</div>
                <div class="qty" style="margin-top:10px">
                  <button class="dec">−</button>
                  <input type="number" value="${i.qty}" min="1" max="10" class="qty-input">
                  <button class="inc">+</button>
                </div>
              </div>
              <div class="right">
                <div class="line-total">${Store.format(p.price * i.qty)}</div>
                <button class="remove-btn">${ICONS.trash} Remove</button>
              </div>
            </div>`;
          }).join("")}
        </div>
        <aside class="summary-card">
          <h3>Order summary</h3>
          <div class="summary-row"><span>Subtotal</span><span class="amount">${Store.format(totals.subtotal)}</span></div>
          ${totals.discount ? `<div class="summary-row" style="color:var(--success)"><span>Discount${promo ? ` (${promo})` : ""}</span><span class="amount">−${Store.format(totals.discount)}</span></div>` : ""}
          <div class="summary-row"><span>Shipping</span><span class="amount">${totals.shipping === 0 ? "Free" : Store.format(totals.shipping)}</span></div>
          <div class="summary-row"><span>Tax (8%)</span><span class="amount">${Store.format(totals.tax)}</span></div>
          <div class="summary-row total"><span>Total</span><span class="amount">${Store.format(totals.total)}</span></div>
          <div class="promo">
            <input id="promo-input" type="text" placeholder="Promo code" value="${promo || ""}">
            <button class="btn btn-ghost btn-sm" id="promo-apply">Apply</button>
          </div>
          <div id="promo-msg" class="dim" style="font-size:.8rem;margin-bottom:14px">Try <strong>WELCOME10</strong> or <strong>FREE_SHIP</strong></div>
          <a class="btn btn-primary btn-block btn-lg" href="checkout.html" style="margin-top:8px">Checkout</a>
          <a class="btn btn-ghost btn-block" href="product.html" style="margin-top:10px">Continue shopping</a>
          <div class="row gap" style="margin-top:18px;justify-content:center;color:var(--text-dim);font-size:.78rem">
            <span style="display:inline-flex;gap:6px;align-items:center">${ICONS.lock} Secure</span>
            <span style="display:inline-flex;gap:6px;align-items:center">${ICONS.return_} 30-day returns</span>
          </div>
        </aside>
      </div>`;

    // bind qty / remove
    root.querySelectorAll(".cart-item").forEach(el => {
      const id = el.dataset.id, color = el.dataset.color;
      const input = el.querySelector(".qty-input");
      el.querySelector(".inc").addEventListener("click", () => { Store.setQty(id, color, (+input.value) + 1); render(); updateCartBadge(); });
      el.querySelector(".dec").addEventListener("click", () => { Store.setQty(id, color, (+input.value) - 1); render(); updateCartBadge(); });
      input.addEventListener("change", () => { Store.setQty(id, color, +input.value || 1); render(); updateCartBadge(); });
      el.querySelector(".remove-btn").addEventListener("click", () => { Store.remove(id, color); render(); updateCartBadge(); toast("Removed from cart"); });
    });
    document.getElementById("promo-apply").addEventListener("click", () => {
      const code = document.getElementById("promo-input").value;
      const result = Store.applyPromo(code);
      const msg = document.getElementById("promo-msg");
      if (result) { msg.style.color = "var(--success)"; msg.textContent = `✓ ${result.label} applied`; render(); toast("Promo applied"); }
      else { msg.style.color = "var(--danger)"; msg.textContent = "Invalid promo code"; }
    });
  }

  render();
  window.addEventListener("cart:change", render, { once: false });
};

Pages.checkout = function () {
  const root = document.getElementById("checkout-root");
  if (!root) return;

  function itemsHTML() {
    const items = Store.cart();
    if (items.length === 0) return null;
    return items.map(i => {
      const p = Store.get(i.id);
      return `<div class="order-line">
        <div class="thumb">${Store.earbudSVG(i.color)}</div>
        <div class="info">${p.name} <span class="qty-x">× ${i.qty} · ${Store.COLORS[i.color].name}</span></div>
        <div class="amt">${Store.format(p.price * i.qty)}</div>
      </div>`;
    }).join("");
  }

  const orderItems = itemsHTML();
  if (!orderItems) {
    root.innerHTML = `<div class="empty">${ICONS.emptyBox}<h3>Your cart is empty</h3><p>Add some earbuds before checking out.</p><a class="btn btn-primary" href="product.html">Shop now</a></div>`;
    return;
  }

  const totals = Store.totals();
  root.innerHTML = `
    <div class="checkout-layout">
      <div>
        <form id="checkout-form">
          <div class="panel">
            <h3><span class="step-num">1</span> Contact</h3>
            <div class="sub">We'll send your order confirmation here.</div>
            <div class="field full">
              <label for="email">Email address</label>
              <input id="email" name="email" type="email" placeholder="you@example.com">
              <div class="err">Please enter a valid email.</div>
            </div>
          </div>
          <div class="panel">
            <h3><span class="step-num">2</span> Shipping address</h3>
            <div class="form-grid">
              <div class="field"><label>First name</label><input id="fname" name="fname"><div class="err">Required.</div></div>
              <div class="field"><label>Last name</label><input id="lname" name="lname"><div class="err">Required.</div></div>
              <div class="field full"><label>Address</label><input id="addr" name="addr"><div class="err">Required.</div></div>
              <div class="field full"><label>Apt / Suite (optional)</label><input id="apt" name="apt"></div>
              <div class="field"><label>City</label><input id="city" name="city"><div class="err">Required.</div></div>
              <div class="field"><label>State / Province</label><input id="state" name="state"><div class="err">Required.</div></div>
              <div class="field"><label>ZIP / Postal code</label><input id="zip" name="zip"><div class="err">Required.</div></div>
              <div class="field"><label>Country</label>
                <select id="country"><option>United States</option><option>Canada</option><option>United Kingdom</option><option>Australia</option><option>Germany</option><option>Japan</option><option>Other</option></select>
              </div>
              <div class="field full"><label>Phone</label><input id="phone" name="phone" type="tel"><div class="err">Required.</div></div>
            </div>
          </div>
          <div class="panel">
            <h3><span class="step-num">3</span> Payment</h3>
            <div class="sub">All transactions are secure and encrypted.</div>
            <div class="pay-options" id="pay-options">
              <label class="pay-option active"><input type="radio" name="pay" value="card" checked><div><div class="name">Credit / Debit card</div><div class="desc">Visa, Mastercard, Amex</div></div></label>
              <label class="pay-option"><input type="radio" name="pay" value="paypal"><div><div class="name">PayPal</div><div class="desc">Pay with your PayPal balance</div></div></label>
              <label class="pay-option"><input type="radio" name="pay" value="apple"><div><div class="name">Apple Pay</div><div class="desc">Fast checkout on Apple devices</div></div></label>
            </div>
            <div id="card-fields" style="margin-top:18px">
              <div class="field full"><label>Card number</label><input id="card" name="card" inputmode="numeric" placeholder="1234 5678 9012 3456"><div class="err">Enter a 16-digit card number.</div></div>
              <div class="form-grid">
                <div class="field"><label>Expiry (MM/YY)</label><input id="exp" placeholder="08/28"><div class="err">MM/YY</div></div>
                <div class="field"><label>CVC</label><input id="cvc" inputmode="numeric" placeholder="123"><div class="err">3-4 digits</div></div>
              </div>
            </div>
          </div>
          <button type="submit" class="btn btn-primary btn-block btn-lg" id="place-order">Place order · ${Store.format(totals.total)}</button>
          <p class="dim center" style="margin-top:14px;font-size:.8rem">${ICONS.lock} This is a demo store — no real payment is processed.</p>
        </form>
      </div>
      <aside>
        <div class="summary-card">
          <h3>Your order</h3>
          <div class="order-items" id="order-items">${orderItems}</div>
          <div class="summary-row"><span>Subtotal</span><span class="amount">${Store.format(totals.subtotal)}</span></div>
          ${totals.discount ? `<div class="summary-row" style="color:var(--success)"><span>Discount${totals.promo ? ` (${totals.promo})` : ""}</span><span class="amount">−${Store.format(totals.discount)}</span></div>` : ""}
          <div class="summary-row"><span>Shipping</span><span class="amount">${totals.shipping === 0 ? "Free" : Store.format(totals.shipping)}</span></div>
          <div class="summary-row"><span>Tax</span><span class="amount">${Store.format(totals.tax)}</span></div>
          <div class="summary-row total"><span>Total</span><span class="amount">${Store.format(totals.total)}</span></div>
        </div>
      </aside>
    </div>`;

  // payment toggle
  document.querySelectorAll(".pay-option").forEach(opt => {
    opt.addEventListener("click", () => {
      document.querySelectorAll(".pay-option").forEach(x => x.classList.remove("active"));
      opt.classList.add("active");
      const cardFields = document.getElementById("card-fields");
      cardFields.style.display = opt.querySelector("input").value === "card" ? "block" : "none";
    });
  });

  // validation
  const form = document.getElementById("checkout-form");
  function setInvalid(id, bad) {
    const field = document.getElementById(id).closest(".field");
    if (field) field.classList.toggle("invalid", bad);
    return !bad;
  }
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    let ok = true;
    const email = document.getElementById("email").value.trim();
    ok = setInvalid("email", !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) && ok;
    ["fname", "lname", "addr", "city", "state", "zip", "phone"].forEach(id => {
      ok = setInvalid(id, !document.getElementById(id).value.trim()) && ok;
    });
    const pay = document.querySelector('input[name="pay"]:checked').value;
    if (pay === "card") {
      ok = setInvalid("card", document.getElementById("card").value.replace(/\s/g, "").length < 12) && ok;
      ok = setInvalid("exp", !/^\d{2}\/\d{2}$/.test(document.getElementById("exp").value.trim())) && ok;
      ok = setInvalid("cvc", document.getElementById("cvc").value.trim().length < 3) && ok;
    }
    if (!ok) { toast("Please fix the highlighted fields"); return; }

    // Submit to the backend, which recomputes totals and persists to SQLite.
    const btn = document.getElementById("place-order");
    btn.disabled = true; btn.textContent = "Placing order…";
    const payload = {
      email,
      firstName: document.getElementById("fname").value.trim(),
      lastName: document.getElementById("lname").value.trim(),
      address: document.getElementById("addr").value.trim(),
      apt: document.getElementById("apt").value.trim(),
      city: document.getElementById("city").value.trim(),
      state: document.getElementById("state").value.trim(),
      zip: document.getElementById("zip").value.trim(),
      country: document.getElementById("country").value,
      phone: document.getElementById("phone").value.trim(),
      payment: pay,
      promo: Store.activePromo() || "",
      items: Store.cart(),
    };
    try {
      const order = await Store.submitOrder(payload);
      localStorage.setItem("quickpapa_last_order", JSON.stringify({
        id: order.id, date: new Date().toLocaleDateString(),
        total: order.total, email,
      }));
      Store.clear();
      location.href = "success.html";
    } catch (err) {
      btn.disabled = false; btn.textContent = "Place order";
      toast(err.message || "Order failed — please try again");
    }
  });
};

Pages.success = function () {
  const root = document.getElementById("success-root");
  if (!root) return;
  const order = JSON.parse(localStorage.getItem("quickpapa_last_order") || "null");
  if (!order) { location.href = "index.html"; return; }
  root.innerHTML = `
    <div class="success-card">
      <div class="success-icon">${ICONS.success}</div>
      <h1>Order confirmed!</h1>
      <p class="muted">Thanks for choosing QUICKPAPA. A confirmation has been sent to <strong>${order.email}</strong>.</p>
      <div class="order-receipt">
        <div class="summary-row"><span>Order number</span><span class="amount">${order.id}</span></div>
        <div class="summary-row"><span>Date</span><span>${order.date}</span></div>
        <div class="summary-row total"><span>Total paid</span><span class="amount">${Store.format(order.total)}</span></div>
      </div>
      <p class="dim" style="font-size:.85rem;margin-bottom:24px">Estimated delivery: 3-5 business days. You'll get a tracking link by email once your order ships.</p>
      <a class="btn btn-primary btn-lg" href="product.html">Continue shopping</a>
    </div>`;
};

Pages.about = function () {};
Pages.contact = function () {
  const form = document.getElementById("contact-form");
  if (!form) return;
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    let ok = true;
    form.querySelectorAll("[required]").forEach(inp => {
      const field = inp.closest(".field") || inp.parentElement;
      const bad = !inp.value.trim() || (inp.type === "email" && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(inp.value));
      if (field && field.classList) field.classList.toggle("invalid", bad);
      if (bad) ok = false;
    });
    if (!ok) { toast("Please fill in all required fields"); return; }
    form.reset();
    toast("Message sent — we'll reply within 24h");
  });
};

/* ---------- Boot ---------- */
document.addEventListener("DOMContentLoaded", () => {
  const body = document.body;
  const page = body.dataset.page;

  const mount = document.getElementById("layout-header");
  if (mount) mount.innerHTML = renderHeader(page);
  const foot = document.getElementById("layout-footer");
  if (foot) foot.innerHTML = renderFooter();

  // mobile nav
  const toggle = document.getElementById("menu-toggle");
  const nav = document.getElementById("nav");
  if (toggle && nav) {
    toggle.addEventListener("click", () => {
      nav.classList.toggle("open");
      toggle.innerHTML = nav.classList.contains("open") ? ICONS.close : ICONS.menu;
    });
  }

  // newsletter form
  document.querySelectorAll(".newsletter").forEach(nf => {
    nf.addEventListener("submit", (e) => {
      e.preventDefault();
      const input = nf.querySelector("input");
      if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(input.value.trim())) { toast("Subscribed — welcome aboard!"); input.value = ""; }
      else toast("Enter a valid email");
    });
  });

  updateCartBadge();
  window.addEventListener("cart:change", updateCartBadge);

  // Load catalog from the backend (falls back to embedded data if API is down).
  Store.init().then(() => {
    // product.html serves both the catalog and the detail page
    if (page === "product") {
      if (qs("p")) Pages.pdp(); else Pages.shop();
    } else if (Pages[page]) {
      Pages[page]();
    }
  });
});