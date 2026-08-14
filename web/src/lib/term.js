export function stripAnsi(s) {
  return String(s)
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b\][^\u0007]*\u0007/g, "")
    .replace(/\u001b[@-Z\\-_]/g, "");
}

export function createTerm() {
  return { lines: [], line: "", col: 0, replaceLine: false };
}

export function termWrite(term, raw) {
  const s = stripAnsi(raw);
  for (const ch of s) {
    if (ch === "\r") {
      term.col = 0;
      term.replaceLine = true;
      continue;
    }
    if (ch === "\n") {
      term.lines.push(term.line);
      if (term.lines.length > 8000) term.lines.splice(0, term.lines.length - 6000);
      term.line = "";
      term.col = 0;
      term.replaceLine = false;
      continue;
    }
    if (ch === "\b") {
      term.col = Math.max(0, term.col - 1);
      continue;
    }
    if (term.replaceLine && term.col === 0) {
      term.line = "";
      term.replaceLine = false;
    }
    if (term.col < term.line.length) {
      term.line = term.line.slice(0, term.col) + ch + term.line.slice(term.col + 1);
    } else {
      term.line += ch;
    }
    term.col += 1;
  }
}

export function termString(term) {
  return term.lines.concat(term.line).join("\n");
}

export function renderTerminal(raw) {
  const term = createTerm();
  termWrite(term, raw);
  return termString(term);
}

export function lastLines(text, n) {
  const parts = String(text).split("\n");
  return parts.slice(-n).join("\n");
}
