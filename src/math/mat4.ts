import { Vec3 } from "./vec3.js";

// Column-major 4x4, compatible with WebGL uniformMatrix4fv.
export class Mat4 {
  elements: Float32Array;

  constructor() {
    this.elements = new Float32Array(16);
    this.identity();
  }

  identity() {
    const e = this.elements;
    e.fill(0);
    e[0] = e[5] = e[10] = e[15] = 1;
    return this;
  }

  clone() {
    const m = new Mat4();
    m.elements.set(this.elements);
    return m;
  }

  multiply(b: Mat4) {
    const a = this.elements, c = b.elements;
    const out = new Float32Array(16);
    for (let col = 0; col < 4; col++) {
      for (let row = 0; row < 4; row++) {
        out[col * 4 + row] =
          a[0 * 4 + row] * c[col * 4 + 0] +
          a[1 * 4 + row] * c[col * 4 + 1] +
          a[2 * 4 + row] * c[col * 4 + 2] +
          a[3 * 4 + row] * c[col * 4 + 3];
      }
    }
    this.elements.set(out);
    return this;
  }

  static multiplied(a: Mat4, b: Mat4) {
    return a.clone().multiply(b);
  }

  translate(v: Vec3) {
    const t = new Mat4();
    t.elements[12] = v.x; t.elements[13] = v.y; t.elements[14] = v.z;
    return this.multiply(t);
  }

  scale(v: Vec3) {
    const s = new Mat4();
    s.elements[0] = v.x; s.elements[5] = v.y; s.elements[10] = v.z;
    return this.multiply(s);
  }

  rotateY(angle: number) {
    const r = new Mat4();
    const c = Math.cos(angle), s = Math.sin(angle);
    r.elements[0] = c; r.elements[2] = -s;
    r.elements[8] = s; r.elements[10] = c;
    return this.multiply(r);
  }

  rotateX(angle: number) {
    const r = new Mat4();
    const c = Math.cos(angle), s = Math.sin(angle);
    r.elements[5] = c; r.elements[6] = s;
    r.elements[9] = -s; r.elements[10] = c;
    return this.multiply(r);
  }

  static perspective(fovY: number, aspect: number, near: number, far: number) {
    const m = new Mat4();
    const e = m.elements;
    e.fill(0);
    const f = 1 / Math.tan(fovY / 2);
    e[0] = f / aspect;
    e[5] = f;
    e[10] = (far + near) / (near - far);
    e[11] = -1;
    e[14] = (2 * far * near) / (near - far);
    return m;
  }

  static lookAt(eye: Vec3, target: Vec3, up: Vec3) {
    const z = eye.clone().sub(target).normalize(); // camera forward (neg)
    const x = up.cross(z).normalize();
    const y = z.cross(x);
    const m = new Mat4();
    const e = m.elements;
    e[0] = x.x; e[1] = y.x; e[2] = z.x; e[3] = 0;
    e[4] = x.y; e[5] = y.y; e[6] = z.y; e[7] = 0;
    e[8] = x.z; e[9] = y.z; e[10] = z.z; e[11] = 0;
    e[12] = -x.dot(eye); e[13] = -y.dot(eye); e[14] = -z.dot(eye); e[15] = 1;
    return m;
  }

  static compose(position: Vec3, rotationY: number, scale: Vec3) {
    const m = new Mat4();
    m.translate(position);
    m.rotateY(rotationY);
    m.scale(scale);
    return m;
  }
}
