import { memo, useState } from "react";
import DiffView, { diffStats } from "./DiffView.jsx";

function lineCount(s) {
  if (typeof s !== "string" || s === "") return 0;
  const l = s.split("\n");
  if (l[l.length - 1] === "") l.pop(); // trailing newline is not a line
  return l.length;
}

function summarize(name, input) {
  switch (name) {
    case "Read":
    case "Write":
    case "Edit":
    case "MultiEdit":
      return input?.file_path || "";
    case "NotebookEdit":
      return input?.notebook_path || "";
    case "Bash":
      return input?.command || "";
    case "Glob":
    case "Grep":
      return input?.pattern || "";
    case "TaskCreate":
      return input?.subject || "";
    case "TaskUpdate":
      return (
        input?.subject || (input?.taskId != null ? `#${input.taskId}` : "")
      );
    default:
      return "";
  }
}

// Compact change stats for the card header: "+n −m" for Edit/MultiEdit,
// "n lines" for Write/NotebookEdit (whole-content tools).
function changeStats(name, input) {
  if (!input) return "";
  if (name === "Edit") {
    const s = diffStats(input.old_string, input.new_string);
    return `+${s.add} −${s.del}`;
  }
  if (name === "MultiEdit") {
    if (!Array.isArray(input.edits) || input.edits.length === 0) return "";
    let add = 0;
    let del = 0;
    for (const e of input.edits) {
      const s = diffStats(e?.old_string, e?.new_string);
      add += s.add;
      del += s.del;
    }
    return `+${add} −${del}`;
  }
  if (name === "Write") {
    const n = lineCount(input.content);
    return n ? `${n} lines` : "";
  }
  if (name === "NotebookEdit") {
    const n = lineCount(input.new_source);
    return n ? `${n} lines` : "";
  }
  return "";
}

function statusIcon(status) {
  if (status === "completed") return "☑";
  if (status === "in_progress") return "◐";
  return "☐";
}

function ToolInput({ name, input }) {
  if (name === "Bash") {
    return (
      <div>
        <div className="kv">command</div>
        <pre>{input?.command}</pre>
      </div>
    );
  }
  if (name === "Read") {
    return (
      <div>
        <div className="kv">{input?.file_path}</div>
      </div>
    );
  }
  if (name === "Edit") {
    return (
      <div>
        <div className="kv">{input?.file_path}</div>
        <DiffView oldStr={input?.old_string} newStr={input?.new_string} />
      </div>
    );
  }
  if (name === "MultiEdit") {
    const edits = Array.isArray(input?.edits) ? input.edits : [];
    return (
      <div>
        <div className="kv">{input?.file_path}</div>
        {edits.map((e, i) => (
          <div key={i} className="multiedit">
            <div className="kv">edit {i + 1}</div>
            <DiffView oldStr={e?.old_string} newStr={e?.new_string} />
          </div>
        ))}
      </div>
    );
  }
  if (name === "Write") {
    return (
      <div>
        <div className="kv">{input?.file_path}</div>
        <DiffView raw={input?.content} />
      </div>
    );
  }
  if (name === "NotebookEdit") {
    return (
      <div>
        <div className="kv">{input?.notebook_path}</div>
        <DiffView raw={input?.new_source} />
      </div>
    );
  }
  if (name === "Glob" || name === "Grep") {
    return <pre>{JSON.stringify(input, null, 2)}</pre>;
  }
  return <pre>{JSON.stringify(input, null, 2)}</pre>;
}

