export class Input {
  keys = new Set<string>();
  pressed = new Set<string>();
  released = new Set<string>();
  dragDX = 0;
  dragDY = 0;
  wheelDY = 0;
  touches = new Map<number, { x: number; y: number }>();
  pointerLocked = false;
  private dragging = false;
  private lastX = 0;
  private lastY = 0;
  private lastTouch: { x: number; y: number } | null = null;
  private canvas: HTMLCanvasElement | null = null;
  // Stored handlers so attach() is reversible via detach().
  private handlers: { target: Window | HTMLCanvasElement | Document; type: string; fn: (e: Event) => void; opts?: AddEventListenerOptions }[] = [];

  private on<K extends Window | HTMLCanvasElement | Document>(
    target: K, type: string, fn: (e: never) => void, opts?: AddEventListenerOptions
  ) {
    const wrapped = (e: Event) => (fn as (e: Event) => void)(e);
    target.addEventListener(type, wrapped, opts);
    this.handlers.push({ target, type, fn: wrapped, opts });
  }

  attach(canvas: HTMLCanvasElement) {
    this.detach();
    this.canvas = canvas;
    this.on(window, "keydown", (e: KeyboardEvent) => {
      if (!e.repeat) this.pressed.add(e.code);
      this.keys.add(e.code);
      if (["Space", "ArrowUp", "ArrowDown"].includes(e.code)) e.preventDefault();
    });
    this.on(window, "keyup", (e: KeyboardEvent) => {
      this.keys.delete(e.code);
      this.released.add(e.code);
    });
    this.on(window, "blur", () => {
      this.keys.clear();
      this.pressed.clear();
      this.released.clear();
    });
    this.on(canvas, "pointerdown", (e: PointerEvent) => {
      this.dragging = true;
      this.lastX = e.clientX; this.lastY = e.clientY;
      try { canvas.setPointerCapture(e.pointerId); } catch { /* already released */ }
    });
    this.on(canvas, "pointermove", (e: PointerEvent) => {
      if (this.pointerLocked && document.pointerLockElement === canvas) {
        this.dragDX += e.movementX ?? 0;
        this.dragDY += e.movementY ?? 0;
        return;
      }
      if (!this.dragging) return;
      this.dragDX += e.clientX - this.lastX;
      this.dragDY += e.clientY - this.lastY;
      this.lastX = e.clientX; this.lastY = e.clientY;
    });
    const end = () => { this.dragging = false; };
    this.on(canvas, "pointerup", end);
    this.on(canvas, "pointercancel", end);
    this.on(document, "pointerlockchange", () => {
      this.pointerLocked = document.pointerLockElement === canvas;
    });
    this.on(canvas, "wheel", (e: WheelEvent) => {
      this.wheelDY += e.deltaY;
    }, { passive: true });
    // Touch foundations: tracked per-id; single-finger drag orbits like a mouse.
    this.on(canvas, "touchstart", (e: TouchEvent) => {
      for (let i = 0; i < e.changedTouches.length; i++) {
        const t = e.changedTouches[i];
        this.touches.set(t.identifier, { x: t.clientX, y: t.clientY });
      }
      if (e.touches.length === 1) {
        const t = e.touches[0];
        this.lastTouch = { x: t.clientX, y: t.clientY };
      }
    }, { passive: true });
    this.on(canvas, "touchmove", (e: TouchEvent) => {
      for (let i = 0; i < e.changedTouches.length; i++) {
        const t = e.changedTouches[i];
        this.touches.set(t.identifier, { x: t.clientX, y: t.clientY });
      }
      if (e.touches.length === 1 && this.lastTouch) {
        const t = e.touches[0];
        this.dragDX += t.clientX - this.lastTouch.x;
        this.dragDY += t.clientY - this.lastTouch.y;
        this.lastTouch = { x: t.clientX, y: t.clientY };
      }
    }, { passive: true });
    const touchEnd = (e: TouchEvent) => {
      for (let i = 0; i < e.changedTouches.length; i++) {
        this.touches.delete(e.changedTouches[i].identifier);
      }
      if (e.touches.length === 0) this.lastTouch = null;
    };
    this.on(canvas, "touchend", touchEnd);
    this.on(canvas, "touchcancel", touchEnd);
  }

  detach() {
    for (const h of this.handlers) {
      h.target.removeEventListener(h.type, h.fn, h.opts);
    }
    this.handlers = [];
    this.canvas = null;
    this.dragging = false;
    this.lastTouch = null;
  }

  requestPointerLock(): void {
    if (!this.canvas) return;
    const p = this.canvas.requestPointerLock() as unknown as Promise<void> | undefined;
    if (p && typeof p.catch === "function") p.catch(() => undefined);
  }

  exitPointerLock(): void {
    if (document.pointerLockElement) document.exitPointerLock();
  }

  down(code: string) { return this.keys.has(code); }

  axis(neg: string, pos: string) {
    return (this.down(pos) ? 1 : 0) - (this.down(neg) ? 1 : 0);
  }

  consumeDrag() {
    const d = { dx: this.dragDX, dy: this.dragDY };
    this.dragDX = 0; this.dragDY = 0;
    return d;
  }

  consumeWheel() {
    const d = this.wheelDY;
    this.wheelDY = 0;
    return d;
  }

  // Called once per render frame (Engine wires this via GameLoop's frameEnd
  // hook). Clears edge state; held keys and unconsumed drag/wheel persist.
  endFrame() {
    this.pressed.clear();
    this.released.clear();
  }
}
