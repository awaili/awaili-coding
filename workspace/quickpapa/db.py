"""
Schema + seed data for the QUICKPAPA store.

Tables:
  products       catalog (id, name, price, colors, specs ... — JSON columns for lists/dicts)
  reviews        customer reviews per product
  promos         promo codes (percent / shipping)
  customers      deduped by email
  orders         checkout submissions
  order_items    line items per order
  newsletter     email signups
"""

import json
import os
from pool import SQLitePool

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "quickpapa.db")

SCHEMA = """
CREATE TABLE IF NOT EXISTS products (
    id            TEXT PRIMARY KEY,
    sku           TEXT UNIQUE,
    name          TEXT NOT NULL,
    category      TEXT,
    badge         TEXT,
    price         REAL NOT NULL,
    was_price     REAL,
    rating        REAL,
    reviews_count INTEGER,
    colors        TEXT,          -- JSON array
    default_color TEXT,
    short         TEXT,
    description   TEXT,
    highlights    TEXT,          -- JSON array
    specs         TEXT,          -- JSON object
    in_stock      INTEGER DEFAULT 1,
    featured      INTEGER DEFAULT 0,
    created_at    TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS reviews (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    name       TEXT,
    date       TEXT,
    rating     INTEGER,
    title      TEXT,
    body       TEXT,
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS promos (
    code   TEXT PRIMARY KEY,
    type   TEXT,          -- 'percent' | 'shipping'
    value  REAL,
    label  TEXT,
    active INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS customers (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    email      TEXT UNIQUE,
    first_name TEXT,
    last_name  TEXT,
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS orders (
    id            TEXT PRIMARY KEY,
    email         TEXT,
    first_name    TEXT,
    last_name     TEXT,
    address       TEXT,
    apt           TEXT,
    city          TEXT,
    state         TEXT,
    zip           TEXT,
    country       TEXT,
    phone         TEXT,
    payment_method TEXT,
    subtotal      REAL,
    discount      REAL,
    shipping      REAL,
    tax           REAL,
    total         REAL,
    promo_code    TEXT,
    status        TEXT DEFAULT 'confirmed',
    created_at    TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS order_items (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id     TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    product_id   TEXT,
    product_name TEXT,
    color        TEXT,
    qty          INTEGER,
    unit_price   REAL,
    line_total   REAL
);

CREATE TABLE IF NOT EXISTS newsletter (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    email      TEXT UNIQUE,
    created_at TEXT DEFAULT (datetime('now'))
);
"""

