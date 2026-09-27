// Glitch logging + debug console — one place every subsystem reports, so
// the editor can show *which system* failed. Pure data: the sink, the ring
// buffer, the level filters and the console command parser are all testable
// headless; only the DOM panel in editor/console.ts touches the document.
//
// Rules: errors are never swallowed, the buffer is bounded, and a sink
// error can never take down the caller (logging must not crash a game).

export type LogLevel = "log" | "info" | "warn" | "error";

export const LOG_LEVELS: LogLevel[] = ["log", "info", "warn", "error"];

export const LEVEL_RANK: Record<LogLevel, number> = { log: 0, info: 1, warn: 2, error: 3 };

export interface LogRecord {
  seq: number;
  time: number; // seconds since logger start
  level: LogLevel;
  /** Subsystem tag, e.g. "physics" or "scene". Empty for generic logs. */
  system: string;
  message: string;
  /** Structured payload (errors keep theirs; log lines drop it). */
  data?: unknown;
  stack?: string;
  count: number; // >1 when identical records were folded together
}

export type LogSink = (record: LogRecord) => void;

export interface LoggerOptions {
  capacity?: number;
  minLevel?: LogLevel;
  /** Injected clock in seconds; defaults to a monotonic performance clock. */
  clock?: () => number;
  /** Console mirror (defaults to the real console). */
  mirror?: boolean;
}

const DEFAULT_CAPACITY = 500;

export class Logger {
  private records: LogRecord[] = [];
  private sinks: LogSink[] = [];
  private seq = 0;
  private capacity: number;
  private minLevel: LogLevel;
  private clock: () => number;
  private mirror: boolean;
  /** Grouping key -> index in the buffer, for folded repeats. */
  private folding = new Map<string, number>();

  constructor(opts: LoggerOptions = {}) {
    this.capacity = Math.max(1, opts.capacity ?? DEFAULT_CAPACITY);
    this.minLevel = opts.minLevel ?? "log";
    this.clock = opts.clock ?? (() => (typeof performance !== "undefined" ? performance.now() : Date.now()) / 1000);
    this.mirror = opts.mirror ?? true;
  }

  get size(): number {
    return this.records.length;
  }

  setMinLevel(level: LogLevel): void {
    this.minLevel = level;
  }

  addSink(fn: LogSink): () => void {
    this.sinks.push(fn);
    return () => {
      const i = this.sinks.indexOf(fn);
      if (i >= 0) this.sinks.splice(i, 1);
    };
  }

  /** Records a message. Returns the stored record (folded or new). */
  write(level: LogLevel, system: string, message: string, data?: unknown, stack?: string): LogRecord | null {
    if (LEVEL_RANK[level] < LEVEL_RANK[this.minLevel]) return null;
    // Fold consecutive identical records so a per-frame error cannot flood
    // the buffer; the count keeps the information.
    const key = `${level}|${system}|${message}`;
    const at = this.folding.get(key);
    if (at !== undefined && this.records[at] && this.records[at].message === message) {
      const rec = this.records[at];
      rec.count++;
      return rec;
    }
    this.seq += 1;
    const rec: LogRecord = {
      seq: this.seq,
      time: this.clock(),
      level,
      system,
      message,
      data: level === "error" || level === "warn" ? data : undefined,
      stack,
      count: 1,
    };
    this.records.push(rec);
    this.folding.set(key, this.records.length - 1);
    while (this.records.length > this.capacity) {
      this.records.shift();
      // Re-index the fold map after a shift (bounded cost, tiny map).
      this.folding.clear();
      this.records.forEach((r, i) => this.folding.set(`${r.level}|${r.system}|${r.message}`, i));
    }
    for (const sink of this.sinks) {
      try {
        sink(rec);
      } catch {
        // A broken sink must never break the caller.
      }
    }
    if (this.mirror) this.toConsole(rec);
    return rec;
  }

