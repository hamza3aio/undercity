// Glitch proctex — procedural canvas textures (no external assets).
// Faces, cloth, brick, grass, asphalt, roof, water, wood. All original.

export type C3 = [number, number, number];

export function css(c: C3, a = 1): string {
  return `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${a})`;
}

export function shade(c: C3, f: number): C3 {
  return [Math.min(1, c[0] * f), Math.min(1, c[1] * f), Math.min(1, c[2] * f)];
}

export function makeCanvas(size: number, paint: (ctx: CanvasRenderingContext2D, s: number) => void): HTMLCanvasElement {
  const cv = document.createElement("canvas");
  cv.width = size; cv.height = size;
  const ctx = cv.getContext("2d")!;
  paint(ctx, size);
  return ctx.canvas;
}

export interface FaceOpts {
  skin: C3;
  eye: "round" | "happy" | "stern";
  mouth: "smile" | "smirk" | "flat" | "open";
  blush: boolean;
  beard: boolean;
}

// Cartoon face on 128px canvas. Maps onto all head-box faces; front (+z) is the money side.
export function paintFace(o: FaceOpts): HTMLCanvasElement {
  return makeCanvas(256, (ctx, s) => {
    ctx.fillStyle = css(o.skin);
    ctx.fillRect(0, 0, s, s);
    // soft side shading
    const grad = ctx.createLinearGradient(0, 0, s, 0);
    grad.addColorStop(0, "rgba(0,0,0,0.25)");
    grad.addColorStop(0.25, "rgba(0,0,0,0)");
    grad.addColorStop(0.75, "rgba(0,0,0,0)");
    grad.addColorStop(1, "rgba(0,0,0,0.25)");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, s, s);

    const ink = "#1c1410";
    // brows
    ctx.fillStyle = ink;
    if (o.eye === "stern") {
      ctx.save(); ctx.translate(34, 40); ctx.rotate(0.35); ctx.fillRect(-14, -3, 28, 6); ctx.restore();
      ctx.save(); ctx.translate(94, 40); ctx.rotate(-0.35); ctx.fillRect(-14, -3, 28, 6); ctx.restore();
    } else {
      ctx.fillRect(22, 34, 26, 6);
      ctx.fillRect(80, 34, 26, 6);
    }
    // eyes
    const eyeY = o.eye === "happy" ? 56 : 54;
    for (const ex of [36, 92]) {
      if (o.eye === "happy") {
        ctx.strokeStyle = ink; ctx.lineWidth = 5;
        ctx.beginPath(); ctx.arc(ex, eyeY + 4, 9, Math.PI, 0); ctx.stroke();
      } else {
        ctx.fillStyle = "#fff";
        ctx.beginPath(); ctx.ellipse(ex, eyeY, 11, 13, 0, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = ink;
        ctx.beginPath(); ctx.arc(ex, eyeY + 2, 5.5, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = "#fff";
        ctx.beginPath(); ctx.arc(ex - 2, eyeY, 2, 0, Math.PI * 2); ctx.fill();
      }
    }
    // nose
    ctx.strokeStyle = "rgba(0,0,0,0.45)"; ctx.lineWidth = 4;
    ctx.beginPath(); ctx.moveTo(64, 62); ctx.lineTo(60, 76); ctx.stroke();
    // blush
    if (o.blush) {
      ctx.fillStyle = "rgba(255,120,140,0.4)";
      ctx.beginPath(); ctx.arc(24, 84, 9, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(104, 84, 9, 0, Math.PI * 2); ctx.fill();
    }
    // mouth
    ctx.strokeStyle = ink; ctx.fillStyle = ink; ctx.lineWidth = 5;
    if (o.mouth === "smile") {
      ctx.beginPath(); ctx.arc(64, 88, 16, 0.25, Math.PI - 0.25); ctx.stroke();
    } else if (o.mouth === "smirk") {
      ctx.beginPath(); ctx.moveTo(48, 96); ctx.quadraticCurveTo(72, 100, 84, 88); ctx.stroke();
    } else if (o.mouth === "open") {
      ctx.beginPath(); ctx.ellipse(64, 96, 10, 12, 0, 0, Math.PI * 2); ctx.fill();
    } else {
      ctx.beginPath(); ctx.moveTo(50, 96); ctx.lineTo(78, 96); ctx.stroke();
    }
    // beard
    if (o.beard) {
      ctx.fillStyle = "rgba(40,26,18,0.9)";
      ctx.beginPath();
      ctx.moveTo(28, 84); ctx.quadraticCurveTo(64, 132, 100, 84);
      ctx.lineTo(100, 108); ctx.quadraticCurveTo(64, 140, 28, 108);
      ctx.closePath(); ctx.fill();
    }
  });
}

export function paintShirt(base: C3, trim: C3): HTMLCanvasElement {
  return makeCanvas(256, (ctx, s) => {
    ctx.fillStyle = css(base);
    ctx.fillRect(0, 0, s, s);
    // fabric folds
    ctx.fillStyle = "rgba(0,0,0,0.12)";
    for (let i = 0; i < 5; i++) ctx.fillRect(12 + i * 24, 0, 5, s);
    // collar V
    ctx.fillStyle = css(shade(trim, 0.9));
    ctx.beginPath();
    ctx.moveTo(44, 0); ctx.lineTo(64, 30); ctx.lineTo(84, 0);
    ctx.lineTo(84, 10); ctx.lineTo(64, 40); ctx.lineTo(44, 10);
    ctx.closePath(); ctx.fill();
    // buttons
    ctx.fillStyle = css(shade(trim, 0.7));
    for (let y = 48; y < s; y += 20) {
      ctx.beginPath(); ctx.arc(64, y, 4, 0, Math.PI * 2); ctx.fill();
    }
    // pocket
    ctx.strokeStyle = css(shade(base, 0.6)); ctx.lineWidth = 3;
    ctx.strokeRect(84, 52, 24, 26);
  });
}

export function paintBrick(base: C3): HTMLCanvasElement {
  return makeCanvas(256, (ctx, s) => {
    ctx.fillStyle = css(shade(base, 0.55));
    ctx.fillRect(0, 0, s, s);
    const bh = 16, bw = 32;
    for (let y = 0, row = 0; y < s; y += bh, row++) {
      for (let x = row % 2 ? -bw / 2 : 0; x < s; x += bw) {
        const v = 0.9 + Math.random() * 0.2;
        ctx.fillStyle = css(shade(base, v));
        ctx.fillRect(x + 1, y + 1, bw - 2, bh - 2);
      }
    }
  });
}

export function paintGrass(): HTMLCanvasElement {
  return makeCanvas(256, (ctx, s) => {
    ctx.fillStyle = "#2c5a24";
    ctx.fillRect(0, 0, s, s);
    for (let i = 0; i < 900; i++) {
      const g = 70 + Math.random() * 60;
      ctx.fillStyle = `rgb(${30 + Math.random() * 30},${g},${25 + Math.random() * 25})`;
      ctx.fillRect(Math.random() * s, Math.random() * s, 2, 2 + Math.random() * 3);
    }
  });
}

export function paintAsphalt(): HTMLCanvasElement {
  return makeCanvas(256, (ctx, s) => {
    ctx.fillStyle = "#26262b";
    ctx.fillRect(0, 0, s, s);
    for (let i = 0; i < 700; i++) {
      const v = 28 + Math.random() * 30;
      ctx.fillStyle = `rgb(${v},${v},${v + 4})`;
      ctx.fillRect(Math.random() * s, Math.random() * s, 2, 2);
    }
  });
}

export function paintRoof(base: C3): HTMLCanvasElement {
  return makeCanvas(256, (ctx, s) => {
    ctx.fillStyle = css(base);
    ctx.fillRect(0, 0, s, s);
    for (let y = 0; y < s; y += 16) {
      ctx.fillStyle = "rgba(0,0,0,0.3)";
      ctx.fillRect(0, y, s, 3);
      ctx.fillStyle = "rgba(255,255,255,0.08)";
      ctx.fillRect(0, y + 3, s, 2);
    }
  });
}

export function paintWater(): HTMLCanvasElement {
  return makeCanvas(256, (ctx, s) => {
    ctx.fillStyle = "#1d4e6b";
    ctx.fillRect(0, 0, s, s);
    for (let i = 0; i < 40; i++) {
      ctx.fillStyle = `rgba(140,200,230,${0.08 + Math.random() * 0.15})`;
      const y = Math.random() * s;
      ctx.fillRect(Math.random() * s, y, 20 + Math.random() * 40, 2);
    }
  });
}

export function paintWood(): HTMLCanvasElement {
  return makeCanvas(256, (ctx, s) => {
    ctx.fillStyle = "#6b4a2c";
    ctx.fillRect(0, 0, s, s);
    for (let x = 0; x < s; x += 18) {
      ctx.fillStyle = "rgba(0,0,0,0.35)";
      ctx.fillRect(x, 0, 2, s);
      ctx.strokeStyle = "rgba(0,0,0,0.2)";
      for (let i = 0; i < 4; i++) {
        ctx.beginPath();
        ctx.moveTo(x + 3, Math.random() * s);
        ctx.bezierCurveTo(x + 8, Math.random() * s, x + 10, Math.random() * s, x + 15, Math.random() * s);
        ctx.stroke();
      }
    }
  });
}

// Sign board with painted original text (shop names, street signs).
export function paintSign(text: string, bg: C3, fg: C3): HTMLCanvasElement {
  return makeCanvas(256, (ctx, s) => {
    ctx.fillStyle = css(bg);
    ctx.fillRect(0, 0, s, s * 0.5);
    ctx.fillStyle = css(shade(bg, 0.7));
    ctx.fillRect(0, s * 0.5, s, s * 0.5);
    ctx.strokeStyle = css(fg);
    ctx.lineWidth = 6;
    ctx.strokeRect(8, 8, s - 16, s - 16);
    ctx.fillStyle = css(fg);
    ctx.font = `900 ${Math.min(44, Math.floor(s * 2.2 / Math.max(4, text.length)))}px system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text.toUpperCase(), s / 2, s / 2);
  });
}

// Deterministic pseudo-random (mulberry32) — same seed, same texture.
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Tangent-space noise normal map from value noise + Sobel. strength scales
// bump depth. Deterministic per seed (unlike the Math.random() painters).
export function paintNoiseNormal(size = 128, seed = 7, strength = 2): HTMLCanvasElement {
  const grid = 16;
  const rnd = mulberry32(seed);
  const vals: number[] = [];
  for (let i = 0; i < grid * grid; i++) vals.push(rnd());
  const sample = (x: number, y: number): number => {
    const gx = ((x % 1) + 1) % 1 * (grid - 1);
    const gy = ((y % 1) + 1) % 1 * (grid - 1);
    const x0 = Math.floor(gx), y0 = Math.floor(gy);
    const x1 = Math.min(grid - 1, x0 + 1), y1 = Math.min(grid - 1, y0 + 1);
    const fx = gx - x0, fy = gy - y0;
    const v00 = vals[y0 * grid + x0], v10 = vals[y0 * grid + x1];
    const v01 = vals[y1 * grid + x0], v11 = vals[y1 * grid + x1];
    return v00 * (1 - fx) * (1 - fy) + v10 * fx * (1 - fy) + v01 * (1 - fx) * fy + v11 * fx * fy;
  };
  const cv = document.createElement("canvas");
  cv.width = size;
  cv.height = size;
  const ctx = cv.getContext("2d")!;
  const img = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (sample((x + 1) / size, y / size) - sample((x - 1) / size, y / size)) * strength;
      const dy = (sample(x / size, (y + 1) / size) - sample(x / size, (y - 1) / size)) * strength;
      const inv = 1 / Math.hypot(dx, dy, 1);
      const i = (y * size + x) * 4;
      img.data[i] = Math.round((-dx * inv * 0.5 + 0.5) * 255);
      img.data[i + 1] = Math.round((-dy * inv * 0.5 + 0.5) * 255);
      img.data[i + 2] = Math.round(inv * 255);
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return cv;
}
