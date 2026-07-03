# Writing a skill (Claude Code)

A **skill** is a folder of instructions (plus optional scripts/resources) that Claude loads on demand to do a specialized task. Each skill is a directory with a `SKILL.md` entrypoint:

```
my-skill/
├── SKILL.md           # required — frontmatter + instructions
├── reference.md       # supporting doc, read on demand
├── examples.md        # example prompts that should trigger the skill
└── scripts/
    └── helper.py      # script Claude can execute
```

**When to create a skill** — when you keep pasting the same instructions, checklist, or multi-step procedure into chat, or when a section of `CLAUDE.md` has grown into a *procedure* rather than a *fact*. Unlike `CLAUDE.md`, a skill's body loads only when it is used, so long reference material costs almost nothing until you need it.

> **New skill** in this manager scaffolds `SKILL.md` + `reference.md` + `examples.md` for you, each pre-filled with guidance. Edit them in place; delete any you don't need.

## Scope — where skills live

Where a skill is stored decides who can use it:

| Level | Path | Applies to |
|---|---|---|
| Personal (global) | `~/.claude/skills/<name>/SKILL.md` | All your projects |
| Project (workspace) | `<cwd>/.claude/skills/<name>/SKILL.md` | This project only |
| Plugin | `<plugin>/skills/<name>/SKILL.md` | Where the plugin is enabled |
| Enterprise | managed settings | All users in your org |

Precedence when names collide: enterprise > personal > project. A skill at any level also overrides a bundled skill of the same name. Plugin skills are namespaced (`plugin-name:skill-name`) so they can't conflict.

