// Parametric interior surface — ported 1:1 from
// 3aaa-spaceship-flight-prototype/src/game/ship/surface.ts
// (types stripped only; logic, constants and comments unchanged).
import * as THREE from 'three';
import { sampleSection, sectionAt, RING } from '../loft.js';

/* ------------------------------------------------------------------ *
 *  PARAMETRIC INTERIOR SURFACE
 *
 *  WHY THIS EXISTS
 *
 *  The old cockpit placed every fitting with hand-tuned absolute
 *  constants — `mat(1.26, 0.86, -8.94, -0.72, -0.5, 0)` and eighty more
 *  like it — and its header declared an eye point of (0, 1.45, -7.62)
 *  while blueprint.ts says eyeY 1.50 / eyeZ -7.70.  The geometry was laid
 *  out against a datum that had since moved, so nothing agreed with
 *  anything: panels, consoles and canopy frames interpenetrated, which is
 *  the reported "乱成一团一堆穿模".
 *
 *  No amount of re-tuning fixes that class of problem, because the next
 *  change to the hull breaks it again.  What fixes it is deriving every
 *  fitting from ONE shared surface, so contact is a property of the
 *  construction rather than of the numbers.  This project already does
 *  exactly that for the exterior livery — buildLoft() with a small normal
 *  `offset`, which "can never float, gap or z-fight" — and this is the
 *  same discipline for the inside.
 *
 *  PARAMETERISATION.  A point is (z, ri):
 *    z   metres along the ship, so it reads directly against blueprint.ts
 *    ri  FRACTIONAL ring index, 0..RING, the same index space buildLoft
 *        and the EDGES_* tables use — so `isTopEdge`-style reasoning and
 *        this module talk about the same places on the hull.
 *
 *  Everything else (normal, tangents, a placement matrix) is derived by
 *  finite differences off those two, the way
 *  high-fidelity-spaceship-cockpit's shell.ts does it.
 * ------------------------------------------------------------------ */

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _d = new THREE.Vector3();

export class Surf {
  /**
   * @param {SectionSpec[]} sections the loft this surface follows (HULL or CABIN)
   * @param {number} inset metres to move inward — the wall thickness.  0 gives the
   *                 outer skin, 0.14 matches the liner shell in interior.js.
   */
  constructor(sections, inset = 0) {
    this.sections = sections;
    this.inset = inset;
    this.cache = new Map();
  }

  /** cached ring sample; z is quantised to 1 mm so lookups actually hit */
  ring(z) {
    const k = Math.round(z * 1000);
    let r = this.cache.get(k);
    if (!r) this.cache.set(k, (r = sampleSection(sectionAt(this.sections, k / 1000))));
    return r;
  }

  /** section half-width / heights at z, for sizing parts against the hull */
  section(z) {
    return sectionAt(this.sections, z);
  }

  /**
   * Point on the surface.
   *
   * `off` is measured along the local outward normal, so a positive value is
   * further from the axis.  Interior fittings use small positive values to sit
   * ON the liner rather than inside it.
   */
  pt(z, ri, off = 0, target = new THREE.Vector3()) {
    const ring = this.ring(z);
    const i0 = Math.floor(ri);
    const f = ri - i0;
    const a = ring[((i0 % RING) + RING) % RING];
    const b = ring[(((i0 + 1) % RING) + RING) % RING];
    const x = a.x + (b.x - a.x) * f;
    const y = a.y + (b.y - a.y) * f;
    target.set(x, y, z);
    if (this.inset !== 0 || off !== 0) {
      this.n2(z, ri, _d);
      target.x += _d.x * (off - this.inset);
      target.y += _d.y * (off - this.inset);
    }
    return target;
  }

  /** in-section 2-D outward normal (z component always 0) */
  n2(z, ri, target) {
    const ring = this.ring(z);
    const i = Math.round(ri);
    const p = ring[(((i - 1) % RING) + RING) % RING];
    const q = ring[(((i + 1) % RING) + RING) % RING];
    const tx = q.x - p.x, ty = q.y - p.y;
    /* rotate the tangent by -90 degrees: rings run counter-clockwise in the
       x/y plane, so (-ty, tx) points away from the axis */
    target.set(-ty, tx, 0);
    if (target.lengthSq() < 1e-12) target.set(ring[i].x, ring[i].y, 0);
    return target.normalize();
  }

