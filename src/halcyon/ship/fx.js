// Ship effects that are shader, not geometry: the engine exhaust volume, the
// nozzle throat glow and the cargo-ramp containment field.  Lifted unchanged
// out of the old procedural hull builders so the Blender-authored model
// (model.js) can stand the same rigs on its own nozzles.
import * as THREE from 'three';

/* ---- engine plume / halo shaders ------------------------------------------
 *
 * This is a textureless analytic emissive VOLUME, not a camera-facing card.
 * A small box only supplies the raster footprint; every fragment intersects
 * that box in engine-local space and integrates a round density field along
 * the actual camera ray.  Axial and oblique views therefore see the same 3D
 * plume, with no plane edge for the nozzle or depth buffer to cut in half.
 *
 * Premultiplied normal blending is deliberate.  Additive blue shells made
 * every overlap brighter than the source and polluted bloom across the hull;
 * the shear stays below the bloom knee while only the compact potential core
  * carries restrained HDR radiance.  Back faces supply exactly one exit surface
  * whether the camera is outside or inside the proxy box; the analytic box hit
  * then clamps an internal camera's entry to zero.  Close chase cameras therefore
  * keep the exhaust instead of losing the whole volume to front-face culling.
 */
export function plumeGeometry() {
  const geometry = new THREE.BoxGeometry(2.32, 7.6, 2.32, 1, 1, 1);
  geometry.translate(0, 3.8, 0);
  geometry.name = 'engine plume raymarch bounds';
  return geometry;
}

