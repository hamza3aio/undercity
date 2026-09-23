import { Texture2D } from "../rendering/texture.js";
import { parseOBJ } from "../rendering/obj.js";
import type { MeshData } from "../rendering/mesh.js";

export class AssetLoader {
  private texCache = new Map<string, Texture2D>();
  private objCache = new Map<string, MeshData>();
  private jsonCache = new Map<string, unknown>();

  constructor(private gl: WebGL2RenderingContext) {}

  async loadTexture(id: string, url: string): Promise<Texture2D> {
    const cached = this.texCache.get(id);
    if (cached) return cached;
    const img = new Image();
    img.crossOrigin = "anonymous";
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("Failed to load texture: " + url));
      img.src = url;
    });
    const tex = new Texture2D(this.gl);
    tex.fromImage(img);
    this.texCache.set(id, tex);
    return tex;
  }

  async loadOBJ(id: string, url: string): Promise<MeshData> {
    const cached = this.objCache.get(id);
    if (cached) return cached;
    const res = await fetch(url);
    if (!res.ok) throw new Error("Failed to load OBJ: " + url);
    const data = parseOBJ(await res.text());
    this.objCache.set(id, data);
    return data;
  }

  async loadJSON<T = unknown>(id: string, url: string): Promise<T> {
    const cached = this.jsonCache.get(id) as T | undefined;
    if (cached) return cached;
    const res = await fetch(url);
    if (!res.ok) throw new Error("Failed to load JSON: " + url);
    const data = (await res.json()) as T;
    this.jsonCache.set(id, data);
    return data;
  }
}
