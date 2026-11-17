// Streaming reader for Claude Code's JSONL session transcripts.
//
// Why this module exists: the previous implementation (in sessions.js) did
// `readFileSync(whole file)` + `JSON.parse` of every line, synchronously, in
// THREE separate places — the history load on session open, the per-image
// fetch behind GET /api/transcript/image, and the image-budget check on every
// send that carries an image. Measured on this box's largest transcript
// (39.3 MB): 295 ms read + 93 ms parse = ~390 ms of hard event-loop block per
// session open, plus another full re-read per <img> rendered in that history.
// One Node process serves every session, so that stall froze *everyone's*
// streaming output, not just the opener's.
//
// Everything here reads the file as a stream instead: the I/O happens off the
// loop, and parsing is interleaved chunk by chunk so no single macrotask runs
// long. Memory is bounded as well — readHistory() keeps only the `limit`
// messages it is going to return (a ring buffer) rather than materializing the
// whole parsed transcript and slicing it at the end.
//
// Transcripts are append-only, which this module leans on twice: the image
// index/budget cache rescans only the appended tail, and a line is only
// consumed once it is complete (a half-written trailing line is re-read next
// time rather than being dropped).
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { sessionLogPath, stripSkillInjection } from "./util.js";

const CHUNK = 1 << 18; // 256 KB per read — big enough to be cheap, small enough to interleave

/**
 * Iterate a JSONL transcript, yielding `{ rec, start, next }` per line:
 *   rec   — the parsed record, or null when the line is empty/unparseable
 *           (callers skip those but still see `next`, so a corrupt line can't
 *           wedge the incremental-rescan cursor)
 *   start — byte offset of the line's first byte
 *   next  — byte offset just past the line's newline (the next line's `start`)
 *
 * Lines are decoded only once complete, so a multi-byte UTF-8 sequence split
 * across a chunk boundary is not corrupted (the bug that garbled non-ASCII
 * content back when stdout was accumulated as a string).
 */
export async function* iterRecords(path, fromOffset = 0) {  let stream;
  try {
    stream = createReadStream(path, { start: fromOffset, highWaterMark: CHUNK });
  } catch {
    return; // missing/unreadable — treat as an empty transcript
  }
  let pending = null; // bytes of the current, still-incomplete line
  let lineStart = fromOffset;
  let base = fromOffset; // absolute offset of the current chunk's first byte
  try {
    for await (const chunk of stream) {
      let from = 0;
      for (;;) {
        const nl = chunk.indexOf(0x0a, from);
        if (nl < 0) break;
        const piece = chunk.subarray(from, nl);
        const lineBuf = pending ? Buffer.concat([pending, piece]) : piece;
        pending = null;
        const next = base + nl + 1;
        yield { rec: parseLine(lineBuf), start: lineStart, next };
        from = nl + 1;
        lineStart = base + from;
      }
      const tail = chunk.subarray(from);
      if (tail.length) pending = pending ? Buffer.concat([pending, tail]) : tail;
      base += chunk.length;
    }
  } catch {
    // Truncated or vanished mid-read: yield what we already have rather than
    // failing the whole history load.
    return;
  }
  // A trailing line with no newline yet (claude mid-write). Yield it if it
  // parses; `next` deliberately points at EOF so the newline that arrives
  // later is simply read as an empty line.
  if (pending && pending.length) {
    const rec = parseLine(pending);
    if (rec) yield { rec, start: lineStart, next: base };
  }
}