export function nozzleGlowGeometry() {
  const angularSegments = 48;
  const radialSegments = 8;
  const radius = 0.88;
  const positions = [0, 0, -0.30];
  const uvs = [0.5, 0.5];
  const indices = [];
  for (let radial = 1; radial <= radialSegments; radial++) {
    const t = radial / radialSegments;
    const ringRadius = radius * t;
    /* This is a real recessed dish, not a centre vertex pulled out of a flat
       triangle fan.  Eight radial rings give the throat a readable 0.30R bowl
       and let the physical bell ribs occlude the gas from oblique views. */
    const ridgeOffset = (t - 0.80) / 0.12;
    const annularRidge = 0.12 * Math.exp(-(ridgeOffset * ridgeOffset));
    const z = -0.30 * (1.0 - t * t) + annularRidge;
    for (let angular = 0; angular < angularSegments; angular++) {
      const a = angular / angularSegments * Math.PI * 2;
      positions.push(Math.cos(a) * ringRadius, Math.sin(a) * ringRadius, z);
      uvs.push(0.5 + Math.cos(a) * t * 0.5, 0.5 + Math.sin(a) * t * 0.5);
    }
  }
  for (let angular = 0; angular < angularSegments; angular++) {
    indices.push(0, 1 + angular, 1 + (angular + 1) % angularSegments);
  }
  for (let radial = 1; radial < radialSegments; radial++) {
    const inner = 1 + (radial - 1) * angularSegments;
    const outer = 1 + radial * angularSegments;
    for (let angular = 0; angular < angularSegments; angular++) {
      const next = (angular + 1) % angularSegments;
      indices.push(inner + angular, outer + angular, outer + next);
      indices.push(inner + angular, outer + next, inner + next);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setIndex(indices);
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  geometry.name = 'engine nozzle recessed hot throat';
  return geometry;
}

export function plumeMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uPower: { value: 0.1 },
    },
    transparent: true,
    premultipliedAlpha: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.NormalBlending,
    side: THREE.BackSide,
    toneMapped: true,
    vertexShader: `
      #include <common>
      #include <logdepthbuf_pars_vertex>
      uniform float uTime; uniform float uPower;
      varying vec3 vLocalSurface; varying vec3 vCameraLocal;
      varying float vLengthScale;
      void main(){
        float drive = smoothstep(0.06, 1.7, uPower);
        float response = pow(drive, 0.72);
        float lengthScale = mix(0.62, 1.18, response);
        mat4 instance = mat4(1.0);
        #ifdef USE_INSTANCING
          instance = instanceMatrix;
        #endif
        /* Small manoeuvring bells need enough physical reach to remain legible
           beside the main nacelles, but keep the same radius and temperature. */
        float authoredRadius = length(instance[0].xyz);
        lengthScale *= mix(1.28, 1.0, smoothstep(0.34, 0.92, authoredRadius));
        vec3 localPosition = position;
        localPosition.y *= lengthScale;
        vec3 rootWorld = (modelMatrix * instance
          * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
        vec3 basisX = (modelMatrix * instance
          * vec4(1.0, 0.0, 0.0, 0.0)).xyz;
        vec3 basisY = (modelMatrix * instance
          * vec4(0.0, 1.0, 0.0, 0.0)).xyz;
        vec3 basisZ = (modelMatrix * instance
          * vec4(0.0, 0.0, 1.0, 0.0)).xyz;
        float engineRadius = max(length(basisX), 0.0001);
        basisX /= engineRadius;
        basisY = normalize(basisY);
        basisZ = normalize(basisZ);
        vec3 cameraDelta = cameraPosition - rootWorld;
        vCameraLocal = vec3(dot(cameraDelta, basisX),
          dot(cameraDelta, basisY), dot(cameraDelta, basisZ)) / engineRadius;
        vLocalSurface = localPosition;
        vLengthScale = lengthScale;
        vec4 wp = modelMatrix * instance * vec4(localPosition, 1.0);
        gl_Position = projectionMatrix * viewMatrix * wp;
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: `
      #include <logdepthbuf_pars_fragment>
      uniform float uTime; uniform float uPower;
      varying vec3 vLocalSurface; varying vec3 vCameraLocal;
      varying float vLengthScale;
      /* Units are engine radii; y runs downstream from a root 0.3 R inside
         the bell, so the jet is born in the glowing throat, not at the lip.
         Three parts, each with its own job:
           core    a hot ivory potential core that lengthens with power
           knots   shock diamonds on the axis, only under real thrust
           mantle  a wider, golden shear layer that carries the length
         The result is premultiplied light over a light veil: it brightens what
         is behind it but never paints a flat sheet over the stars. */
      void main(){
        #include <logdepthbuf_fragment>
        float drive = smoothstep(0.06, 1.7, uPower);
        vec3 rayVector = vLocalSurface - vCameraLocal;
        float rayVectorLength = length(rayVector);
        if (rayVectorLength < 0.0001) discard;
        vec3 dir = rayVector / rayVectorLength;
        vec3 sgn = mix(vec3(1.0), sign(dir), greaterThan(abs(dir), vec3(0.0001)));
        vec3 inv = sgn / max(abs(dir), vec3(0.0001));
        float L = 7.6 * vLengthScale;
        vec3 hitA = (vec3(-1.16, 0.0, -1.16) - vCameraLocal) * inv;
        vec3 hitB = (vec3(1.16, L, 1.16) - vCameraLocal) * inv;
        vec3 nearHit = min(hitA, hitB), farHit = max(hitA, hitB);
        float enter = max(max(nearHit.x, nearHit.y), max(nearHit.z, 0.0));
        float exit = min(min(farHit.x, farHit.y), farHit.z);
        if (exit <= enter) discard;
        const int STEPS = 22;
        float stepLength = (exit - enter) / float(STEPS);
        float jitter = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
        float coreLen = mix(1.10, 2.6, drive);
        float coreR = mix(0.32, 0.42, drive);
        float cell = mix(1.35, 1.0, drive);
        float knotGain = smoothstep(0.38, 1.0, drive);
        float mantleLen = L * mix(0.34, 0.46, drive);
        /* End-on, a jet is optically thin: the downstream gas is a column you
           look along, not a sheet you look across.  Without this the chase
           camera, which sits nearly on the axis, sees every metre of plume
           stacked into one blob. */
        float axial = smoothstep(0.62, 0.97, abs(dir.y));
        vec3 light = vec3(0.0);
        float veil = 0.0;
        for (int i = 0; i < STEPS; i++) {
          vec3 q = vCameraLocal + dir * (enter + (float(i) + jitter) * stepLength);
          float y = q.y;
          float t = clamp(y / L, 0.0, 1.0);
          float rr = dot(q.xz, q.xz);
          float born = smoothstep(0.0, 0.32, y) * (1.0 - smoothstep(0.55, 1.0, t))
            * mix(1.0, 0.48, axial * smoothstep(0.6, 2.2, y));
          float flicker = 0.9 + 0.1 * sin(uTime * 37.0 + y * 3.1);
          /* the potential core CONTRACTS downstream, as a real one does */
          float cr = coreR * (1.0 - 0.45 * smoothstep(0.0, coreLen * 1.8, y));
          float core = exp(-rr / (cr * cr)) * exp(-max(y - 0.15, 0.0) / coreLen) * born;
          float ph = fract((y - 0.45) / cell);
          float cellOffset = (ph - 0.5) / 0.12;
          float knot = exp(-cellOffset * cellOffset) * exp(-rr / 0.045)
            * exp(-y / coreLen) * step(0.45, y) * (1.0 - smoothstep(coreLen * 1.6, coreLen * 2.4, y)) * knotGain;
          float sr = (0.48 + 0.55 * t + 0.06 * drive)
            * (1.0 - 0.20 * knotGain * (0.5 + 0.5 * cos(y * 6.2832 / cell)));
          float roll = 0.72 + 0.28 * sin(q.x * 5.0 + y * 2.3 - uTime * 9.0)
            * cos(q.z * 4.6 - y * 1.7 + uTime * 7.0);
          float mantle = exp(-rr / (sr * sr) * 2.2) * exp(-y / mantleLen) * roll * born;
          light += (vec3(1.0, 0.88, 0.58) * core * 3.8 + vec3(1.0, 0.96, 0.83) * knot * 4.0
            + vec3(1.0, 0.57, 0.14) * mantle * 1.35) * flicker * stepLength;
          veil += (core * 0.5 + mantle * 0.2) * stepLength;
        }
        float gain = mix(1.0, 1.65, drive);
        // Compress the brightest end-on column before bloom, preserving its hue.
        float peak = max(light.r, max(light.g, light.b)) * gain;
        vec3 col = light * gain / (1.0 + peak / 1.20);
        // Gas at the mouth also attenuates the bright metal and injector behind it.
        float alpha = min(0.94, 1.0 - exp(-veil * gain * 1.65));
        if (peak < 0.00005) discard;
        gl_FragColor = vec4(col, alpha);
      }`,
  });
}
export function haloMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { uPower: { value: 0.1 }, uTime: { value: 0 } },
    transparent: true,
    premultipliedAlpha: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.NormalBlending,
    side: THREE.DoubleSide,
    toneMapped: true,
    vertexShader: `
      #include <common>
      #include <logdepthbuf_pars_vertex>
      varying float vRadius;
      varying vec2 vDisc;
      void main(){
        mat4 instance = mat4(1.0);
        #ifdef USE_INSTANCING
          instance = instanceMatrix;
        #endif
        vec4 wp = modelMatrix * instance * vec4(position, 1.0);
        vRadius = length(position.xy);
        vDisc = position.xy;
        gl_Position = projectionMatrix * viewMatrix * wp;
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: `
      #include <logdepthbuf_pars_fragment>
      uniform float uPower; uniform float uTime;
      varying float vRadius;
      varying vec2 vDisc;
      /* the hot throat at the bottom of the bell: an ivory-to-amber
         dish, no rings, seen through the flame-holder struts */
      void main(){
        #include <logdepthbuf_fragment>
        float drive = smoothstep(0.06, 1.7, uPower);
        float g = 1.0 - smoothstep(0.0, 0.88, vRadius);
        vec3 color = mix(vec3(1.0, 0.45, 0.09), vec3(1.0, 0.93, 0.72), g * g);
        float flicker = 0.94 + 0.06 * sin(uTime * 23.0 + vDisc.x * 3.0);
        float alpha = clamp((0.45 + drive * 0.45) * g, 0.0, 0.9);
        float radiance = (1.65 + drive * 1.4) * flicker;
        gl_FragColor = clamp(vec4(color * radiance * alpha, alpha), 0.0, 4.0);
        if (alpha < 0.002) discard;
      }`,
  });
}

