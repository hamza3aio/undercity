interface GlitchBridge {
  version(): Promise<string>;
  recents(): Promise<{ name: string; path: string; updatedAt: number }[]>;
  newProject(name: string): Promise<{ name: string; path: string }>;
  openSample(): Promise<boolean>;
  openProject(path: string): Promise<{ name: string; path: string }>;
  pickFolder(): Promise<string | null>;
  showInFolder(path: string): Promise<boolean>;
  readScene(path: string): Promise<{ project: string | null; scene: string | null }>;
  writeScene(path: string, scene: string): Promise<boolean>;
  onOpenProject(fn: (q: Record<string, string>) => void): void;
}

interface Window {
  glitch?: GlitchBridge;
}
