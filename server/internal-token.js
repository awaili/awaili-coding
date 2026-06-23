import { randomBytes } from "node:crypto";

// Ephemeral per-process token that authorizes the locally-spawned TUI
// (tui/index.js) to open a /ws connection without a browser session cookie.
// The TUI is spawned by this same server process (see term.js spawnTui), which
// injects this token via the CODE_UI_TOKEN env var; the TUI sends it back as
// ?token= on its /ws URL. The upgrade dispatcher in index.js accepts it for
// /ws only — /term and /shell stay cookie-gated, so the token can't spawn PTYs.
//
// Regenerated on every server start; not persisted, not logged.
export const internalToken = randomBytes(24).toString("hex");