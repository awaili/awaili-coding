import { mkdir } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { resolve, relative, dirname, basename, sep } from "node:path";
import { config } from "./config.js";

export async function mkdirp(p) {
  await mkdir(p, { recursive: true });
  return p;
}

// realpath() that returns null instead of throwing when the path doesn't exist
// (e.g. a file about to be written). Used by safe() so symlink resolution can
// still run on the existing parent directory.
function realpathOrNull(p) {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

// True if `target` is `root` itself or a path beneath it. String-only (no
// symlink follow) — the cheap first confinement check; safe() additionally
// realpaths to defeat symlinks.
function inside(root, target) {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !rel.includes(`..${sep}`));
}

// Confine an attacker-supplied cwd to WORKSPACE_ROOT. Returns the confined
// absolute path, or null if it escapes. `want` may be absolute or relative;
// absolute paths outside the workspace are rejected by the relative() check.
export function confineCwd(want) {
  const root = resolve(config.workspaceRoot);
  const target = resolve(root, want || ".");
  if (!inside(root, target)) return null;
  return target;
}

// Resolve `sub` under `root` and confine it, following symlinks so a symlink
// inside the workspace that points outside can't be used to escape. Returns the
// real absolute path or null. `root` must already be confined (caller passes a
// cwd that passed confineCwd()).
export function safe(root, sub) {
  const target = resolve(root, sub || ".");
  if (!inside(root, target)) return null;
  const realRoot = realpathOrNull(root) || root;
  // If the target exists, realpath it; otherwise realpath its parent and
  // re-join the basename (for files about to be created).
  const realTarget = realpathOrNull(target);
  const real = realTarget || (realpathOrNull(dirname(target)) ? resolve(realpathOrNull(dirname(target)), basename(target)) : target);
  if (!inside(realRoot, real)) return null;
  return real;
}