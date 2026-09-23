// Glitch main menu — original UNDERCITY presentation.
// Backdrop is the live 3D city (slow orbit); menu is DOM on top.

function el(id: string): HTMLElement {
  const e = document.getElementById(id);
  if (!e) throw new Error("missing #" + id);
  return e;
}

export interface MenuHooks {
  onContinue(): void;
  onNew(): void;
  onSettings(): void;
  onCredits(): void;
  onQuit(): void;
}

export class MainMenu {
  constructor(private hooks: MenuHooks) {
    const btn = (id: string, fn: () => void) => {
      el(id).addEventListener("click", fn);
    };
    btn("m-continue", () => hooks.onContinue());
    btn("m-new", () => hooks.onNew());
    btn("m-settings", () => hooks.onSettings());
    btn("m-credits", () => hooks.onCredits());
    btn("m-quit", () => hooks.onQuit());
  }

  show(hasSave: boolean, version: string, playersNote: string) {
    el("m-version").textContent = version;
    (el("m-continue") as HTMLButtonElement).disabled = !hasSave;
    el("m-note").textContent = playersNote;
    el("menu").style.display = "flex";
    document.body.classList.add("in-menu");
  }

  hide() {
    el("menu").style.display = "none";
    document.body.classList.remove("in-menu");
  }

  get visible(): boolean {
    return el("menu").style.display !== "none";
  }
}
