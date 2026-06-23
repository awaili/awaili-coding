/* ============================================================
   QUICKPAPA store — product catalog + cart logic
   ============================================================ */

const COLORS = {
  black:  { name: "Midnight Black",   body: "#1c1c28", stem: "#0f0f18", accent: "#2a2a3e" },
  white:  { name: "Pearl White",      body: "#ececf2", stem: "#d8d8e2", accent: "#c2c2d2" },
  blue:   { name: "Ocean Blue",       body: "#2a4d7a", stem: "#1d3357", accent: "#3a6ba0" },
  sand:   { name: "Sand Beige",       body: "#d8c4a8", stem: "#c0a888", accent: "#b09878" },
  green:  { name: "Forest Green",    body: "#2c5e4a", stem: "#1d4232", accent: "#3a7a60" },
};

/**
 * Inline SVG art for a single earbud. Lightweight, scalable, offline.
 */
function earbudSVG(color = "black", opts = {}) {
  const c = COLORS[color] || COLORS.black;
  const { glow = true } = opts;
  const gid = "g" + Math.random().toString(36).slice(2, 8);
  return `
  <svg viewBox="0 0 200 240" xmlns="http://www.w3.org/2000/svg" class="earbud-svg">
    <defs>
      <linearGradient id="${gid}" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="${c.body}"/>
        <stop offset="100%" stop-color="${c.accent}"/>
      </linearGradient>
      ${glow ? `<filter id="glow-${gid}" x="-50%" y="-50%" width="200%" height="200%">
        <feGaussianBlur stdDeviation="6" result="b"/>
        <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
      </filter>` : ""}
    </defs>
    <g filter="url(#glow-${gid})" opacity="${glow ? 0.55 : 0}">
      <ellipse cx="100" cy="100" rx="60" ry="40" fill="#7c5cff" opacity="0.4"/>
    </g>
    <!-- stem -->
    <rect x="84" y="120" width="32" height="98" rx="16" fill="url(#${gid})"/>
    <rect x="84" y="120" width="10" height="98" rx="5" fill="#ffffff" opacity="0.08"/>
    <!-- bud body -->
    <ellipse cx="100" cy="96" rx="58" ry="48" fill="url(#${gid})"/>
    <ellipse cx="100" cy="96" rx="58" ry="48" fill="none" stroke="#ffffff" stroke-opacity="0.1" stroke-width="1.5"/>
    <!-- inner speaker detail -->
    <ellipse cx="100" cy="100" rx="22" ry="17" fill="${c.stem}" opacity="0.7"/>
    <circle cx="100" cy="100" r="7" fill="#000" opacity="0.4"/>
    <!-- highlight -->
    <ellipse cx="78" cy="78" rx="18" ry="11" fill="#ffffff" opacity="0.12"/>
    <!-- mic dot on stem -->
    <circle cx="100" cy="196" r="3" fill="#000" opacity="0.5"/>
  </svg>`;
}

/** SVG for the charging case (used on product stage / hero). */
function caseSVG(color = "black") {
  const c = COLORS[color] || COLORS.black;
  const gid = "cg" + Math.random().toString(36).slice(2, 8);
  return `
  <svg viewBox="0 0 260 200" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${c.body}"/>
        <stop offset="100%" stop-color="${c.stem}"/>
      </linearGradient>
    </defs>
    <rect x="30" y="40" width="200" height="130" rx="34" fill="url(#${gid})"/>
    <rect x="30" y="40" width="200" height="60" rx="34" fill="#ffffff" opacity="0.05"/>
    <rect x="30" y="40" width="200" height="130" rx="34" fill="none" stroke="#fff" stroke-opacity="0.1"/>
    <circle cx="130" cy="120" r="9" fill="#000" opacity="0.5"/>
    <rect x="118" y="60" width="24" height="4" rx="2" fill="#00d4ff" opacity="0.8"/>
    <ellipse cx="80" cy="70" rx="30" ry="10" fill="#fff" opacity="0.1"/>
  </svg>`;
}

/* ---------- Product catalog ----------
   Embedded catalog is the offline fallback. When the Python backend is
   running, Store.init() replaces this with data from /api/products. */