/* ------------------------------------------------------------------ *
 *  CONTAINMENT FIELD
 *
 *  The previous version was a faint hex grid plus a scan line at alpha
 *  0.28, and it read as a sheet of graph paper taped over the doorway.
 *  Four things are wrong with that and all four are fixed here:
 *
 *  1  NO VIEW DEPENDENCE.  A real field is a volume you look THROUGH, so it
 *     brightens at grazing incidence — the same reason a soap film shows its
 *     colours at the edges.  Without it the field looks equally thin from
 *     every angle, which is what makes it read as a decal.  vN/vV give a
 *     Fresnel-ish term here.
 *  2  ONE FREQUENCY.  A single hex lattice at one scale is a texture.  Two
 *     lattices at 3.2x with the fine one modulated by the coarse one reads
 *     as structure inside a volume.
 *  3  NO EVENT.  A static pattern is dead.  There is a travelling pulse up
 *     the rake, a slow lattice drift, and a per-cell flicker, so the field
 *     is never twice the same.
 *  4  NO BOUNDARY.  It bled to nothing at the frame.  A real field is
 *     BRIGHTEST where it meets its emitters, so the rim is a hard bright
 *     band that ties it to the rail geometry around the aperture.
 *
 *  Everything stays additive and clamped: an unbounded additive surface
 *  that the walk camera can straddle is exactly how the plume blacked out
 *  whole frames, and the clamp on vUv is the same guard for the same reason.
 * ------------------------------------------------------------------ */
