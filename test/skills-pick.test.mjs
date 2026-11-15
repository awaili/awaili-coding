// Regression net for skills.js pickSkill() — the matcher that decides whether
// a user's message gets a SKILL.md prepended to it (util.js injectSkill).
//
// A false injection is expensive: the model is handed a whole deployment
// runbook in front of an unrelated question and has to notice it does not
// apply. That happened repeatedly with a WeChat-bot publishing skill, which
// matched "deploy all to production", "have you restarted the service?" and
// even "check the error on coding.zaymuc.com" — because the skill's
// description names its URL and source path, and because ops vocabulary
// (deploy/restart/production/service) is shared by every deployment skill.
// A missed injection is cheap by comparison: the user types /name.
//
// The fixtures here are synthetic so the suite does not depend on whatever
// skills happen to be installed on the box.
//
// Run: npm test
import { test, before } from "node:test";
import assert from "node:assert/strict";

let pickSkill;

before(async () => {
  ({ pickSkill } = await import("../server/skills.js"));
});

const skill = (name, description, scope = "global") => ({
  name,
  description,
  whenToUse: "",
  body: "# " + name + "\n\nrunbook body",
  scope,
  disableModelInvocation: false,
});

// Three deployment-flavoured skills that share ops vocabulary but differ in
// subject — the configuration that used to misfire.
const SKILLS = [
  skill(
    "wechat-bot-deploy",
    "Publish the WeChat AI Bot to its live site (https://wechat.quickpapa.com). Source lives at " +
      "/data/coding-dev-ui/workspace/wechat; the live copy at /data/wechat-bot runs behind nginx. " +
      "One tenant = one WeChat login = one Core process (wechat-core@main.service). Use when the user asks to " +
      "部署/发布/上线 this bot, restart core or edge after edits, 加租户/新租户, publish frontend changes. " +
      "微信 never forces a re-scan.",
    "workspace",
  ),
  skill(
    "deploy-site",
    "Stand up a new HTTPS website on this box end-to-end: add the DNS subdomain (DNSPod A record), deploy " +
      "the site behind nginx, and issue a TLS certificate. Use when the user asks to 申请域名/子域名, 申请证书, " +
      "给某域名配 HTTPS, publish a static site, point a domain at this box.",
  ),
  skill(
    "db-server",
    "登录和管理腾讯云 Lighthouse DB 服务器 (CentOS Stream 9 + MariaDB)。Use when the user asks to 登录数据库机器, " +
      "连一下 DB, 查/备份/恢复 MariaDB 数据库, 重装/重启 DB 机器.",
  ),
];

const pick = (msg) => pickSkill(msg, SKILLS)?.name ?? null;

test("a skill matches on its subject, in English or Chinese", () => {
  assert.equal(pick("publish the wechat bot frontend changes to live"), "wechat-bot-deploy");
  assert.equal(pick("部署 wechat-bot 到线上"), "wechat-bot-deploy");
  // CJK used to tokenize to nothing at all, so this matched no skill.
  assert.equal(pick("加个租户 alice 到微信机器人"), "wechat-bot-deploy");
  assert.equal(pick("帮我申请一个新域名 foo.example.com 并配置 https 证书"), "deploy-site");
  assert.equal(pick("连一下 DB，查一下 MariaDB 数据库里的表"), "db-server");
});

test("shared ops vocabulary alone never injects a skill", () => {
  for (const msg of [
    "deploy all to production",
    "have you applied the changes to production and dev both, and restarted the service?",
    "restart the coding-ui service please",
    "重启一下服务",
    "commit code to github",
  ]) {
    assert.equal(pick(msg), null, `should not match: ${msg}`);
  }
});

test("a skill's own URL and source path are not matchable keywords", () => {
  // "coding.zaymuc.com" overlapped /data/coding-dev-ui/... in the skill's
  // description, which was enough to inject the WeChat runbook into a
  // debugging question.
  assert.equal(pick("我刚才在 coding.zaymuc.com 看到一个错误，你复盘一下"), null);
  // A host the USER types is still tokenized (only the skill's own URLs are
  // dropped) — but one subject word is not two, so this stays below the bar...
  assert.equal(pick("check https://wechat.quickpapa.com is up"), null);
  // ...and reaches it as soon as the message names the subject twice over.
  assert.equal(pick("is the wechat bot at https://wechat.quickpapa.com up?"), "wechat-bot-deploy");
});

test("naming a skill explicitly still matches it", () => {
  assert.equal(pick("solve the problem that the keyword match wechat-bot"), "wechat-bot-deploy");
});

test("slash commands, empty input and body-less skills are skipped", () => {
  assert.equal(pick("/wechat-bot-deploy"), null, "the CLI handles slash commands");
  assert.equal(pick("   "), null);
  assert.equal(pickSkill("publish the wechat bot to live", [{ ...SKILLS[0], body: "" }]), null);
  assert.equal(pickSkill("publish the wechat bot to live", [{ ...SKILLS[0], disableModelInvocation: true }]), null);
});

test("one subject word is not enough — two significant hits are required", () => {
  // "bot" alone (ops words stripped) leaves a single keyword.
  assert.equal(pick("restart the bot"), null);
});