let PRODUCTS = [
  {
    id: "qp-pro",
    sku: "QP-PRO-2024",
    name: "QUICKPAPA Pro Wireless Earbuds",
    category: "Flagship",
    badge: "sale",
    price: 49.99,
    wasPrice: 79.99,
    rating: 4.8,
    reviews: 2847,
    colors: ["black", "white", "blue"],
    defaultColor: "black",
    short: "Hybrid active noise cancellation, 40h playtime, Bluetooth 5.3 and crystal-clear ENC calls.",
    description: "The QUICKPAPA Pro delivers studio-grade sound with hybrid active noise cancellation, a 40-hour total playtime with the wireless charging case, and Bluetooth 5.3 for an instant, rock-solid connection. Four ENC microphones isolate your voice so you are heard clearly on every call.",
    highlights: [
      "Hybrid Active Noise Cancellation (ANC) up to 35dB",
      "40h total playtime (8h earbuds + 32h case)",
      "Bluetooth 5.3 with multipoint pairing",
      "4-mic ENC crystal-clear calls",
      "Wireless Qi charging + USB-C fast charge",
      "IPX7 sweat & water resistant",
      "Custom 13mm dynamic drivers + deep bass",
      "Low-latency Game Mode (60ms)",
    ],
    specs: {
      "Driver": "13mm dynamic",
      "Bluetooth": "5.3",
      "Battery (buds)": "8 hours",
      "Battery (case)": "32 hours",
      "Charging": "USB-C + Qi wireless",
      "Water rating": "IPX7",
      "Microphones": "4 (ENC)",
      "Weight": "4.6g per bud",
      "Codecs": "SBC, AAC",
      "Warranty": "24 months",
    },
    inStock: true,
    featured: true,
  },
  {
    id: "qp-air",
    sku: "QP-AIR-2024",
    name: "QUICKPAPA Air Everyday Earbuds",
    category: "Everyday",
    badge: "new",
    price: 29.99,
    wasPrice: null,
    rating: 4.6,
    reviews: 942,
    colors: ["white", "black", "sand"],
    defaultColor: "white",
    short: "Lightweight comfort, 30h playtime and punchy bass for everyday listening.",
    description: "QUICKPAPA Air is the featherlight everyday companion. At just 3.8g per bud, they vanish in your ears while delivering 30 hours of total playtime and a rich, punchy signature tuned for podcasts, music and calls alike.",
    highlights: [
      "30h total playtime (6h + 24h case)",
      "Bluetooth 5.3 instant pairing",
      "Featherlight 3.8g ergonomic fit",
      "2-mic ENC calls",
      "USB-C charging",
      "IPX5 splash resistant",
      "Custom EQ via QUICKPAPA app",
    ],
    specs: {
      "Driver": "11mm dynamic",
      "Bluetooth": "5.3",
      "Battery (buds)": "6 hours",
      "Battery (case)": "24 hours",
      "Charging": "USB-C",
      "Water rating": "IPX5",
      "Microphones": "2 (ENC)",
      "Weight": "3.8g per bud",
      "Codecs": "SBC, AAC",
      "Warranty": "12 months",
    },
    inStock: true,
    featured: true,
  },
  {
    id: "qp-sport",
    sku: "QP-SPORT-2024",
    name: "QUICKPAPA Sport Pro Earbuds",
    category: "Sport",
    badge: "hot",
    price: 39.99,
    wasPrice: 54.99,
    rating: 4.7,
    reviews: 1186,
    colors: ["green", "black", "blue"],
    defaultColor: "green",
    short: "IPX8 waterproof, secure-fit hooks and 35h playtime built for the gym and trails.",
    description: "Built to move. QUICKPAPA Sport Pro features over-ear secure hooks, IPX8 waterproofing and a bass-forward sound signature that powers every rep, run and ride. 35 hours of total playtime keeps pace with your longest sessions.",
    highlights: [
      "IPX8 fully waterproof (swim-ready)",
      "Secure-fit over-ear hooks",
      "35h total playtime (7h + 28h case)",
      "Bass-boosted Sport EQ",
      "Bluetooth 5.3",
      "USB-C fast charge (10 min = 2h)",
      "Sweatproof 4-mic ENC",
    ],
    specs: {
      "Driver": "12mm dynamic",
      "Bluetooth": "5.3",
      "Battery (buds)": "7 hours",
      "Battery (case)": "28 hours",
      "Charging": "USB-C",
      "Water rating": "IPX8",
      "Microphones": "4 (ENC)",
      "Weight": "5.2g per bud",
      "Codecs": "SBC, AAC",
      "Warranty": "18 months",
    },
    inStock: true,
    featured: true,
  },
];

let REVIEWS = {
  "qp-pro": [
    { name: "Marcus T.", date: "May 2026", rating: 5, title: "Best earbuds I've owned", body: "The ANC is genuinely impressive for the price — it killed the engine drone on my commute. Call quality is crystal clear and the case lasts me almost a whole week." },
    { name: "Priya S.", date: "Apr 2026", rating: 5, title: "Incredible value", body: "I was skeptical at this price point but the sound is rich and the bass hits hard without being muddy. Multipoint pairing between my laptop and phone works flawlessly." },
    { name: "David L.", date: "Apr 2026", rating: 4, title: "Great, minor quirks", body: "Sound and comfort are top tier. Only wish the touch controls were a touch more responsive. Battery life is as advertised." },
  ],
  "qp-air": [
    { name: "Sara M.", date: "May 2026", rating: 5, title: "So comfortable", body: "I forget I'm wearing them. Perfect for podcasts and calls all day. The price is unbeatable." },
    { name: "Ken W.", date: "Mar 2026", rating: 4, title: "Solid everyday buds", body: "Lightweight and reliable. No ANC but the passive isolation is decent." },
  ],
  "qp-sport": [
    { name: "Aisha R.", date: "May 2026", rating: 5, title: "Survived my marathon", body: "Ran 26 miles in the rain and they never budged. The hooks are comfy and the bass keeps me going." },
    { name: "Tom B.", date: "Apr 2026", rating: 5, title: "Gym perfection", body: "Sweat-proof claim is real. Sound is energetic and the fit is locked in." },
  ],
};

