import { Vec3 } from "../math/vec3.js";
import { Mat4 } from "../math/mat4.js";

export class Camera {
  position = new Vec3(6, 5, 8);
  target = new Vec3(0, 1, 0);
  up = Vec3.up();
  fovY = (60 * Math.PI) / 180;
  near = 0.1;
  far = 100;
  // orbit state
  yaw = Math.PI / 4;
  pitch = 0.5;
  dist = 10;

  updateOrbit(dx: number, dy: number) {
    this.yaw -= dx * 0.005;
    this.pitch += dy * 0.005;
    this.pitch = Math.max(0.1, Math.min(1.4, this.pitch));
  }

  follow(target: Vec3) {
    this.target.set(target.x, target.y + 1, target.z);
    this.position.set(
      this.target.x + Math.cos(this.yaw) * Math.cos(this.pitch) * this.dist,
      this.target.y + Math.sin(this.pitch) * this.dist,
      this.target.z + Math.sin(this.yaw) * Math.cos(this.pitch) * this.dist
    );
  }

  view(): Mat4 {
    return Mat4.lookAt(this.position, this.target, this.up);
  }

  projection(aspect: number): Mat4 {
    return Mat4.perspective(this.fovY, aspect, this.near, this.far);
  }
}
