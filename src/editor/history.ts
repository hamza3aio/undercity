// Glitch history — command-pattern undo/redo. Pure logic (no World import),
// so editor commands and tests share it. Redo is truncated by new work.

export interface Command {
  label: string;
  do(): void;
  undo(): void;
}

export class History {
  private undoStack: Command[] = [];
  private redoStack: Command[] = [];
  private cap: number;

  constructor(cap = 100) {
    this.cap = Math.max(1, cap);
  }

  get depth(): number {
    return this.undoStack.length;
  }

  get redoDepth(): number {
    return this.redoStack.length;
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  labels(): string[] {
    return this.undoStack.map((c) => c.label);
  }

  execute(cmd: Command): void {
    cmd.do();
    this.undoStack.push(cmd);
    if (this.undoStack.length > this.cap) this.undoStack.shift();
    this.redoStack.length = 0;
  }

  undo(): string | null {
    const cmd = this.undoStack.pop();
    if (!cmd) return null;
    cmd.undo();
    this.redoStack.push(cmd);
    return cmd.label;
  }

  redo(): string | null {
    const cmd = this.redoStack.pop();
    if (!cmd) return null;
    cmd.do();
    this.undoStack.push(cmd);
    return cmd.label;
  }

  clear(): void {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
  }
}