  /**
   * Full local frame: ORTHONORMAL and RIGHT-HANDED, always.
   *
   * The normal comes from the cross product of the two surface tangents
   * rather than from the 2-D ring normal alone, so it is correct where the
   * hull is tapering hard — at the canopy root the section shrinks fast
   * enough that ignoring dz tilts a frame member visibly off the glass.
   *
   * WHY THE GRAM-SCHMIDT AND THE FIXED HANDEDNESS
   *
   * `tz` and `tc` are finite differences on a curved surface, so they are
   * NOT perpendicular to each other, and the normal was negated whenever it
   * disagreed with the in-section normal.  Both of those corrupted the
   * matrix place() builds out of them:
   *
   *   - a skewed basis has |det| well under 1, so every part placed on the
   *     skin was sheared and SHRUNK — measured at 0.32 to 0.49 against the
   *     1.0 an orthonormal frame gives, i.e. parts up to 30% undersized;
   *   - negating one column flips the determinant's SIGN, so the frame was
   *     left-handed for half the ring range.  A left-handed matrix turns
   *     every closed solid placed with it inside out: it still renders where
   *     the material is DoubleSide, but every face is a backface and shades
   *     as if lit from the far side.  That is what tools/holes.mjs was
   *     reporting on the port ceiling panels and nowhere else — the port
   *     side was inverted and the starboard side was not.
   *
   * So: take the outward normal as given, orthogonalise the along-ship
   * tangent against it, and DERIVE the circumferential axis from the other
   * two.  makeBasis(tc, n, tz) is right-handed exactly when tc x n = tz,
   * which cross(n, tz) guarantees by construction.  The cost is that on the
   * half of the ring where the measured circumferential direction ran the
   * other way, a part's local +X is now mirrored — which on a hull symmetric
   * about x = 0 is what you wanted anyway.
   */
  frame(z, ri, off = 0) {
    const dz = 0.02, dr = 0.35;
    const p = this.pt(z, ri, off);
    const tz = this.pt(z + dz, ri, off, _a).sub(this.pt(z - dz, ri, off, _b));
    const tc = this.pt(z, ri + dr, off, _c).sub(this.pt(z, ri - dr, off, _d));
    if (tz.lengthSq() < 1e-12) tz.set(0, 0, 1);
    if (tc.lengthSq() < 1e-12) tc.set(1, 0, 0);
    tz.normalize();
    tc.normalize();
    const n = new THREE.Vector3().crossVectors(tz, tc).normalize();
    /* orient outward: compare against the in-section normal, which is
       unambiguous */
    this.n2(z, ri, _d);
    if (n.dot(_d) < 0) n.negate();
    /* orthonormalise, then rebuild the circumferential axis so the triple is
       right-handed by construction — see the note above */
    tz.addScaledVector(n, -tz.dot(n));
    if (tz.lengthSq() < 1e-10) tz.set(0, 0, 1).addScaledVector(n, -n.z);
    tz.normalize();
    tc.crossVectors(n, tz).normalize();
    return { p, n, tz: tz.clone(), tc: tc.clone() };
  }

  /** unit outward normal at (z, ri) */
  nrm(z, ri) {
    return this.frame(z, ri).n;
  }

  /**
   * Matrix that lands a part flat on the surface.
   *
   * Convention matches bevelBox(w, h, d): local +X runs circumferentially,
   * +Y is the outward normal (so `h` is the part's thickness off the skin)
   * and +Z runs along the ship.  `off` lifts the part along the normal;
   * pass half its thickness to make it sit ON the surface instead of half
   * buried in it.  `spin` rotates it in the surface plane.
   */
  place(z, ri, off = 0, spin = 0) {
    const { p, n, tz, tc } = this.frame(z, ri, off);
    const m = new THREE.Matrix4().makeBasis(tc, n, tz);
    m.setPosition(p);
    if (spin !== 0) m.multiply(new THREE.Matrix4().makeRotationY(spin));
    return m;
  }