  private toConsole(rec: LogRecord): void {
    if (typeof console === "undefined") return;
    const tag = rec.system ? `[${rec.system}]` : "";
    const msg = `${tag}${rec.message}`;
    try {
      if (rec.level === "error") console.error(msg, rec.data ?? "", rec.stack ?? "");
      else if (rec.level === "warn") console.warn(msg, rec.data ?? "");
      else if (rec.level === "info") console.info(msg);
      else console.log(msg);
    } catch {
      // console itself is not a dependency.
    }
  }

  log(system: string, message: string): LogRecord | null { return this.write("log", system, message); }
  info(system: string, message: string): LogRecord | null { return this.write("info", system, message); }
  warn(system: string, message: string, data?: unknown): LogRecord | null { return this.write("warn", system, message, data); }

  /** Errors keep their stack and structured data. */
  error(system: string, message: string, data?: unknown, err?: unknown): LogRecord | null {
    let stack: string | undefined;
    if (err instanceof Error) {
      stack = err.stack ?? `${err.name}: ${err.message}`;
      if (data === undefined) data = { name: err.name, message: err.message };
    } else if (typeof err === "string") {
      stack = err;
    }
    return this.write("error", system, message, data, stack);
  }

  /** Newest first, optionally filtered. */
  history(opts: { level?: LogLevel; system?: string; search?: string; limit?: number } = {}): LogRecord[] {
    let out = this.records;
    if (opts.level) {
      const min = LEVEL_RANK[opts.level];
      out = out.filter((r) => LEVEL_RANK[r.level] >= min);
    }
    if (opts.system) out = out.filter((r) => r.system === opts.system);
    if (opts.search) {
      const q = opts.search.toLowerCase();
      out = out.filter((r) => r.message.toLowerCase().includes(q) || r.system.toLowerCase().includes(q));
    }
    const reversed = [...out].reverse();
    return opts.limit ? reversed.slice(0, opts.limit) : reversed;
  }

  countOf(level?: LogLevel): number {
    if (!level) return this.records.length;
    const min = LEVEL_RANK[level];
    return this.records.filter((r) => LEVEL_RANK[r.level] >= min).length;
  }

  clear(): void {
    this.records.length = 0;
    this.folding.clear();
  }
}

// --- console commands (Phase 19 / command palette groundwork) ---

export interface CommandResult {
  ok: boolean;
  output: string;
}

export type CommandHandler = (args: string, raw: string) => CommandResult;

export class CommandRegistry {
  private map = new Map<string, CommandHandler>();

  register(name: string, handler: CommandHandler, aliases: string[] = []): void {
    this.map.set(name.toLowerCase(), handler);
    for (const a of aliases) this.map.set(a.toLowerCase(), handler);
  }

  names(): string[] {
    return [...new Set([...this.map.keys()])].sort();
  }

  has(name: string): boolean {
    return this.map.has(name.toLowerCase());
  }

  /** Runs a command line. Unknown commands and handler throws are reported. */
  run(line: string): CommandResult {
    const trimmed = line.trim();
    if (trimmed.length === 0) return { ok: false, output: "empty command" };
    const sp = trimmed.indexOf(" ");
    const name = (sp < 0 ? trimmed : trimmed.slice(0, sp)).toLowerCase();
    const args = sp < 0 ? "" : trimmed.slice(sp + 1).trim();
    const handler = this.map.get(name);
    if (!handler) return { ok: false, output: `unknown command "${name}" (try: ${this.names().join(", ")})` };
    try {
      return handler(args, trimmed);
    } catch (err) {
      return { ok: false, output: `command "${name}" threw: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
}

/** Splits a console line into tokens, honouring double quotes. */
export function tokenize(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (!inQuotes && /\s/.test(ch)) {
      if (cur.length > 0) {
        out.push(cur);
        cur = "";
      }
      continue;
    }
    cur += ch;
  }
  if (cur.length > 0) out.push(cur);
  return out;
}