PRODUCTS = [
    {
        "id": "qp-pro", "sku": "QP-PRO-2024",
        "name": "QUICKPAPA Pro Wireless Earbuds", "category": "Flagship", "badge": "sale",
        "price": 49.99, "was_price": 79.99, "rating": 4.8, "reviews_count": 2847,
        "colors": ["black", "white", "blue"], "default_color": "black",
        "short": "Hybrid active noise cancellation, 40h playtime, Bluetooth 5.3 and crystal-clear ENC calls.",
        "description": "The QUICKPAPA Pro delivers studio-grade sound with hybrid active noise cancellation, a 40-hour total playtime with the wireless charging case, and Bluetooth 5.3 for an instant, rock-solid connection. Four ENC microphones isolate your voice so you are heard clearly on every call.",
        "highlights": [
            "Hybrid Active Noise Cancellation (ANC) up to 35dB",
            "40h total playtime (8h earbuds + 32h case)",
            "Bluetooth 5.3 with multipoint pairing",
            "4-mic ENC crystal-clear calls",
            "Wireless Qi charging + USB-C fast charge",
            "IPX7 sweat & water resistant",
            "Custom 13mm dynamic drivers + deep bass",
            "Low-latency Game Mode (60ms)",
        ],
        "specs": {
            "Driver": "13mm dynamic", "Bluetooth": "5.3",
            "Battery (buds)": "8 hours", "Battery (case)": "32 hours",
            "Charging": "USB-C + Qi wireless", "Water rating": "IPX7",
            "Microphones": "4 (ENC)", "Weight": "4.6g per bud",
            "Codecs": "SBC, AAC", "Warranty": "24 months",
        },
        "in_stock": 1, "featured": 1,
    },
    {
        "id": "qp-air", "sku": "QP-AIR-2024",
        "name": "QUICKPAPA Air Everyday Earbuds", "category": "Everyday", "badge": "new",
        "price": 29.99, "was_price": None, "rating": 4.6, "reviews_count": 942,
        "colors": ["white", "black", "sand"], "default_color": "white",
        "short": "Lightweight comfort, 30h playtime and punchy bass for everyday listening.",
        "description": "QUICKPAPA Air is the featherlight everyday companion. At just 3.8g per bud, they vanish in your ears while delivering 30 hours of total playtime and a rich, punchy signature tuned for podcasts, music and calls alike.",
        "highlights": [
            "30h total playtime (6h + 24h case)",
            "Bluetooth 5.3 instant pairing",
            "Featherlight 3.8g ergonomic fit",
            "2-mic ENC calls",
            "USB-C charging",
            "IPX5 splash resistant",
            "Custom EQ via QUICKPAPA app",
        ],
        "specs": {
            "Driver": "11mm dynamic", "Bluetooth": "5.3",
            "Battery (buds)": "6 hours", "Battery (case)": "24 hours",
            "Charging": "USB-C", "Water rating": "IPX5",
            "Microphones": "2 (ENC)", "Weight": "3.8g per bud",
            "Codecs": "SBC, AAC", "Warranty": "12 months",
        },
        "in_stock": 1, "featured": 1,
    },
    {
        "id": "qp-sport", "sku": "QP-SPORT-2024",
        "name": "QUICKPAPA Sport Pro Earbuds", "category": "Sport", "badge": "hot",
        "price": 39.99, "was_price": 54.99, "rating": 4.7, "reviews_count": 1186,
        "colors": ["green", "black", "blue"], "default_color": "green",
        "short": "IPX8 waterproof, secure-fit hooks and 35h playtime built for the gym and trails.",
        "description": "Built to move. QUICKPAPA Sport Pro features over-ear secure hooks, IPX8 waterproofing and a bass-forward sound signature that powers every rep, run and ride. 35 hours of total playtime keeps pace with your longest sessions.",
        "highlights": [
            "IPX8 fully waterproof (swim-ready)",
            "Secure-fit over-ear hooks",
            "35h total playtime (7h + 28h case)",
            "Bass-boosted Sport EQ",
            "Bluetooth 5.3",
            "USB-C fast charge (10 min = 2h)",
            "Sweatproof 4-mic ENC",
        ],
        "specs": {
            "Driver": "12mm dynamic", "Bluetooth": "5.3",
            "Battery (buds)": "7 hours", "Battery (case)": "28 hours",
            "Charging": "USB-C", "Water rating": "IPX8",
            "Microphones": "4 (ENC)", "Weight": "5.2g per bud",
            "Codecs": "SBC, AAC", "Warranty": "18 months",
        },
        "in_stock": 1, "featured": 1,
    },
]

