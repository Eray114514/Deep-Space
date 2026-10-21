import { BufferGeometry, Float32BufferAttribute, Mesh, OrthographicCamera } from 'three';

const camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);

// Same triangle/UV/projection as the vendored FullScreenQuad, but the temporary
// producer owns this geometry. Disposing a completed cache must not invalidate
// the buffers/VAOs of still-live receiver, resolve and composer passes.
export class OwnedScreenTriangle {
  constructor(material) {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute([-1, 3, 0, -1, -1, 0, 3, -1, 0], 3));
    geometry.setAttribute('uv', new Float32BufferAttribute([0, 2, 0, 0, 2, 0], 2));
    this._mesh = new Mesh(geometry, material);
  }
  render(renderer) { renderer.render(this._mesh, camera); }
  dispose() { this._mesh.geometry.dispose(); }
  get material() { return this._mesh.material; }
  set material(value) { this._mesh.material = value; }
}
