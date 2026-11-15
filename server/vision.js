// Turn image attachments into text using a vision-capable model, so a
// text-only model can still "see" them.
//
// Why: the gateway hard-rejects image blocks on models without vision —
//   HTTP 400  this model does not support image input
// — and the model is fixed for the lifetime of a spawned claude process, so
// the old workaround was to restart the session onto a vision model. That
// silently moved the user's whole conversation onto a weaker coding model.
// Transcribing instead keeps the user's chosen model in place: the images are
// converted here and forwarded as ordinary text.
import { config } from "./config.js";

// Transcription is OCR-like: for a coding UI the dominant case is a screenshot
// of an error, a stack trace, or code, where a summary is useless because the
// exact identifiers and numbers are the whole point. So the prompt asks for a
// verbatim transcription, explicitly not a summary.
const PROMPT = `You are transcribing images for a coding assistant that cannot see them. Transcribe the information in the image(s) below verbatim.

Rules:
- Copy every visible character exactly: error messages, stack traces, code, terminal output, file paths, numbers, identifiers, button and menu labels. Do not summarize, omit, translate, or rephrase — keep the original language of the text.
- Preserve indentation, line breaks and hierarchy. Wrap code and terminal output in \`\`\` fences with a language tag.
- UI screenshots: open with one line naming what the screen is (e.g. "VS Code editor showing a TypeScript error"), then transcribe the text in it.
- Images with no text (charts, photos): describe the content, structure, key values and trends factually.
- With multiple images, split the output into [Image 1] [Image 2] … sections and apply these rules to each.
- Where text is too blurry to read, write [unclear] — never guess.

Output only the transcription: no commentary, preamble or summary.`;

const MAX_TOKENS = Number(process.env.VISION_MAX_TOKENS) || 4096;
const TIMEOUT_MS = Number(process.env.VISION_TIMEOUT_MS) || 60_000;

// attachments: [{ mediaType, data }] with `data` being raw base64 (no data: prefix).
// Returns { text, model, truncated }. Throws on any failure — callers surface
// the message to the user rather than sending an image block that would 400.
export async function transcribeImages(attachments, { model, signal } = {}) {
  const describeModel = model || config.visionDescribeModel;
  const images = (attachments || []).filter(
    (a) => a && typeof a.data === "string" && a.data && String(a.mediaType || "").startsWith("image/"),
  );
  if (!images.length) throw new Error("no image attachments to transcribe");

  const base = (config.anthropicBaseUrl || "").replace(/\/+$/, "");
  const url = `${base}/v1/messages`;

  // One call for the whole batch: cheaper than per-image, and it lets the model
  // keep cross-image context (e.g. "this is the same trace, scrolled down").
  const content = [{ type: "text", text: PROMPT }];
  for (const img of images) {
    content.push({
      type: "image",
      source: { type: "base64", media_type: String(img.mediaType), data: img.data },
    });
  }

  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: describeModel,
      max_tokens: MAX_TOKENS,
      messages: [{ role: "user", content }],
    }),
    // Abort if either the caller cancels or we hit our own ceiling.
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${describeModel} transcription failed: HTTP ${res.status} ${body.slice(0, 300)}`);
  }

  const j = await res.json();
  const text = (j.content || [])
    .filter((b) => b && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n")
    .trim();
  if (!text) throw new Error(`${describeModel} returned an empty transcription`);

  return { text, model: describeModel, truncated: j.stop_reason === "max_tokens" };
}
