"""
QUICKPAPA backend — Flask API + static frontend serving.

Run:
    pip install -r requirements.txt
    python app.py
Then open http://127.0.0.1:5000

Endpoints:
    GET  /api/products            list catalog (?category=... optional)
    GET  /api/products/<id>         one product
    GET  /api/products/<id>/reviews
    GET  /api/promo/<code>          validate a promo code
    POST /api/orders               place an order (persists to SQLite)
    GET  /api/orders/<id>           look up an order
    POST /api/newsletter            email signup
    GET  /api/health                pool + db health check
"""

import json
import os
import random
import threading

from flask import Flask, request, jsonify, send_from_directory, abort

import db
from db import get_pool, row_to_product

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

app = Flask(__name__, static_folder=None)
app.config["JSON_SORT_KEYS"] = False

# Initialise schema + seed data once at import.
db.init()


# ------------------------------------------------------------------ API

@app.get("/api/health")
def health():
    try:
        c = get_pool().query_one("SELECT COUNT(*) AS c FROM products")
        return jsonify(ok=True, products=c["c"], db=db.DB_PATH)
    except Exception as e:
        return jsonify(ok=False, error=str(e)), 500


@app.get("/api/products")
def list_products():
    category = request.args.get("category")
    if category and category.lower() != "all":
        rows = get_pool().query(
            "SELECT * FROM products WHERE category = ? ORDER BY featured DESC, price ASC",
            (category,),
        )
    else:
        rows = get_pool().query("SELECT * FROM products ORDER BY featured DESC, price ASC")
    return jsonify([row_to_product(r) for r in rows])


@app.get("/api/products/<pid>")
def get_product(pid):
    r = get_pool().query_one("SELECT * FROM products WHERE id = ?", (pid,))
    if not r:
        return jsonify(error="Product not found"), 404
    return jsonify(row_to_product(r))


@app.get("/api/products/<pid>/reviews")
def product_reviews(pid):
    if not get_pool().query_one("SELECT 1 FROM products WHERE id = ?", (pid,)):
        return jsonify(error="Product not found"), 404
    rows = get_pool().query(
        "SELECT name, date, rating, title, body FROM reviews WHERE product_id = ? ORDER BY id DESC",
        (pid,),
    )
    return jsonify(rows)


@app.get("/api/promo/<code>")
def get_promo(code):
    code = (code or "").strip().upper()
    r = get_pool().query_one(
        "SELECT code, type, value, label, active FROM promos WHERE code = ?", (code,)
    )
    if not r or not r["active"]:
        return jsonify(valid=False), 404
    return jsonify(valid=True, type=r["type"], value=r["value"], label=r["label"])


@app.post("/api/newsletter")
def newsletter():
    data = request.get_json(silent=True) or {}
    email = (data.get("email") or "").strip().lower()
    if "@" not in email or "." not in email.split("@")[-1]:
        return jsonify(ok=False, error="Invalid email"), 400
    try:
        get_pool().execute("INSERT OR IGNORE INTO newsletter (email) VALUES (?)", (email,))
    except Exception as e:
        return jsonify(ok=False, error=str(e)), 500
    return jsonify(ok=True, message="Subscribed")


