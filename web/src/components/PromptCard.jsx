import { useState } from "react";

// Compact, read-only preview of a tool's input for a permission prompt.
// Mirrors the per-tool rendering in ToolCard but without the collapsible /
// editable affordances — we only want to show the user what they're approving.
function ToolInputPreview({ name, input }) {
  if (name === "Bash") return <pre>{input?.command || ""}</pre>;
  if (name === "Edit")
    return (
      <div>
        <div className="kv">{input?.file_path || ""}</div>
        {input?.old_string != null && <pre className="old">-{input.old_string}</pre>}
        {input?.new_string != null && <pre className="new">+{input.new_string}</pre>}
      </div>
    );
  if (name === "Write")
    return (
      <div>
        <div className="kv">{input?.file_path || ""}</div>
        <pre>{input?.content || ""}</pre>
      </div>
    );
  return <pre>{JSON.stringify(input ?? {}, null, 2)}</pre>;
}

// Build the stdin answer payload (the `response` field of a control_response)
// for a can_use_tool request. For an ordinary tool we echo its input back
// unchanged on allow; for AskUserQuestion we replace input with the user's
// answers. `extra` carries optional updatedPermissions (for "always allow").
function allowResponse(request, updatedInput, extra = {}) {
  return { behavior: "allow", updatedInput, ...extra };
}

// Echo the original tool input verbatim — Claude Code expects the same input
// it sent (it may re-validate). Fallback to {} if the request had none.
function echoInput(request) {
  return request.input && typeof request.input === "object" ? request.input : {};
}

// A human label for the prompt: prefer the bridge-provided title/display_name,
// then a per-tool summary, then the raw tool name.
function promptTitle(request) {
  if (request.title) return request.title;
  const name = request.display_name || request.tool_name || "tool";
  if (request.tool_name === "Bash") return `${name}: ${request.input?.command || ""}`;
  if (request.input?.file_path) return `${name}: ${request.input.file_path}`;
  return name;
}

export default function PromptCard({ prompt, onAnswer }) {
  const { requestId, request } = prompt;
  const subtype = request?.subtype;

  if (subtype === "can_use_tool" && request.tool_name === "AskUserQuestion") {
    return <AskCard key={requestId} prompt={prompt} onAnswer={onAnswer} />;
  }
  if (subtype === "can_use_tool") {
    return <PermissionCard key={requestId} prompt={prompt} onAnswer={onAnswer} />;
  }
  if (subtype === "request_user_dialog") {
    return <DialogCard key={requestId} prompt={prompt} onAnswer={onAnswer} />;
  }
  // Unknown control request kind — render a minimal fallback so the session
  // can't deadlock waiting on a prompt we don't know how to render.
  return <UnknownCard key={requestId} prompt={prompt} onAnswer={onAnswer} />;
}

// --- Permission prompt (write/exec tools): Allow / Always allow / Deny -----

function PermissionCard({ prompt, onAnswer }) {
  const { requestId, request } = prompt;
  const [busy, setBusy] = useState(false);
  const suggestions = Array.isArray(request.permission_suggestions)
    ? request.permission_suggestions
    : [];
  // "Always allow" persists a local-settings rule so the same tool won't prompt
  // again this session. Only offer it when claude sent suggestions to persist.
  const canAlways = suggestions.some((s) => s.destination === "localSettings");

  function respond(response) {
    setBusy(true);
    onAnswer(requestId, response);
  }

  return (
    <div className="prompt-card">
      <div className="prompt-head">
        <span className="prompt-icon">🔐</span>
        <div className="prompt-titles">
          <div className="prompt-title">{promptTitle(request)}</div>
          {request.description && <div className="prompt-desc">{request.description}</div>}
          {request.decision_reason && !request.description && (
            <div className="prompt-desc">{request.decision_reason}</div>
          )}
        </div>
      </div>
      {request.input && Object.keys(request.input).length > 0 && (
        <div className="prompt-input">
          <ToolInputPreview name={request.tool_name} input={request.input} />
        </div>
      )}
      <div className="prompt-actions">
        <button className="btn allow" disabled={busy} onClick={() => respond(allowResponse(request, echoInput(request)))}>
          Allow once
        </button>
        {canAlways && (
          <button
            className="btn always"
            disabled={busy}
            onClick={() =>
              respond(
                allowResponse(request, echoInput(request), {
                  updatedPermissions: suggestions.filter((s) => s.destination === "localSettings"),
                }),
              )
            }
            title="Remember this permission in local settings so it won't prompt again"
          >
            Always allow
          </button>
        )}
        <button className="btn deny" disabled={busy} onClick={() => respond({ behavior: "deny", message: "User denied" })}>
          Deny
        </button>
      </div>
    </div>
  );
}

// --- AskUserQuestion: render questions + multiple-choice options ----------

