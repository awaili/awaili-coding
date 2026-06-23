import { useState } from "react";
import DiffView from "./DiffView.jsx";

function summarize(name, input) {
  switch (name) {
    case "Read":
    case "Write":
    case "Edit":
      return input?.file_path || "";
    case "Bash":
      return input?.command || "";
    case "Glob":
      return input?.pattern || "";
    case "Grep":
      return input?.pattern || "";
    default:
      return "";
  }
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
  if (name === "Write") {
    return (
      <div>
        <div className="kv">{input?.file_path}</div>
        <DiffView raw={input?.content} />
      </div>
    );
  }
  if (name === "Glob" || name === "Grep") {
    return <pre>{JSON.stringify(input, null, 2)}</pre>;
  }
  return <pre>{JSON.stringify(input, null, 2)}</pre>;
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

export default function ToolCard({ block }) {
  const [open, setOpen] = useState(false);
  const { name, input, result, isError, pending } = block;
  const hasResult = result !== undefined;
  return (
    <div className="tool">
      <div className="head" onClick={() => setOpen((o) => !o)}>
        <span className="name">{name}</span>
        <span className="summary">{summarize(name, input)}</span>
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