@app.post("/api/orders")
def place_order():
    data = request.get_json(silent=True) or {}
    required = ["email", "firstName", "lastName", "address", "city", "state", "zip", "phone", "items"]
    missing = [f for f in required if not data.get(f)]
    if missing:
        return jsonify(ok=False, error="Missing fields", fields=missing), 400
    if not isinstance(data.get("items"), list) or not data["items"]:
        return jsonify(ok=False, error="Cart is empty"), 400

    pool = get_pool()
    order_id = "QP" + str(random.randint(100000, 899999))

    # Recompute totals server-side from the DB so a tampered client can't set prices.
    subtotal = 0.0
    items_out = []
    for it in data["items"]:
        p = pool.query_one("SELECT * FROM products WHERE id = ?", (it.get("id"),))
        if not p:
            return jsonify(ok=False, error=f"Unknown product {it.get('id')}"), 400
        qty = max(1, int(it.get("qty", 1)))
        line = round(p["price"] * qty, 2)
        subtotal += line
        items_out.append({
            "product_id": p["id"], "product_name": p["name"],
            "color": it.get("color", p["default_color"]),
            "qty": qty, "unit_price": p["price"], "line_total": line,
        })
    subtotal = round(subtotal, 2)

    # Apply promo from the DB.
    discount = 0.0
    shipping = 0.0 if subtotal >= 75 else 6.95
    promo_code = (data.get("promo") or "").strip().upper()
    if promo_code:
        promo = pool.query_one("SELECT type, value, active FROM promos WHERE code = ?", (promo_code,))
        if promo and promo["active"]:
            if promo["type"] == "percent":
                discount = round(subtotal * promo["value"] / 100, 2)
            elif promo["type"] == "shipping":
                shipping = 0.0
        else:
            promo_code = ""

    taxable = max(0.0, subtotal - discount)
    tax = round(taxable * 0.08, 2)
    total = round(taxable + shipping + tax, 2)

    cust = data
    try:
        pool.execute(
            """INSERT INTO orders
               (id, email, first_name, last_name, address, apt, city, state, zip,
                country, phone, payment_method, subtotal, discount, shipping, tax,
                total, promo_code)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (order_id, cust["email"], cust["firstName"], cust["lastName"],
             cust["address"], cust.get("apt", ""), cust["city"], cust["state"],
             cust["zip"], cust.get("country", "United States"), cust["phone"],
             cust.get("payment", "card"), subtotal, discount, shipping, tax, total,
             promo_code),
        )
        pool.executemany(
            """INSERT INTO order_items
               (order_id, product_id, product_name, color, qty, unit_price, line_total)
               VALUES (?,?,?,?,?,?,?)""",
            [(order_id, i["product_id"], i["product_name"], i["color"],
              i["qty"], i["unit_price"], i["line_total"]) for i in items_out],
        )
        # Upsert customer by email.
        pool.execute(
            "INSERT OR IGNORE INTO customers (email, first_name, last_name) VALUES (?,?,?)",
            (cust["email"], cust["firstName"], cust["lastName"]),
        )
    except Exception as e:
        return jsonify(ok=False, error=str(e)), 500

    return jsonify(ok=True, order=dict(
        id=order_id, email=cust["email"], subtotal=subtotal, discount=discount,
        shipping=shipping, tax=tax, total=total, promo=promo_code or None,
        items=items_out,
    ))


@app.get("/api/orders/<order_id>")
def get_order(order_id):
    o = get_pool().query_one("SELECT * FROM orders WHERE id = ?", (order_id,))
    if not o:
        return jsonify(error="Order not found"), 404
    items = get_pool().query(
        "SELECT product_id, product_name, color, qty, unit_price, line_total FROM order_items WHERE order_id = ?",
        (order_id,),
    )
    o.pop("email", None)  # don't leak the buyer's email to anonymous lookups
    return jsonify(order=o, items=items)


# ------------------------------------------------------------------ Static

VALID_PAGES = {"index.html", "product.html", "cart.html", "checkout.html",
               "success.html", "about.html", "contact.html"}
STATIC_DIRS = {"css", "js", "img", "assets", "fonts"}


@app.get("/")
def root():
    return send_from_directory(BASE_DIR, "index.html")


@app.get("/<path:path>")
def static_proxy(path):
    # API routes handled above; never fall through to file serving.
    if path.startswith("api/"):
        abort(404)
    # Sub-directory assets (css/, js/, ...).
    first = path.split("/", 1)[0]
    if first in STATIC_DIRS:
        return send_from_directory(BASE_DIR, path)
    # HTML pages by name.
    if path in VALID_PAGES:
        return send_from_directory(BASE_DIR, path)
    # Favicon / well-known.
    if path in {"favicon.ico", "robots.txt", "sitemap.xml"}:
        full = os.path.join(BASE_DIR, path)
        if os.path.isfile(full):
            return send_from_directory(BASE_DIR, path)
        abort(404)
    # Tolerate pretty URLs like /product -> product.html
    pretty = path + ".html"
    if pretty in VALID_PAGES:
        return send_from_directory(BASE_DIR, pretty)
    abort(404)


if __name__ == "__main__":
    # threaded=True so the connection pool is actually exercised.
    app.run(host="127.0.0.1", port=5000, threaded=True, debug=False)