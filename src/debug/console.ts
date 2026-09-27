// Glitch debug console — DOM panel for Logger + CommandRegistry.
// The data model lives in debug/logger.ts (headless-testable); this file
// is only the view. Kept separate from the editor overlay so the console
// can be opened in a plain game, not just in the editor.

import { LEVEL_RANK, LOG_LEVELS, tokenize, type CommandRegistry, type LogLevel, type LogRecord, type Logger } from "./logger.js";

export interface ConsoleView {
  root: HTMLElement;
  refresh(): void;
  destroy(): void;
}

const STYLE = `
position:absolute;left:12px;bottom:12px;width:min(680px,60vw);max-height:42vh;display:flex;flex-direction:column;
background:rgba(8,11,18,0.94);border:1px solid #2dd4bf;border-radius:8px;z-index:30;
font:12px/1.45 ui-monospace,Menlo,Consolas,monospace;color:#d6e2f0;overflow:hidden`;

export function mountConsole(
  parent: HTMLElement,
  log: Logger,
  commands: CommandRegistry,
  opts: { onOpen?: () => void } = {}
): ConsoleView {
  const root = document.createElement("div");
  root.style.cssText = STYLE;

  const bar = document.createElement("div");
  bar.style.cssText = "display:flex;gap:6px;align-items:center;padding:6px 8px;border-bottom:1px solid #1e293b;flex-wrap:wrap";
  root.appendChild(bar);

  const filter = document.createElement("select");
  filter.style.cssText = "background:#0f172a;color:#fff;border:1px solid #475569;border-radius:4px;padding:2px 4px";
  for (const lv of LOG_LEVELS) {
    const o = document.createElement("option");
    o.value = lv;
    o.textContent = lv;
    if (lv === "log") o.selected = true;
    filter.appendChild(o);
  }
  bar.appendChild(filter);

  const search = document.createElement("input");
  search.type = "search";
  search.placeholder = "filter text…";
  search.style.cssText = "background:#0f172a;color:#fff;border:1px solid #475569;border-radius:4px;padding:2px 6px;flex:1;min-width:80px";
  bar.appendChild(search);

  const counts = document.createElement("span");
  counts.style.cssText = "opacity:0.7;white-space:nowrap";
  bar.appendChild(counts);

  const clearBtn = document.createElement("button");
  clearBtn.textContent = "clear";
  clearBtn.style.cssText = "background:#1e293b;color:#fff;border:1px solid #475569;border-radius:4px;padding:2px 8px;cursor:pointer";
  clearBtn.onclick = () => {
    log.clear();
    refresh();
  };
  bar.appendChild(clearBtn);

  const closeBtn = document.createElement("button");
  closeBtn.textContent = "×";
  closeBtn.style.cssText = "background:#1e293b;color:#fff;border:1px solid #475569;border-radius:4px;padding:2px 8px;cursor:pointer";
  closeBtn.onclick = () => view.destroy();
  bar.appendChild(closeBtn);

  const list = document.createElement("div");
  list.style.cssText = "flex:1;overflow:auto;padding:4px 8px;white-space:pre-wrap;word-break:break-word";
  root.appendChild(list);

  const inputRow = document.createElement("div");
  inputRow.style.cssText = "display:flex;gap:6px;padding:6px 8px;border-top:1px solid #1e293b;align-items:center";
  const prompt = document.createElement("span");
  prompt.textContent = ">";
  prompt.style.cssText = "color:#2dd4bf";
  inputRow.appendChild(prompt);
  const input = document.createElement("input");
  input.type = "text";
  input.style.cssText = "flex:1;background:#0f172a;color:#fff;border:1px solid #475569;border-radius:4px;padding:3px 6px";
  inputRow.appendChild(input);
  const help = document.createElement("span");
  help.style.cssText = "opacity:0.6;white-space:nowrap";
  inputRow.appendChild(help);
  root.appendChild(inputRow);

  parent.appendChild(root);

  const fmtTime = (t: number): string => `${t.toFixed(2)}s`;
  const lineFor = (r: LogRecord): string => {
    const tag = r.system ? `[${r.system}]` : "";
    const times = r.count > 1 ? ` x${r.count}` : "";
    return `${fmtTime(r.time)} ${r.level.toUpperCase().padEnd(5)} ${tag}${r.message}${times}`;
  };

  const render = () => {
    const minLevel = (filter.value as LogLevel) ?? "log";
    const records = log.history({
      level: minLevel,
      search: search.value.trim() || undefined,
    });
    const parts: string[] = [];
    for (const r of records) {
      const color = r.level === "error" ? "#f87171" : r.level === "warn" ? "#fbbf24" : r.level === "info" ? "#7dd3fc" : "#cbd5e1";
      parts.push(`<div style="color:${color}">${escapeHtml(lineFor(r))}</div>`);
      if (r.level === "error" || r.level === "warn") {
        if (r.stack) parts.push(`<div style="opacity:0.65;padding-left:12px">${escapeHtml(shortStack(r.stack))}</div>`);
        if (r.data !== undefined) {
          parts.push(`<div style="opacity:0.65;padding-left:12px">${escapeHtml(safeJson(r.data))}</div>`);
        }
      }
    }
    if (records.length === 0) parts.push(`<div style="opacity:0.5">no records</div>`);
    list.innerHTML = parts.join("");
    counts.textContent = `${records.length} shown · ${log.size} buffered · ${log.countOf("error")} err`;
    help.textContent = `cmds: ${commands.names().slice(0, 6).join(" ")}`;
  };

  let dirty = true;
  const refresh = () => {
    if (!dirty) return;
    dirty = false;
    render();
  };
  const mark = () => {
    dirty = true;
  };
  const removeSink = log.addSink(mark);
  filter.onchange = () => {
    log.setMinLevel(filter.value as LogLevel);
    mark();
    refresh();
  };
  search.oninput = () => {
    mark();
    refresh();
  };
  input.onkeydown = (e) => {
    if ((e as KeyboardEvent).key !== "Enter") return;
    const line = input.value;
    input.value = "";
    const toks = tokenize(line);
    if (toks.length === 0) return;
    const name = toks[0];
    if (commands.has(name)) {
      const res = commands.run(line);
      log.write(res.ok ? "info" : "error", "console", `> ${line}\n${res.output}`);
    } else {
      log.error("console", `unknown command "${name}" (try: ${commands.names().join(", ")})`);
    }
    mark();
    refresh();
  };

  // Poll instead of hooking DOM mutations: cheap, and the panel is hidden
  // most of the time.
  const timer = window.setInterval(refresh, 250);
  mark();
  refresh();

  const view: ConsoleView = {
    root,
    refresh: () => {
      mark();
      refresh();
    },
    destroy: () => {
      window.clearInterval(timer);
      removeSink();
      root.remove();
      opts.onOpen?.();
    },
  };
  return view;
}
function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&quot;"));
}

function safeJson(v: unknown): string {
  if (v instanceof Error) return `${v.name}: ${v.message}`;
  try {
    const s = JSON.stringify(v);
    return s === undefined ? String(v) : s.length > 400 ? `${s.slice(0, 400)}…` : s;
  } catch {
    return String(v);
  }
}

// First three frames of a stack, dedented - enough to find the subsystem.
function shortStack(stack: string): string {
  return stack.split("\n").slice(0, 3).map((l) => l.trim()).join("\n");
}

export { LEVEL_RANK };