// Always-visible compact bodies for task-tracking tools.
function TaskToolBody({ name, input }) {
  if (name === "TodoWrite") {
    const todos = Array.isArray(input?.todos) ? input.todos : [];
    if (todos.length === 0) {
      return <div className="todolist"><div className="todoitem">No todos</div></div>;
    }
    return (
      <div className="todolist">
        {todos.map((t, i) => (
          <div key={i} className="todoitem" title={t.activeForm || t.content || ""}>
            <span className="tstatus">{statusIcon(t.status)}</span>
            <span className={t.status === "completed" ? "tcontent tdone" : "tcontent"}>
              {t.content || ""}
            </span>
          </div>
        ))}
      </div>
    );
  }
  if (name === "TaskCreate") {
    return (
      <div className="taskline">
        <span className="tstatus">☐</span>
        <span className="tcontent">
          <span className="taskname">task {input?.subject || ""}</span>
          {input?.description ? <span className="taskdesc"> — {input.description}</span> : null}
        </span>
      </div>
    );
  }
  // TaskUpdate
  const subject = input?.subject || (input?.taskId != null ? `#${input.taskId}` : "");
  return (
    <div className="taskline">
      <span className="tstatus">{statusIcon(input?.status)}</span>
      <span className="tcontent">
        <span className="taskname">task {subject}</span>
        <span className="taskarrow"> → </span>
        <span className="taskstatus">{input?.status || "pending"}</span>
      </span>
    </div>
  );
}

function ToolResult({ result, isError }) {
  let text = result;
  if (Array.isArray(result)) {
    // tool_result content can be an array of blocks
    text = result
      .map((b) => (typeof b === "string" ? b : b?.text || JSON.stringify(b)))
      .join("\n");
  } else if (typeof result !== "string") {
    text = JSON.stringify(result, null, 2);
  }
  return (
    <div className="result">
      <div className="label" style={{ color: isError ? "var(--err)" : undefined }}>
        {isError ? "error" : "result"}
      </div>
      <pre style={{ color: isError ? "var(--err)" : undefined }}>{text}</pre>
    </div>
  );
}

// Rel path of the tool's target file (inside cwd), or null when the button
// should stay hidden (no callback, no cwd, or a path outside cwd).
function openTargetFor(input, cwd, onOpenFile) {
  if (typeof onOpenFile !== "function" || typeof cwd !== "string" || !cwd) return null;
  const p = input?.file_path || input?.notebook_path;
  if (typeof p !== "string" || !p.startsWith(cwd + "/")) return null;
  return p.slice(cwd.length + 1);
}

const TASK_TOOLS = new Set(["TodoWrite", "TaskCreate", "TaskUpdate"]);

function ToolCard({ block, onOpenFile, cwd }) {
  const [open, setOpen] = useState(false);
  const { name, input, result, isError, pending } = block;
  const hasResult = result !== undefined;
  const stats = changeStats(name, input);
  const openTarget = openTargetFor(input, cwd, onOpenFile);

  // Task-tracking tools render as compact, always-expanded cards.
  if (TASK_TOOLS.has(name)) {
    return (
      <div className="tool tasktool">
        <div className="head">
          <span className="name">{name}</span>
          <span className="summary">{summarize(name, input)}</span>
          <span className="chev">
            {pending ? "…" : hasResult ? (isError ? "✕" : "✓") : "…"}
          </span>
        </div>
        <div className="taskbody">
          <TaskToolBody name={name} input={input} />
          {hasResult && isError && <ToolResult result={result} isError={isError} />}
        </div>
      </div>
    );
  }

  return (
    <div className="tool">
      <div className="head" onClick={() => setOpen((o) => !o)}>
        <span className="name">{name}</span>
        {stats && <span className="stats">{stats}</span>}
        <span className="summary">{summarize(name, input)}</span>
        {openTarget && (
          <button
            className="openbtn"
            title="Open in editor"
            onClick={(e) => {
              e.stopPropagation();
              onOpenFile(openTarget);
            }}
          >
            open ↗
          </button>
        )}
        <span className="chev">
          {pending ? "…" : hasResult ? (isError ? "✕" : "✓") : "…"} {open ? "▾" : "▸"}
        </span>
      </div>
      {open && (
        <div className="body">
          <ToolInput name={name} input={input} />
          {hasResult && <ToolResult result={result} isError={isError} />}
        </div>
      )}
    </div>
  );
}

// Blocks are replaced immutably one index at a time while a turn streams, so a
// shallow compare keeps already-finished tool cards (and their diffs / result
// bodies) from re-rendering on every token of the message they live in.
export default memo(ToolCard);