**Live reload**: Claude watches skill directories — editing `SKILL.md` is picked up within the session without restarting. (Creating a brand-new top-level skills dir that didn't exist at session start needs a restart.)

**Monorepo note**: skills also load from nested `.claude/skills/` directories below your working directory. When Claude works in a subdirectory, that subdirectory's `.claude/skills/` become available. A nested skill that clashes is directory-qualified (e.g. `apps/web:deploy`).

## SKILL.md anatomy

`SKILL.md` has two parts: YAML **frontmatter** (between `---` markers) telling Claude *when* to use the skill, and **markdown body** with the instructions Claude follows when it runs.

```yaml
---
name: my-skill
description: What this skill does and when to use it.
---

# My Skill

Instructions here. Keep it short — see reference.md for detail.
```

## Frontmatter reference

All fields are optional; only `description` is recommended.

| Field | Purpose |
|---|---|
| `name` | Display name in listings. Defaults to the directory name. (For personal/project skills the **command you type is the directory name**, not this field.) |
| `description` | **What** the skill does + **when** to use it. Claude matches your request against this to decide whether to load it. Put the key use case first. |
| `when_to_use` | Extra trigger phrases / example requests, appended to `description`. |
| `argument-hint` | Autocomplete hint, e.g. `[issue-number]`. |
| `arguments` | Named positional args for `$name` substitution (space-separated string or YAML list). |
| `disable-model-invocation` | `true` = only *you* can invoke it (manual `/name`); Claude won't auto-load. Use for side-effect workflows (`/deploy`, `/commit`). |
| `user-invocable` | `false` = hidden from the `/` menu; only Claude invokes. Use for background knowledge. |
| `allowed-tools` | Tools Claude may use **without per-use approval** while the skill is active (space/comma list or YAML list). Does **not** restrict what's available. |
| `disallowed-tools` | Tools removed from Claude's pool while the skill is active; clears on your next message. |
| `model` | Model override while the skill is active (resumes next prompt). Accepts `inherit`. |
| `effort` | Effort override: `low` / `medium` / `high` / `xhigh` / `max`. |
| `context` | `fork` to run in an isolated subagent context. |
| `agent` | Subagent type when `context: fork` (`Explore`, `Plan`, `general-purpose`, or a custom agent). |
| `paths` | Globs limiting auto-activation to matching files (comma list or YAML list). |
| `hooks` | Hooks scoped to this skill's lifecycle. |
| `shell` | `bash` (default) or `powershell` for `!command` blocks. |

## Discoverability — the description is everything

Skill **descriptions are always in context** so Claude knows what's available, but the **full body loads only when invoked**. So your `description` is the single biggest lever for whether your skill fires.

- Put the key use case **first**: the combined `description` + `when_to_use` is truncated at **1,536 characters** in the listing.
- Include the **verbs + nouns** of tasks ("merge PDFs", "fill in a PDF form") and **trigger phrases** users/the model might say.
- Add `when_to_use` for extra examples.
- With many skills, descriptions are shortened to fit a budget (≈1% of the context window); least-used skills get dropped first. Run `/doctor` to see what's being cut.

### Invocation control

| Frontmatter | You can invoke | Claude can invoke | When the body loads |
|---|---|---|---|
| (default) | yes | yes | Description always in context; body loads when invoked |
| `disable-model-invocation: true` | yes | **no** | Description **not** in context; body loads only when *you* invoke |
| `user-invocable: false` | **no** | yes | Description always in context; body loads when Claude invokes |

## Tools & permissions

`allowed-tools` **pre-approves** tools while the skill is active — Claude can use them without prompting you. It does **not** restrict the tool pool; every tool stays callable, and your normal permission settings still govern unlisted tools:

```yaml
allowed-tools: Bash(git add *) Bash(git commit *) Bash(git status *)
```

`disallowed-tools` removes tools from the pool entirely while the skill is active (clears on your next message) — handy for autonomous loops that must never call, say, `AskUserQuestion`.

> Project skills' `allowed-tools` take effect after you accept the workspace-trust dialog. Review project skills before trusting a repo — a skill can grant itself broad tool access.

## Body — keep it short

Once invoked, the rendered `SKILL.md` **stays in context for the rest of the session** (Claude does not re-read it), so **every line is a recurring token cost**.

- **Keep `SKILL.md` under ~500 lines.** Move detailed reference into supporting files.
- State **what** to do, not how or why (same conciseness test as `CLAUDE.md`).
- **Progressive disclosure**: reference supporting files from `SKILL.md` so Claude reads them only when needed:

```markdown
## Additional resources
- For complete API details, see [reference.md](reference.md)
- For usage examples, see [examples.md](examples.md)
```

On **auto-compaction**, the most recent invocation of each skill is re-attached (first ~5,000 tokens each, ~25,000 combined). If a skill seems to "stop working" later in a session, re-invoke it to restore the full content.

## Dynamic context injection

`!`command`` runs a shell command **before** the skill content is sent to Claude; the output replaces the placeholder, so Claude sees real data, not the command:

```yaml
---
name: summarize-changes
description: Summarize uncommitted changes and flag risks. Use when asked what changed or to review a diff.
---

## Current changes
!`git diff HEAD`

## Instructions
Summarize the changes above in 2–3 bullets, then list any risks.
```

Use a fenced ` ```! ` block for multi-line commands. Disable with `disableSkillShellExecution: true` in settings.

## Arguments & substitutions

- `$ARGUMENTS` — all arguments passed to the skill. If absent, args are appended as `ARGUMENTS: <value>`.
- `$ARGUMENTS[N]` or `$N` — a specific positional arg (`$0` is first).
- `$name` — a named arg declared in the `arguments` list (maps to position).
- `${CLAUDE_SKILL_DIR}` — the skill's own directory; use it in `!command` blocks to reference bundled scripts regardless of cwd: `python3 ${CLAUDE_SKILL_DIR}/scripts/run.py .`
- `${CLAUDE_SESSION_ID}`, `${CLAUDE_EFFORT}` — current session id / effort level.

Escape a literal `$` before a token with a backslash: `\$1.00`.

Example:

```yaml
---
name: fix-issue
description: Fix a GitHub issue
disable-model-invocation: true
---
Fix GitHub issue $ARGUMENTS following our coding standards.
```

`/fix-issue 123` → "Fix GitHub issue 123 following our coding standards."

## Run in a subagent

`context: fork` runs the skill in an isolated subagent — the skill content becomes the task prompt, with no access to your conversation history. Pick the agent with `agent:`. Best for **explicit task instructions**, not loose guidelines.

```yaml
---
name: deep-research
description: Research a topic thoroughly
context: fork
agent: Explore
---
Research $ARGUMENTS thoroughly:
1. Find relevant files with Glob and Grep
2. Read and analyze the code
3. Summarize findings with file references
```

## Naming

For personal and project skills, the **command you type is the directory name** (e.g. `.claude/skills/deploy-staging/SKILL.md` → `/deploy-staging`). The frontmatter `name` is only the **display label** in listings. Use lowercase with hyphens.

## Test & iterate

A skill triggering means Claude *found* it — not that it did what you intended. Test two ways:

1. Ask something that matches the `description` (Claude should auto-load it).
2. Invoke directly with `/skill-name`.

Iterate in a **fresh session** — leftover authoring context masks gaps. For systematic evals, install the `skill-creator` plugin (`/plugin install skill-creator@claude-plugins-official`) which writes test cases, runs isolated subagents per case, grades assertions, and benchmarks with-vs-without the skill.

### Troubleshooting

- **Not triggering**: check the description has keywords users would say; verify with "What skills are available?"; rephrase to match; or invoke `/name` directly. Malformed YAML → the body loads with empty metadata (no description to match) — run with `--debug` to see the parse error.
- **Triggers too often**: make the description more specific, or set `disable-model-invocation: true`.
- **Description cut short**: the 1,536-char cap or the listing budget. Put the key use case first; trim at the source; set low-priority skills to `"name-only"` in `skillOverrides`; run `/doctor`.

## Install from skillhub / GitHub

Use the **Browse** tab to:

1. Search the [skillhub](https://skills.palebluedot.live) registry, or paste a GitHub `owner/repo/path`.
2. Pick the install scope (Workspace or Global) with the toggle above the results.
3. Click **Install** — the full skill tree (`SKILL.md` + supporting files + scripts) is copied from GitHub into that scope.

### ⚠ Security

A skill is a set of instructions the model may **follow**. A malicious skill can steer behavior or exfiltrate data once loaded. Before installing a third-party skill:

- prefer **verified** skills and a high **security score** (shown as a badge on each result);
- open the source repo and read `SKILL.md` + supporting files, especially any scripts and `allowed-tools`;
- don't install skills from authors you don't trust.

Installing does not auto-activate anything — a skill only loads when its `description` matches a future request (or you invoke `/name`).

## Learn more

- Official skills docs: <https://code.claude.com/docs/en/skills>
- Agent Skills open standard: <https://agentskills.io>
- Official example skills: <https://github.com/anthropics/skills>
- Skill authoring best practices: <https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices>
- Evaluating skill output quality: <https://agentskills.io/skill-creation/evaluating-skills>