// Glitch sky — time-of-day atmosphere palette.
// Drives background color, distance fog, sun strength and lamp levels.

export interface SkyFrame {
  sky: [number, number, number];
  fog: [number, number, number];
  sunI: number;
  lamp: number; // 0..1 lamp intensity factor
  sunColor: [number, number, number];
  sunElev: number; // -1..1, below 0 = moon up instead
}

interface Stop { h: number; sky: SkyFrame; }

const NIGHT: SkyFrame = { sky: [0.02, 0.03, 0.06], fog: [0.03, 0.045, 0.075], sunI: 0.55, lamp: 1.0, sunColor: [0.75, 0.82, 0.95], sunElev: -0.4 };
const DAWN: SkyFrame = { sky: [0.72, 0.48, 0.34], fog: [0.68, 0.53, 0.42], sunI: 1.0, lamp: 0.3, sunColor: [1.0, 0.72, 0.45], sunElev: 0.12 };
const DAY: SkyFrame = { sky: [0.36, 0.5, 0.68], fog: [0.55, 0.6, 0.68], sunI: 1.2, lamp: 0, sunColor: [1.0, 0.95, 0.85], sunElev: 0.8 };
const DUSK: SkyFrame = { sky: [0.82, 0.48, 0.28], fog: [0.7, 0.5, 0.37], sunI: 1.0, lamp: 0.5, sunColor: [1.0, 0.6, 0.32], sunElev: 0.1 };

const STOPS: Stop[] = [
  { h: 0, sky: NIGHT }, { h: 4.5, sky: NIGHT }, { h: 6.5, sky: DAWN },
  { h: 9, sky: DAY }, { h: 16, sky: DAY }, { h: 18.5, sky: DUSK },
  { h: 20.5, sky: NIGHT }, { h: 24, sky: NIGHT },
];

function mix3(a: [number, number, number], b: [number, number, number], t: number): [number, number, number] {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

export function skyAt(hour: number): SkyFrame {
  const h = ((hour % 24) + 24) % 24;
  let prev = STOPS[0];
  for (let i = 1; i < STOPS.length; i++) {
    if (h <= STOPS[i].h) {
      const next = STOPS[i];
      const t = (h - prev.h) / Math.max(0.001, next.h - prev.h);
      const a = prev.sky, b = next.sky;
      return {
        sky: mix3(a.sky, b.sky, t),
        fog: mix3(a.fog, b.fog, t),
        sunI: a.sunI + (b.sunI - a.sunI) * t,
        lamp: a.lamp + (b.lamp - a.lamp) * t,
        sunColor: mix3(a.sunColor, b.sunColor, t),
        sunElev: a.sunElev + (b.sunElev - a.sunElev) * t,
      };
    }
    prev = STOPS[i];
  }
  return STOPS[STOPS.length - 1].sky;
}
