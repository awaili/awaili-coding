// Tiny line-based diff view for Edit/Write tool inputs.
function diffLines(oldStr, newStr) {
  const oldL = (oldStr ?? "").split("\n");
  const newL = (newStr ?? "").split("\n");
  const out = [];
  // Use a simple LCS-free approach: show removed then added blocks.
  // Good enough for typical Edit old/new strings.
  const max = Math.max(oldL.length, newL.length);
  let i = 0;
  while (i < max) {
    if (oldL[i] !== undefined && newL[i] !== undefined && oldL[i] === newL[i]) {
      out.push({ t: "ctx", s: oldL[i] });
    } else {
      if (oldL[i] !== undefined) out.push({ t: "del", s: oldL[i] });
      if (newL[i] !== undefined) out.push({ t: "add", s: newL[i] });
    }
    i++;
  }
  return out;
}

export default function DiffView({ oldStr, newStr, raw }) {
  const lines = raw ? [{ t: "ctx", s: raw }] : diffLines(oldStr, newStr);
  return (
    <div className="diff">
      {lines.map((l, i) => (
        <div key={i} className={l.t === "add" ? "add" : l.t === "del" ? "del" : ""}>
          {l.t === "add" ? "+ " : l.t === "del" ? "- " : "  "}
          {l.s}
        </div>
      ))}
    </div>
  );
}