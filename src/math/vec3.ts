export class Vec3 {
  constructor(public x = 0, public y = 0, public z = 0) {}

  static zero() { return new Vec3(0, 0, 0); }
  static up() { return new Vec3(0, 1, 0); }

  clone() { return new Vec3(this.x, this.y, this.z); }
  set(x: number, y: number, z: number) { this.x = x; this.y = y; this.z = z; return this; }
  add(v: Vec3) { this.x += v.x; this.y += v.y; this.z += v.z; return this; }
  sub(v: Vec3) { this.x -= v.x; this.y -= v.y; this.z -= v.z; return this; }
  scale(s: number) { this.x *= s; this.y *= s; this.z *= s; return this; }
  length() { return Math.hypot(this.x, this.y, this.z); }
  normalize() { const l = this.length() || 1; return this.scale(1 / l); }
  dot(v: Vec3) { return this.x * v.x + this.y * v.y + this.z * v.z; }
  cross(v: Vec3) {
    return new Vec3(
      this.y * v.z - this.z * v.y,
      this.z * v.x - this.x * v.z,
      this.x * v.y - this.y * v.x
    );
  }
  toArray() { return [this.x, this.y, this.z] as const; }
}