/* ---------- Promo codes ---------- */
const PROMOS = {
  WELCOME10: { type: "percent", value: 10, label: "10% off welcome discount" },
  FREE_SHIP: { type: "shipping", value: 0, label: "Free shipping" },
  SAVE20: { type: "percent", value: 20, label: "20% off — limited" },
};

/* ---------- Store API (localStorage cart) ---------- */
const Store = (function () {
  const KEY = "quickpapa_cart_v1";

  function load() {
    try { return JSON.parse(localStorage.getItem(KEY)) || []; }
    catch { return []; }
  }
  function save(cart) {
    try { localStorage.setItem(KEY, JSON.stringify(cart)); } catch {}
    window.dispatchEvent(new CustomEvent("cart:change"));
  }

  function find(productId, color) {
    const c = load();
    return c.find((i) => i.id === productId && i.color === color);
  }

  return {
    PRODUCTS,
    PROMOS,
    REVIEWS,
    COLORS,
    earbudSVG,
    caseSVG,
    API: "/api",
    api: false,

    /** Load catalog from the Python backend; fall back to embedded data. */
    async init() {
      try {
        const res = await fetch(this.API + "/products");
        if (res.ok) {
          const data = await res.json();
          if (Array.isArray(data) && data.length) {
            PRODUCTS = data;
            this.PRODUCTS = data;
            this.api = true;
          }
        }
      } catch (e) {
        /* backend not running — keep embedded catalog */
      }
      return PRODUCTS;
    },

    /** Fetch reviews for a product from the backend. */
    async fetchReviews(productId) {
      try {
        const res = await fetch(this.API + "/products/" + productId + "/reviews");
        if (res.ok) return await res.json();
      } catch (e) {}
      return REVIEWS[productId] || [];
    },

    /** Validate a promo code against the backend. Returns null if invalid. */
    async validatePromo(code) {
      try {
        const res = await fetch(this.API + "/promo/" + encodeURIComponent(code));
        if (res.ok) return await res.json();
      } catch (e) {}
      return null;
    },

    /** Submit an order to the backend. Returns the server-confirmed order. */
    async submitOrder(payload) {
      const res = await fetch(this.API + "/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error || "Order failed");
      return data.order;
    },

    get(productId) {
      return PRODUCTS.find((p) => p.id === productId);
    },

    cart() { return load(); },

    count() {
      return load().reduce((n, i) => n + i.qty, 0);
    },

    subtotal() {
      return load().reduce((s, i) => {
        const p = this.get(i.id);
        return s + (p ? p.price * i.qty : 0);
      }, 0);
    },

    add(productId, color, qty = 1) {
      const cart = load();
      const existing = cart.find((i) => i.id === productId && i.color === color);
      if (existing) existing.qty += qty;
      else cart.push({ id: productId, color, qty });
      save(cart);
    },

    setQty(productId, color, qty) {
      const cart = load();
      const item = cart.find((i) => i.id === productId && i.color === color);
      if (item) {
        item.qty = Math.max(0, qty);
        if (item.qty === 0) {
          const idx = cart.indexOf(item);
          cart.splice(idx, 1);
        }
      }
      save(cart);
    },

    remove(productId, color) {
      const cart = load().filter((i) => !(i.id === productId && i.color === color));
      save(cart);
    },

    clear() {
      save([]);
    },

    applyPromo(code) {
      code = (code || "").trim().toUpperCase();
      if (PROMOS[code]) {
        localStorage.setItem("quickpapa_promo", code);
        window.dispatchEvent(new CustomEvent("cart:change"));
        return PROMOS[code];
      }
      localStorage.removeItem("quickpapa_promo");
      return null;
    },

    activePromo() {
      return localStorage.getItem("quickpapa_promo") || null;
    },

    totals() {
      const subtotal = this.subtotal();
      const promoCode = this.activePromo();
      const promo = promoCode ? PROMOS[promoCode] : null;
      let discount = 0;
      let shipping = subtotal > 0 ? (subtotal >= 75 ? 0 : 6.95) : 0;
      let taxRate = 0.08;

      if (promo) {
        if (promo.type === "percent") discount = +(subtotal * promo.value / 100).toFixed(2);
        if (promo.type === "shipping") shipping = 0;
      }
      const taxable = Math.max(0, subtotal - discount);
      const tax = +(taxable * taxRate).toFixed(2);
      const total = +(taxable + shipping + tax).toFixed(2);
      return { subtotal: +subtotal.toFixed(2), discount, shipping, tax, total, promo: promoCode };
    },

    format(n) {
      return "$" + Number(n).toFixed(2);
    },
  };
})();

window.Store = Store;