REVIEWS = {
    "qp-pro": [
        {"name": "Marcus T.", "date": "May 2026", "rating": 5, "title": "Best earbuds I've owned", "body": "The ANC is genuinely impressive for the price — it killed the engine drone on my commute. Call quality is crystal clear and the case lasts me almost a whole week."},
        {"name": "Priya S.", "date": "Apr 2026", "rating": 5, "title": "Incredible value", "body": "I was skeptical at this price point but the sound is rich and the bass hits hard without being muddy. Multipoint pairing between my laptop and phone works flawlessly."},
        {"name": "David L.", "date": "Apr 2026", "rating": 4, "title": "Great, minor quirks", "body": "Sound and comfort are top tier. Only wish the touch controls were a touch more responsive. Battery life is as advertised."},
    ],
    "qp-air": [
        {"name": "Sara M.", "date": "May 2026", "rating": 5, "title": "So comfortable", "body": "I forget I'm wearing them. Perfect for podcasts and calls all day. The price is unbeatable."},
        {"name": "Ken W.", "date": "Mar 2026", "rating": 4, "title": "Solid everyday buds", "body": "Lightweight and reliable. No ANC but the passive isolation is decent."},
    ],
    "qp-sport": [
        {"name": "Aisha R.", "date": "May 2026", "rating": 5, "title": "Survived my marathon", "body": "Ran 26 miles in the rain and they never budged. The hooks are comfy and the bass keeps me going."},
        {"name": "Tom B.", "date": "Apr 2026", "rating": 5, "title": "Gym perfection", "body": "Sweat-proof claim is real. Sound is energetic and the fit is locked in."},
    ],
}

PROMOS = [
    {"code": "WELCOME10", "type": "percent", "value": 10, "label": "10% off welcome discount", "active": 1},
    {"code": "FREE_SHIP", "type": "shipping", "value": 0, "label": "Free shipping", "active": 1},
    {"code": "SAVE20", "type": "percent", "value": 20, "label": "20% off — limited", "active": 1},
]


# Module-level singleton pool, lazily created.
_pool = None


def get_pool():
    global _pool
    if _pool is None:
        _pool = SQLitePool(DB_PATH, size=8, init_sql=SCHEMA)
    return _pool


def row_to_product(r):
    """Normalize a DB row into the API product shape (parse JSON columns)."""
    if not r:
        return None
    return {
        "id": r["id"],
        "sku": r["sku"],
        "name": r["name"],
        "category": r["category"],
        "badge": r["badge"],
        "price": r["price"],
        "wasPrice": r["was_price"],
        "rating": r["rating"],
        "reviews": r["reviews_count"],
        "colors": json.loads(r["colors"]) if r["colors"] else [],
        "defaultColor": r["default_color"],
        "short": r["short"],
        "description": r["description"],
        "highlights": json.loads(r["highlights"]) if r["highlights"] else [],
        "specs": json.loads(r["specs"]) if r["specs"] else {},
        "inStock": bool(r["in_stock"]),
        "featured": bool(r["featured"]),
    }


def seed():
    """Insert seed products/reviews/promos if the tables are empty."""
    pool = get_pool()
    count = pool.query_one("SELECT COUNT(*) AS c FROM products")["c"]
    if count == 0:
        for p in PRODUCTS:
            pool.execute(
                """INSERT INTO products
                   (id, sku, name, category, badge, price, was_price, rating,
                    reviews_count, colors, default_color, short, description,
                    highlights, specs, in_stock, featured)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (p["id"], p["sku"], p["name"], p["category"], p["badge"], p["price"],
                 p["was_price"], p["rating"], p["reviews_count"],
                 json.dumps(p["colors"]), p["default_color"], p["short"],
                 p["description"], json.dumps(p["highlights"]),
                 json.dumps(p["specs"]), p["in_stock"], p["featured"]),
            )
    promo_count = pool.query_one("SELECT COUNT(*) AS c FROM promos")["c"]
    if promo_count == 0:
        for m in PROMOS:
            pool.execute(
                "INSERT INTO promos (code, type, value, label, active) VALUES (?,?,?,?,?)",
                (m["code"], m["type"], m["value"], m["label"], m["active"]),
            )
    rev_count = pool.query_one("SELECT COUNT(*) AS c FROM reviews")["c"]
    if rev_count == 0:
        for pid, items in REVIEWS.items():
            for it in items:
                pool.execute(
                    "INSERT INTO reviews (product_id, name, date, rating, title, body) VALUES (?,?,?,?,?,?)",
                    (pid, it["name"], it["date"], it["rating"], it["title"], it["body"]),
                )


def init():
    """Create schema + seed. Call once at startup."""
    get_pool()
    seed()


def close():
    global _pool
    if _pool:
        _pool.close_all()
        _pool = None