  /**
   * A polyline along the surface at constant ring index, for sweeping a
   * frame member.  Returns the path and the "up" vectors sweepProfile wants
   * (its profile's +y runs along `up`), which here is the outward normal so
   * a rail's depth goes into the skin.
   */
  runZ(ri, z0, z1, step = 0.12, off = 0) {
    const path = [];
    const ups = [];
    const n = Math.max(1, Math.ceil(Math.abs(z1 - z0) / step));
    for (let i = 0; i <= n; i++) {
      const f = this.frame(z0 + ((z1 - z0) * i) / n, ri, off);
      path.push(f.p);
      ups.push(f.n);
    }
    return { path, ups };
  }

  /** the same, along a section at constant z between two ring indices */
  runRing(z, ri0, ri1, stepRi = 0.5, off = 0) {
    const path = [];
    const ups = [];
    const n = Math.max(1, Math.ceil(Math.abs(ri1 - ri0) / stepRi));
    for (let i = 0; i <= n; i++) {
      const f = this.frame(z, ri0 + ((ri1 - ri0) * i) / n, off);
      path.push(f.p);
      ups.push(f.n);
    }
    return { path, ups };
  }

  /**
   * A quad patch of the surface as its own geometry: the canopy panes and
   * the interior lining panels are both this.  UVs are metric (arc length
   * and z) so the baked tiles land at the right physical size.
   */
  patch(z0, z1, ri0, ri1, off = 0, nz = 3, nr = 3, flip = false, norm = false) {
    const P = [];
    const N = [];
    const U = [];
    const grid = [];
    for (let i = 0; i <= nz; i++) {
      const row = [];
      const z = z0 + ((z1 - z0) * i) / nz;
      for (let j = 0; j <= nr; j++) row.push(this.frame(z, ri0 + ((ri1 - ri0) * j) / nr, off));
      grid.push(row);
    }
    /* metric UVs: v is z, u is accumulated arc length across the patch.
       `norm` normalises both into 0..1 instead, which is what a shader
       needing "metres from the nearest edge of THIS pane" wants — the glass
       measures its own scale off the uv Jacobian, so per-pane 0..1 gives it
       a per-pane frit border and seal band. */
    const arc = grid.map((row) => {
      const a = [0];
      for (let j = 1; j < row.length; j++) a.push(a[j - 1] + row[j].p.distanceTo(row[j - 1].p));
      return a;
    });
    const uMax = Math.max(1e-6, ...arc.map((a) => a[a.length - 1]));
    /* WINDING FOLLOWS THE NORMAL.
       `flip` used to reverse the triangle order AND negate the normals, which
       means the relationship between the two was invariant under it — so for
       any band whose (z, ring) parameterisation happens to run the other way,
       the patch rendered on the OPPOSITE side from the one it shaded for, and
       no value of `flip` could fix it.  The cockpit roof was exactly that
       case: tools/winding.mjs reported 40 of 40 triangles disagreeing.

       So the normal is authoritative — `flip` decides which way the surface
       faces, full stop — and the winding is chosen to match it by measuring
       one quad and reversing the whole patch if it came out backwards. */
    const s = flip ? -1 : 1;
    const push = (i, j) => {
      const f = grid[i][j];
      P.push(f.p.x, f.p.y, f.p.z);
      N.push(f.n.x * s, f.n.y * s, f.n.z * s);
      if (norm) U.push(arc[i][j] / uMax, i / nz);
      else U.push(arc[i][j], grid[i][j].p.z - z0);
    };
    /* does (i,j) -> (i+1,j+1) -> (i+1,j) wind toward the normal? */
    let ccw = true;
    {
      const a = grid[0][0].p, b = grid[1][1].p, c = grid[1][0].p;
      const e1 = new THREE.Vector3().subVectors(b, a);
      const e2 = new THREE.Vector3().subVectors(c, a);
      const wn = e1.cross(e2);
      ccw = wn.dot(grid[0][0].n) * s > 0;
    }
    for (let i = 0; i < nz; i++) {
      for (let j = 0; j < nr; j++) {
        if (ccw) {
          push(i, j); push(i + 1, j + 1); push(i + 1, j);
          push(i, j); push(i, j + 1); push(i + 1, j + 1);
        } else {
          push(i, j); push(i + 1, j); push(i + 1, j + 1);
          push(i, j); push(i + 1, j + 1); push(i, j + 1);
        }
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(U, 2));
    return g;
  }
}
