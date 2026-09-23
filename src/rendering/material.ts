export interface Material {
  color: [number, number, number];
  textureId?: string; // key into Renderer.textures; undefined = untextured
  shininess: number;
  uvScale: number;
}

export function makeMaterial(
  color: [number, number, number],
  opts: Partial<Material> = {}
): Material {
  return {
    color,
    shininess: 32,
    uvScale: 1,
    ...opts,
  };
}
