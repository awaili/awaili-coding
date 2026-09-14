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
const PROMPT = `你在为一个看不到图片的编码助手做「图像转文字」。请把下面图片中的信息逐字转写出来。

要求：
- 所有可见文字一律照抄，包括报错信息、堆栈、代码、终端输出、文件路径、数字、标识符、按钮与菜单文案。不要概括、不要省略、不要翻译、不要改写。
- 保留原有的缩进、换行与层级结构。代码和终端输出用 \`\`\` 包裹并标注语言。
- 界面截图：先用一行说明这是什么界面（例如「VS Code 编辑器，显示一个 TypeScript 报错」），再转写其中的文字。
- 图表、照片等没有文字的图：客观描述其内容、结构、关键数值与趋势。
- 有多张图时按 [图1] [图2] … 分段，每段套用上面的规则。
- 某处文字模糊无法辨认时写 [不清晰]，不要猜测。

只输出转写结果，不要加任何评论、前言或总结。`;

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
    throw new Error(`${describeModel} 转写失败: HTTP ${res.status} ${body.slice(0, 300)}`);
  }

  const j = await res.json();
  const text = (j.content || [])
    .filter((b) => b && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n")
    .trim();
  if (!text) throw new Error(`${describeModel} 转写返回了空内容`);

  return { text, model: describeModel, truncated: j.stop_reason === "max_tokens" };
}
