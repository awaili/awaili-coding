# QUICKPAPA — Earbuds Ecommerce

A full ecommerce storefront for the **QUICKPAPA** wireless earbuds brand: a modern,
responsive frontend plus a Python/Flask backend with SQLite and a connection pool.

> Built as a demo. No real payments are processed; checkout persists orders to
> the database and shows a confirmation page.

## Features

**Storefront (HTML/CSS/JS)**
- Home, shop/catalog, product detail, cart, checkout, order confirmation, about, contact
- 3 products: QUICKPAPA **Pro**, **Air**, **Sport Pro** — each with color variants, gallery, specs, reviews, tabs
- Cart persisted in `localStorage` with quantity controls + promo codes
- Checkout with form validation and three payment options (card / PayPal / Apple Pay)
- Fully responsive, dark UI with inline-SVG earbud art (no external image dependencies)
- Works fully offline (embedded catalog fallback) **or** against the live backend

**Backend (Python + Flask + SQLite)**
- SQLite database with a thread-safe **connection pool** (`pool.py`)
- Schema + seed data for products, reviews, promo codes, orders, customers (`db.py`)
- REST API: products, product reviews, promo validation, order placement, newsletter, health
- Server-side order total recomputation (prices pulled from the DB, not trusted from the client)
- Serves the static frontend alongside the API from one process

## Project layout

```
quickpapa/
├── index.html, product.html, cart.html, checkout.html, success.html,
│   about.html, contact.html        # frontend pages
├── css/style.css                   # design system
├── js/store.js                     # catalog + cart + API client
├── js/main.js                      # UI controller, rendering, validation
├── app.py                          # Flask app (API + static serving)
├── db.py                           # SQLite schema + seed data
├── pool.py                         # SQLite connection pool
├── requirements.txt                # Flask
└── quickpapa.db                    # SQLite database (auto-created)
```

## Run it

```bash
cd quickpapa
python -m pip install -r requirements.txt
python app.py
```

Then open <http://127.0.0.1:5000>.

The database `quickpapa.db` is created and seeded on first run.

## API reference

| Method | Endpoint                        | Description                                   |
|--------|---------------------------------|-----------------------------------------------|
| GET    | `/api/health`                   | Pool/db health + product count                |
| GET    | `/api/products?category=`       | List catalog (optional category filter)       |
| GET    | `/api/products/<id>`            | One product                                   |
| GET    | `/api/products/<id>/reviews`    | Reviews for a product                         |
| GET    | `/api/promo/<code>`            | Validate a promo code                         |
| POST   | `/api/orders`                   | Place an order (totals recomputed server-side)|
| GET    | `/api/orders/<id>`              | Look up an order                              |
| POST   | `/api/newsletter`               | Email signup                                   |

### Place an order — `POST /api/orders`

```json
{
  "email": "you@example.com",
  "firstName": "Ada", "lastName": "Lovelace",
  "address": "1 Main St", "apt": "",
  "city": "San Jose", "state": "CA", "zip": "95112",
  "country": "United States", "phone": "555-0100",
  "payment": "card", "promo": "WELCOME10",
  "items": [ { "id": "qp-pro", "color": "black", "qty": 1 } ]
}
```

Returns `{ "ok": true, "order": { id, subtotal, discount, shipping, tax, total, items, ... } }`.

## Promo codes (seeded)

| Code        | Effect            |
|-------------|-------------------|
| `WELCOME10` | 10% off           |
| `SAVE20`    | 20% off           |
| `FREE_SHIP` | Free shipping     |

## Notes

- The connection pool (`pool.py`) keeps a small queue of `sqlite3` connections
  opened with WAL mode and a busy timeout, so Flask's threaded request handling
  can borrow/return connections safely.
- The frontend gracefully falls back to an embedded product catalog when the
  backend is unavailable, so the site is browsable even without running `app.py`.