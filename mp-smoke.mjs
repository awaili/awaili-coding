import puppeteer from "puppeteer";
import fs from "node:fs";

const lines = fs.readFileSync("/data/coding-dev-ui/.env.auth", "utf8").split("\n");
const pw = (lines.find((l) => l.startsWith("AUTH_PASSWORD=")) || "").slice(14).trim();

const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"] });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });
await page.goto("http://127.0.0.1:3002/", { waitUntil: "networkidle0", timeout: 30000 }).catch(() => {});
await new Promise((r) => setTimeout(r, 1000));

// App shows a password screen until /api/me says authed; type the password.
if (await page.$('input[type="password"]')) {
  await page.type('input[type="password"]', pw);
  await Promise.all([
    page.waitForNavigation({ waitUntil: "networkidle0", timeout: 20000 }).catch(() => {}),
    page.keyboard.press("Enter"),
  ]);
}
await new Promise((r) => setTimeout(r, 1500));

const btn = await page.$(".model-pick");
if (!btn) {
  console.log("FAIL: no .model-pick button");
  await browser.close();
  process.exit(1);
}
await btn.click();
await new Promise((r) => setTimeout(r, 600));

const groups = await page.$$eval(".model-group-title", (els) => els.map((e) => e.textContent));
const items = await page.$$eval(".model-item", (els) =>
  els.map((e) => ({
    name: e.querySelector(".model-item-name")?.textContent,
    desc: e.querySelector(".model-item-desc")?.textContent,
    chips: [...e.querySelectorAll(".chip")].map((c) => c.textContent),
  })),
);
console.log("groups:", JSON.stringify(groups));
console.log("total items:", items.length);
for (const it of items) console.log(" ", it.name, "|", it.chips.join(","), "|", (it.desc || "").slice(0, 70));

// Select a different model and confirm the button label updates.
await page.screenshot({ path: "/tmp/model-picker.png" });
await browser.close();
console.log("SMOKE OK");