function parseLine(buf) {
  const text = buf.toString("utf8").trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// --- record → frontend message shape -------------------------------------

// Assistant content blocks, in the shape the web frontend renders.
function assistantBlocks(content) {
  return (Array.isArray(content) ? content : []).map((c) => {
    if (c.type === "text") return { type: "text", text: c.text || "" };
    if (c.type === "tool_use")
      return { type: "tool_use", id: c.id, name: c.name, input: c.input, pending: true };
    if (c.type === "thinking") return { type: "thinking", thinking: c.thinking || "" };
    return { type: "other", raw: c };
  });
}

// Image blocks in a user record, as lightweight {mediaType, url} refs served by
// GET /api/transcript/image — NOT embedded base64, which would bloat both the
// history WS payload and the DOM.
function imageRefs(rec, blocks, cwd, sessionId) {
  const images = [];
  blocks.forEach((b, i) => {
    if (b && b.type === "image" && b.source) {
      images.push({
        mediaType: b.source.media_type || "image/png",
        url:
          `/api/transcript/image?cwd=${encodeURIComponent(cwd)}` +
          `&session=${encodeURIComponent(sessionId)}` +
          `&uuid=${encodeURIComponent(rec.uuid)}&idx=${i}`,
      });
    }
  });
  return images;
}

// Base64 length of every image block in a user record's content, including
// images nested inside tool_result blocks (a browser driver whose screenshots
// get Read back as images is the usual source of a runaway transcript).
function imageBytesIn(blocks) {
  let bytes = 0;
  for (const b of blocks || []) {
    if (!b || typeof b !== "object") continue;
    if (b.type === "image" && b.source?.type === "base64" && typeof b.source.data === "string") {
      bytes += b.source.data.length;
    } else if (b.type === "tool_result" && Array.isArray(b.content)) {
      bytes += imageBytesIn(b.content);
    }
  }
  return bytes;
}

// --- history --------------------------------------------------------------

/**
 * A page of a session's transcript in the frontend's message shape.
 *
 * `opts`:
 *   { limit }              → the last `limit` messages (tail)
 *   { limit, beforeIndex } → up to `limit` messages ending just before
 *                            `beforeIndex` (one page older)
 * Returns { messages, oldestIndex, hasMore } where `oldestIndex` is the
 * front-indexed position of the oldest returned message — stable under appends,
 * so the client echoes it back as the next `beforeIndex`. The cursor is opaque
 * to the client.
 *
 * The scan always runs to EOF even when the window closes early, because a
 * tool_result record appears *after* its tool_use and must still be merged into
 * the tool card it belongs to.
 */
export async function readHistory(cwd, sessionId, opts = {}) {
  const path = sessionLogPath(cwd, sessionId);
  if (!path) return { messages: [], oldestIndex: 0, hasMore: false };

  // limit <= 0 / absent means "no window" (the whole transcript), which is the
  // pre-pagination behavior; nothing in-tree asks for it, but keep the contract.
  const cap = Number.isFinite(opts.limit) && opts.limit > 0 ? opts.limit : Infinity;
  const hi =
    Number.isFinite(opts.beforeIndex) && opts.beforeIndex >= 0 ? Math.floor(opts.beforeIndex) : null;

  let count = 0; // front index the next produced message will get
  const kept = []; // [{ idx, msg, toolIds }], at most `cap`, oldest first
  const toolUse = new Map(); // tool_use_id -> { entry, bi }, kept messages only

  function push(msg) {
    const idx = count++;
    if (hi !== null && idx >= hi) return; // newer than this window — never returned
    const entry = { idx, msg, toolIds: [] };
    if (Array.isArray(msg.blocks)) {
      msg.blocks.forEach((b, bi) => {
        if (b && b.type === "tool_use" && b.id) {
          toolUse.set(b.id, { entry, bi });
          entry.toolIds.push(b.id);
        }
      });
    }
    kept.push(entry);
    while (kept.length > cap) {
      const dropped = kept.shift();
      for (const id of dropped.toolIds) toolUse.delete(id);
    }
  }

  for await (const { rec } of iterRecords(path)) {
    if (!rec || rec.isSidechain) continue;
    const content = rec.message?.content;
    if (rec.type === "user") {
      const blocks = Array.isArray(content) ? content : [];
      if (blocks.some((b) => b && b.type === "tool_result")) {
        // Merge each result into the tool_use card it belongs to. Results for
        // tool calls outside the window are simply dropped — their card isn't
        // being returned.
        for (const tr of blocks) {
          if (!tr || tr.type !== "tool_result") continue;
          const hit = toolUse.get(tr.tool_use_id);
          if (!hit) continue;
          const b = hit.entry.msg.blocks[hit.bi];
          hit.entry.msg.blocks[hit.bi] = {
            ...b,
            result: tr.content,
            isError: !!tr.is_error,
            pending: false,
          };
        }
        continue;
      }
      const userText = stripSkillInjection(
        blocks
          .filter((b) => b && b.type === "text")
          .map((b) => b.text || "")
          .join(""),
      );
      const images = imageRefs(rec, blocks, cwd, sessionId);
      if (userText) {
        const m = { role: "user", text: userText };
        if (images.length) m.images = images;
        push(m);
      } else if (images.length) {
        push({ role: "user", text: "", images });
      } else if (typeof content === "string" && content) {
        push({ role: "user", text: stripSkillInjection(content) });
      }
    } else if (rec.type === "assistant") {
      const msg = rec.message || {};
      push({
        role: "assistant",
        id: msg.id || rec.uuid,
        blocks: assistantBlocks(msg.content),
        streaming: false,
      });
    }
  }

  // kept[0].idx is exactly max(0, windowEnd - cap), so it IS the next cursor.
  // An empty window means there was nothing at or before it either (message
  // indices are dense from 0), so hasMore is false.
  const oldestIndex = kept.length ? kept[0].idx : 0;
  return { messages: kept.map((e) => e.msg), oldestIndex, hasMore: oldestIndex > 0 };
}

// --- plain-text rendering (for compaction) -------------------------------

/**
 * Render a session's transcript as a compact plain-text conversation, for the
 * compaction path (sessions.js): the text is handed to a one-shot `claude -p`
 * that summarizes it into the seed message of a successor session.
 *
 * Tool calls become one-liners (`TOOL Edit <path>`) and tool results are
 * dropped entirely — the summary needs to know WHAT was done, not the full
 * output of every command. Each message is capped (perMsg chars) and the
 * whole text is capped (maxChars) so a runaway transcript can't blow up the
 * summarizer prompt. Returns { text, count } where count is the number of
 * rendered messages.
 */
export async function readConversationText(cwd, sessionId, { maxChars = 240_000, perMsg = 6000 } = {}) {
  const path = sessionLogPath(cwd, sessionId);
  if (!path) return { text: "", count: 0 };
  const parts = [];
  let chars = 0;
  let count = 0;
  const push = (line) => {
    const clipped = line.length > perMsg ? line.slice(0, perMsg) + " […truncated]" : line;
    parts.push(clipped);
    chars += clipped.length;
    count += 1;
  };
  for await (const { rec } of iterRecords(path)) {
    if (chars > maxChars) break;
    if (!rec || rec.isSidechain) continue;
    if (rec.type === "user") {
      const content = rec.message?.content;
      const blocks = Array.isArray(content) ? content : [];
      if (blocks.some((b) => b && b.type === "tool_result")) continue; // results omitted
      const userText = stripSkillInjection(
        blocks.filter((b) => b && b.type === "text").map((b) => b.text || "").join(""),
      );
      if (userText.trim()) push(`USER: ${userText.trim()}`);
    } else if (rec.type === "assistant") {
      const blocks = Array.isArray(rec.message?.content) ? rec.message.content : [];
      const lines = [];
      for (const b of blocks) {
        if (b?.type === "text" && b.text?.trim()) lines.push(b.text.trim());
        else if (b?.type === "tool_use") {
          const p = b.input?.file_path || b.input?.notebook_path || b.input?.pattern || b.input?.command || "";
          lines.push(`TOOL ${b.name}${p ? ` ${String(p).slice(0, 300)}` : ""}`);
        }
      }
      if (lines.length) push(`ASSISTANT: ${lines.join("\n")}`);
    }
  }
  return { text: parts.join("\n\n"), count };
}

// --- image index + budget -------------------------------------------------

/**
 * Per-transcript cache of
 *   bytes — total base64 length of embedded image blocks (the send-path budget)
 *   index — uuid -> { start, next } byte range of each user record that carries
 *           a top-level image block, so serving one image reads one line
 *           instead of re-parsing the whole file
 * keyed by (size, mtime) and extended INCREMENTALLY: a transcript only ever
 * grows, so an appended tail is scanned from `scanned` instead of rescanning
 * from byte 0 (what makes the per-send budget check O(appended) rather than
 * O(transcript)).
 */
const imageCache = new Map(); // path -> { size, mtime, scanned, bytes, index }

async function imageStats(path) {
  if (!path) return { bytes: 0, index: new Map() };
  let st;
  try {
    st = await stat(path);
  } catch {
    imageCache.delete(path);
    return { bytes: 0, index: new Map() };
  }
  const cached = imageCache.get(path);
  if (cached && cached.size === st.size && cached.mtime === st.mtimeMs) return cached;

  // Append-only fast path: same file, only longer → scan just the new tail.
  // Any other shape (shrunk, or no cache) gets a full rescan.
  const appendOnly = cached && st.size >= cached.size && cached.scanned <= st.size;
  const entry = appendOnly
    ? { size: st.size, mtime: st.mtimeMs, scanned: cached.scanned, bytes: cached.bytes, index: cached.index }
    : { size: st.size, mtime: st.mtimeMs, scanned: 0, bytes: 0, index: new Map() };

  for await (const { rec, start, next } of iterRecords(path, entry.scanned)) {
    entry.scanned = next;
    if (!rec || rec.isSidechain || rec.type !== "user") continue;
    const blocks = Array.isArray(rec.message?.content) ? rec.message.content : [];
    entry.bytes += imageBytesIn(blocks);
    if (rec.uuid && blocks.some((b) => b && b.type === "image")) {
      entry.index.set(rec.uuid, { start, next });
    }
  }
  imageCache.set(path, entry);
  return entry;
}

/**
 * Total base64 bytes of image blocks embedded in a session's transcript. Every
 * turn re-sends the whole history and the gateway refuses to even READ a
 * request body at 16 MB (see config.imageBudgetBytes), so the send path uses
 * this to decide whether embedding one more image would push the session past
 * what can ever be transported again.
 */
export async function embeddedImageBytes(cwd, sessionId) {
  const { bytes } = await imageStats(sessionLogPath(cwd, sessionId));
  return bytes;
}

/**
 * One image block from a transcript, as decoded bytes, for
 * GET /api/transcript/image. Reads only that record's line (located via the
 * cached byte index) instead of the whole transcript.
 */
export async function readTranscriptImage(cwd, sessionId, uuid, idx) {
  const path = sessionLogPath(cwd, sessionId);
  if (!path) return null;
  const { index } = await imageStats(path);
  const at = index.get(uuid);
  if (!at) return null;
  let rec = null;
  for await (const r of iterRecords(path, at.start)) {
    rec = r.rec; // the record starting at `at.start` is the first line read
    break;
  }
  if (!rec || rec.uuid !== uuid) return null;
  const content = rec.message?.content;
  if (!Array.isArray(content)) return null;
  const block = content[idx];
  if (!block || block.type !== "image" || !block.source || !block.source.data) return null;
  try {
    return {
      mediaType: block.source.media_type || "image/png",
      buffer: Buffer.from(block.source.data, "base64"),
    };
  } catch {
    return null;
  }
}

// Drop a transcript's cached image index/budget (used when a session and its
// transcript are deleted, so the map doesn't retain entries for dead files).
export function forgetTranscript(cwd, sessionId) {
  const path = sessionLogPath(cwd, sessionId);
  if (path) imageCache.delete(path);
}
