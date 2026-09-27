interface GlitchBridge {
  version(): Promise<string>;
  hostInfo(): Promise<{
    platform: string; arch: string; electron: string; chrome: string; node: string;
  }>;
  readBuildSettings(path: string): Promise<unknown | null>;
  writeBuildSettings(path: string, settings: unknown): Promise<boolean>;
  recents(): Promise<{ name: string; path: string; updatedAt: number }[]>;
  newProject(name: string): Promise<{ name: string; path: string }>;
  openSample(): Promise<boolean>;
  openProject(path: string): Promise<{ name: string; path: string }>;
  pickFolder(): Promise<string | null>;
  showInFolder(path: string): Promise<boolean>;
  readScene(path: string): Promise<{ project: string | null; scene: string | null }>;
  writeScene(path: string, scene: string): Promise<boolean>;
  readPlugins(): Promise<{ dir: string; manifest?: unknown; entry?: string | null; error?: string }[]>;
  writePlugin(dir: string, manifest: unknown, entry?: string): Promise<{ dir: string }>;
  onOpenProject(fn: (q: Record<string, string>) => void): void;
}

interface Window {
  glitch?: GlitchBridge;
}
