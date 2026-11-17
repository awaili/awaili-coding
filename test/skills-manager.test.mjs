// Regression net for the skills-manager additions in server/skills.js:
// setModelInvocation (the auto-injection toggle = disable-model-invocation
// frontmatter surgery) and rankSkills (the scoring pass behind pickSkill and
// the POST /skills/test trigger preview).
//
// Both work on caller-provided inputs only (a skills dir / a skill array), so
// no HOME or WORKSPACE_ROOT juggling is needed here.
//
// Run: npm test
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let skills;
let dir;

const MD = (frontmatter) => `---\n${frontmatter}---\n# skill\n\nbody\n`;

before(async () => {
  skills = await import("../server/skills.js");
});

after(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

async function makeSkill(name, frontmatter = "") {
  dir ??= await mkdtemp(join(tmpdir(), "coding-ui-skills-"));
  const target = join(dir, name);
  await mkdir(target, { recursive: true });
  await writeFile(join(target, "SKILL.md"), MD(frontmatter), "utf8");
  return target;
}

// --- setModelInvocation (the auto-injection toggle) -------------------------

test("disabling inserts disable-model-invocation right after the opening fence", async () => {
  const name = "plain-skill";
  await makeSkill(name, "name: plain-skill\ndescription: does things\n");
  await skills.setModelInvocation(dir, name, true);
  const raw = await readFile(join(dir, name, "SKILL.md"), "utf8");
  assert.match(raw, /^---\ndisable-model-invocation: true\n/);
  // The rest of the frontmatter survives untouched.
  assert.match(raw, /description: does things/);
  // Toggling back removes the line entirely.
  await skills.setModelInvocation(dir, name, false);
  const raw2 = await readFile(join(dir, name, "SKILL.md"), "utf8");
  assert.ok(!/disable-model-invocation/.test(raw2));
  assert.match(raw2, /description: does things/);
});

test("disabling updates an existing false/true line instead of duplicating it", async () => {
  const name = "explicit-skill";
  await makeSkill(name, "name: explicit-skill\ndisable-model-invocation: false\ndescription: x\n");
  await skills.setModelInvocation(dir, name, true);
  const raw = await readFile(join(dir, name, "SKILL.md"), "utf8");
  const hits = raw.match(/^disable-model-invocation:.*$/gm) || [];
  assert.equal(hits.length, 1, "must not duplicate the line");
  assert.equal(hits[0], "disable-model-invocation: true");
});

test("a skill without frontmatter is rejected, not guessed at", async () => {
  const name = "bare-skill";
  dir ??= await mkdtemp(join(tmpdir(), "coding-ui-skills-"));
  const target = join(dir, name);
  await mkdir(target, { recursive: true });
  await writeFile(join(target, "SKILL.md"), "# no frontmatter\n\nbody\n", "utf8");
  await assert.rejects(() => skills.setModelInvocation(dir, name, true), /frontmatter/);
});

// --- rankSkills (the scoring pass behind pickSkill + the trigger test) ------

const skill = (name, description, scope = "global") => ({
  name,
  description,
  whenToUse: "",
  body: "# " + name + "\n\nrunbook body",
  scope,
  disableModelInvocation: false,
});

const SKILLS = [
  skill(
    "wechat-bot-deploy",
    "Publish the WeChat AI Bot to its live site. Use when the user asks to 部署/发布/上线 this bot, restart core after edits, publish frontend changes.",
    "workspace",
  ),
  skill("deploy-site", "Stand up a new HTTPS website: DNS subdomain, nginx, TLS certificate. Use when asked to 申请域名, 申请证书, publish a static site."),
  skill("db-server", "登录和管理腾讯云 Lighthouse DB 服务器 (MariaDB)。Use when asked to 登录数据库机器, 备份 MariaDB."),
];

test("rankSkills returns per-skill scores with the matched keywords, best first", () => {
  const { scored } = skills.rankSkills("帮我部署 wechat bot 的前端改动", SKILLS);
  assert.ok(scored.length >= 1);
  const top = scored[0];
  assert.equal(top.s.name, "wechat-bot-deploy");
  assert.ok(top.score >= 2);
  assert.ok(top.distinctive >= 1);
  assert.ok(top.matched.length >= 2, "matched keywords are surfaced for the test panel");
  // Workspace scope outranks global on a score tie (pickSkill's tie-break).
  assert.equal(top.s.scope, "workspace");
});

test("rankSkills scores disabled and body-less skills at nothing — they're absent", () => {
  const { scored } = skills.rankSkills("publish the wechat bot frontend changes", [
    { ...SKILLS[0], disableModelInvocation: true },
    { ...SKILLS[0], name: "empty-skill", body: "" },
  ]);
  assert.equal(scored.length, 0);
});

test("rankSkills on slash commands / empty input returns an empty board", () => {
  assert.deepEqual(skills.rankSkills("/wechat-bot-deploy", SKILLS), { scored: [] });
  assert.deepEqual(skills.rankSkills("   ", SKILLS), { scored: [] });
  assert.deepEqual(skills.rankSkills(null, SKILLS), { scored: [] });
});