export function barrierMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uOpen: { value: 0 } },
    transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
    vertexShader: `
      #include <common>
      #include <logdepthbuf_pars_vertex>
      varying vec2 vUv;
      varying vec3 vN;
      varying vec3 vV;
      void main(){
        vUv = uv;
        vN = normalize(mat3(modelMatrix) * normal);
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vV = normalize(cameraPosition - wp.xyz);
        gl_Position = projectionMatrix * viewMatrix * wp;
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: `
      #include <logdepthbuf_pars_fragment>
      uniform float uTime; uniform float uOpen;
      varying vec2 vUv; varying vec3 vN; varying vec3 vV;

      /* signed distance to the nearest hex cell edge, in cell units */
      float hexEdge(vec2 p){
        p.x *= 1.1547;
        p.y += mod(floor(p.x), 2.0) * 0.5;
        vec2 f = fract(p) - 0.5;
        return 0.5 - max(abs(f.x) * 1.2, abs(f.y));
      }
      float hexId(vec2 p){
        p.x *= 1.1547;
        p.y += mod(floor(p.x), 2.0) * 0.5;
        vec2 i = floor(p);
        return fract(sin(i.x * 12.9898 + i.y * 78.233) * 43758.5453);
      }

      void main(){
        #include <logdepthbuf_fragment>
        /* clamp before use: the walk camera can straddle this plane at the
           ramp threshold, and a near-plane-crossing triangle interpolates
           varyings to +/-Inf, which bloom would smear over the whole frame.
           See the note on plumeMaterial() in ship/exterior.js. */
        vec2 uv = clamp(vUv, 0.0, 1.0);
        float t = mod(uTime, 64.0);

        /* two lattices, the fine one gated by the coarse one */
        vec2 pc = uv * vec2(5.0, 6.0) + vec2(0.0, t * 0.03);
        vec2 pf = uv * vec2(16.0, 19.0) - vec2(0.0, t * 0.11);
        float ec = smoothstep(0.10, 0.0, hexEdge(pc));
        float ef = smoothstep(0.06, 0.0, hexEdge(pf));
        float cellC = hexId(pc);
        float cellF = hexId(pf);
        /* per-cell flicker: a few cells are always brighter than the rest */
        float flick = 0.55 + 0.45 * sin(t * (1.7 + cellF * 3.1) + cellF * 31.0);
        float lattice = ec * 0.85 + ef * (0.30 + 0.45 * step(0.72, cellC)) * flick;

        /* a pulse travelling up the rake, plus the slow interference wash
           that keeps the interior of each cell from being flat */
        float pulse = exp(-pow((fract(uv.y - t * 0.22) - 0.5) / 0.10, 2.0));
        float wash = 0.5 + 0.5 * sin(uv.y * 22.0 + uv.x * 7.0 - t * 2.1);

        /* The boundary.  Now that the field stands IN the doorway its edges
           land on the jamb coils, the sill and the lintel, so a bright rim is
           reading as the hardware energising rather than as a bar hanging in
           the walkway — which is what it was when the sheet lay across the
           ramp at 45 degrees.  Kept modest all the same, and the vertical
           edges get more of it than the horizontal ones, so the eye is led
           down the jambs instead of across the path. */
        float bx = min(uv.x, 1.0 - uv.x);
        float by = min(uv.y, 1.0 - uv.y);
        float rim = smoothstep(0.085, 0.0, bx) * 0.85 + smoothstep(0.05, 0.0, by) * 0.4;
        float inner = smoothstep(0.0, 0.10, bx) * smoothstep(0.0, 0.06, by);

        /* Fresnel: a volume seen edge-on is thicker, so it brightens.
           Squared by multiplication — pow() on a possibly-negative base is
           undefined in GLSL and returns NaN, which is how the nebula grew
           pale shards (see environment.ts). */
        float f = 1.0 - clamp(abs(dot(normalize(vN), normalize(vV))), 0.0, 1.0);
        float fres = 0.28 + 0.72 * (f * f);

        float a = (lattice * 0.20 + pulse * 0.30 + wash * 0.035 + 0.022) * inner * fres
                + rim * 0.20;
        a *= uOpen;

        /* hot cyan core toward the rim, deeper blue through the body, so the
           field has a temperature gradient rather than one flat hue */
        vec3 col = mix(vec3(0.20, 0.55, 1.0), vec3(0.62, 0.92, 1.0), clamp(rim + pulse * 0.7, 0.0, 1.0));
        gl_FragColor = clamp(vec4(col * a * 2.6, a * 0.9), 0.0, 32.0);
      }`,
  });
}