function AskCard({ prompt, onAnswer }) {
  const { requestId, request } = prompt;
  const questions = Array.isArray(request.input?.questions) ? request.input.questions : [];
  // Per-question selected option label(s) + free-text override. answers maps
  // question text -> selected label (string) | labels (array for multiSelect).
  const [answers, setAnswers] = useState(() => {
    const a = {};
    for (const q of questions) a[q.question] = q.multiSelect ? [] : "";
    return a;
  });
  const [busy, setBusy] = useState(false);

  function setQ(question, value) {
    setAnswers((a) => ({ ...a, [question]: value }));
  }
  // Toggle a label in a multiSelect question's array.
  function toggleMulti(question, label) {
    setAnswers((a) => {
      const cur = Array.isArray(a[question]) ? a[question] : [];
      return { ...a, [question]: cur.includes(label) ? cur.filter((x) => x !== label) : [...cur, label] };
    });
  }

  function allAnswered() {
    return questions.every((q) => {
      const v = answers[q.question];
      if (q.multiSelect) return Array.isArray(v) && v.length > 0;
      return typeof v === "string" && v.trim().length > 0;
    });
  }

  function submit() {
    setBusy(true);
    // Build the updatedInput the AskUserQuestion tool expects: the original
    // questions array (passed through) plus an answers map keyed by question
    // text. Multi-select answers are arrays; single-select are label strings.
    const answersMap = {};
    for (const q of questions) {
      const v = answers[q.question];
      answersMap[q.question] = q.multiSelect ? Array.isArray(v) ? v : [] : v;
    }
    onAnswer(requestId, allowResponse(request, { questions, answers: answersMap }));
  }

  function dismiss() {
    setBusy(true);
    onAnswer(requestId, { behavior: "deny", message: "User dismissed the question" });
  }

  return (
    <div className="prompt-card ask">
      <div className="prompt-head">
        <span className="prompt-icon">❓</span>
        <div className="prompt-titles">
          <div className="prompt-title">Claude has a question</div>
        </div>
      </div>
      <div className="ask-questions">
        {questions.map((q, qi) => (
          <div key={qi} className="ask-q">
            <div className="ask-q-header">
              <span className="ask-q-label">{q.header || `Question ${qi + 1}`}</span>
              {q.multiSelect && <span className="ask-q-multi">multi-select</span>}
            </div>
            <div className="ask-q-text">{q.question}</div>
            <div className="ask-options">
              {(q.options || []).map((opt, oi) => {
                const selected = q.multiSelect
                  ? Array.isArray(answers[q.question]) && answers[q.question].includes(opt.label)
                  : answers[q.question] === opt.label;
                return (
                  <button
                    key={oi}
                    className={"ask-option" + (selected ? " selected" : "")}
                    onClick={() => (q.multiSelect ? toggleMulti(q.question, opt.label) : setQ(q.question, opt.label))}
                  >
                    <span className="ask-opt-label">{opt.label}</span>
                    {opt.description && <span className="ask-opt-desc">{opt.description}</span>}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      <div className="prompt-actions">
        <button className="btn allow" disabled={busy || !allAnswered()} onClick={submit}>
          Submit answer
        </button>
        <button className="btn deny" disabled={busy} onClick={dismiss}>
          Dismiss
        </button>
      </div>
    </div>
  );
}

// --- request_user_dialog: opaque dialog with a generic JSON response ---------

function DialogCard({ prompt, onAnswer }) {
  const { requestId, request } = prompt;
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  function respond(response) {
    setBusy(true);
    onAnswer(requestId, response);
  }
  function sendCompleted() {
    let result;
    try {
      result = text.trim() ? JSON.parse(text) : null;
    } catch {
      result = text; // treat as a plain string if not valid JSON
    }
    respond({ behavior: "completed", result });
  }

  return (
    <div className="prompt-card">
      <div className="prompt-head">
        <span className="prompt-icon">💬</span>
        <div className="prompt-titles">
          <div className="prompt-title">Claude is asking: {request.dialog_kind || "dialog"}</div>
          <div className="prompt-desc">This is a tool-driven dialog. Send a response or cancel.</div>
        </div>
      </div>
      <div className="prompt-input">
        <pre>{JSON.stringify(request.payload ?? request, null, 2)}</pre>
      </div>
      <textarea
        className="dialog-text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Response (JSON or text) — leave empty to cancel"
        rows={3}
      />
      <div className="prompt-actions">
        <button className="btn allow" disabled={busy} onClick={sendCompleted}>
          Respond
        </button>
        <button className="btn deny" disabled={busy} onClick={() => respond({ behavior: "cancelled" })}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function UnknownCard({ prompt, onAnswer }) {
  const { requestId, request } = prompt;
  const [busy, setBusy] = useState(false);
  return (
    <div className="prompt-card">
      <div className="prompt-head">
        <span className="prompt-icon">⚠️</span>
        <div className="prompt-titles">
          <div className="prompt-title">Unknown prompt ({request.subtype || "?"})</div>
          <div className="prompt-desc">Claude sent a control request this UI can't render. Cancel to continue.</div>
        </div>
      </div>
      <div className="prompt-input">
        <pre>{JSON.stringify(request, null, 2)}</pre>
      </div>
      <div className="prompt-actions">
        <button className="btn deny" disabled={busy} onClick={() => { setBusy(true); onAnswer(requestId, { behavior: "cancelled" }); }}>
          Cancel
        </button>
      </div>
    </div>
  );
}