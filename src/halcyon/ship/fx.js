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
        float lengthScale = mix(0.38, 1.14, response);
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

      float transportedTurbulence(vec3 p, float phase) {
        /* Three travelling pressure waves form an inexpensive three-dimensional
           flow field.  None is camera-aligned, so their intersections survive
           the ray integral as rolling shear folds instead of horizontal bands. */
        float a = sin(dot(p, vec3(1.83, 2.31, -1.27)) - phase * 3.0);
        float b = sin(dot(p, vec3(-2.71, 4.17, 2.13)) - phase * 5.0
          + a * 0.72);
        float c = cos(dot(p, vec3(3.67, 5.43, 2.89)) - phase * 7.0
          + b * 0.44);
        return clamp(0.52 + a * 0.24 + b * 0.16 + c * 0.08,
          0.0, 1.0);
      }
      void main(){
        #include <logdepthbuf_fragment>
        float drive = smoothstep(0.06, 1.7, uPower);
        vec3 rayVector = vLocalSurface - vCameraLocal;
        float rayVectorLength = length(rayVector);
        if (rayVectorLength < 0.0001) discard;
        vec3 rayDirection = rayVector / rayVectorLength;
        vec3 raySign = mix(vec3(1.0), sign(rayDirection),
          greaterThan(abs(rayDirection), vec3(0.0001)));
        vec3 inverseRay = raySign / max(abs(rayDirection), vec3(0.0001));
        vec3 boxMin = vec3(-1.16, 0.0, -1.16);
        vec3 boxMax = vec3(1.16, 7.6 * vLengthScale, 1.16);
        vec3 hitA = (boxMin - vCameraLocal) * inverseRay;
        vec3 hitB = (boxMax - vCameraLocal) * inverseRay;
        vec3 nearHit = min(hitA, hitB);
        vec3 farHit = max(hitA, hitB);
        float rayEnter = max(max(nearHit.x, nearHit.y), max(nearHit.z, 0.0));
        float rayExit = min(min(farHit.x, farHit.y), farHit.z);
        if (rayExit <= rayEnter) discard;

        const int MARCH_STEPS = 16;
        float segmentLength = rayExit - rayEnter;
        float stepLength = segmentLength / float(MARCH_STEPS);
        vec3 accumulatedColor = vec3(0.0);
        float accumulatedAlpha = 0.0;
        for (int index = 0; index < MARCH_STEPS; index++) {
          float distanceAlong = rayEnter + (float(index) + 0.5) * stepLength;
          vec3 samplePosition = vCameraLocal + rayDirection * distanceAlong;
          float t = clamp(samplePosition.y / max(7.6 * vLengthScale, 0.001), 0.0, 1.0);
          /* Four coupled compression cells remain below the 16-step Nyquist
             limit and survive both axial and oblique integration. */
          float cell = 0.5 + 0.5 * cos(t * 25.13 - 0.45);
          float compression = cell * cell;
          float expansion = (0.40 + drive * 0.045)
            + (0.55 + drive * 0.045) * (t / (t + 0.105));
          float envelope = expansion * (1.0 - t * 0.12)
            * (0.955 + compression * 0.095 * (1.0 - t));

          /* A tiny downstream wander and cross-flow warp break the mathematically
             perfect cone while the t^1.45 term keeps the first nozzle diameter
             rigidly centred.  This is density motion, not mesh deformation. */
          float wanderGain = 0.115 * t * sqrt(max(t, 0.0))
            * (1.0 - drive * 0.22);
          vec2 wander = vec2(
            sin(samplePosition.y * 1.37 - uTime * 3.0
              + sin(samplePosition.z * 1.9)),
            cos(samplePosition.y * 1.11 - uTime * 5.0
              + sin(samplePosition.x * 1.6))) * wanderGain;
          vec2 flowCross = samplePosition.xz - wander;
          float rawRadial = length(flowCross) / max(envelope, 0.08);
          float turbulence = transportedTurbulence(
            vec3(flowCross.x, samplePosition.y, flowCross.y), uTime);
          float edgeWarp = (turbulence - 0.5) * 0.34
            * smoothstep(0.10, 0.86, t);
          float radial = max(0.0, rawRadial - edgeWarp);

          /* The plume is two coupled volumes: a hollow, rolling mixing layer and
             a compact potential core.  Ray integration through the shell gives
             genuine limb depth; there is no screen-facing opacity gradient. */
          float interiorBase = max(0.0, 1.0 - smoothstep(0.08, 0.98, radial));
          float interior = interiorBase * interiorBase;
          float shellCentre = 0.72 + (turbulence - 0.5) * 0.105;
          float shell = (1.0 - smoothstep(0.055, 0.27, abs(radial - shellCentre)))
            * (1.0 - smoothstep(0.94, 1.05, radial));
          float rootAttach = smoothstep(-0.035, 0.035 + radial * 0.045, t);
          float spent = 1.0 - smoothstep(0.64, 0.985, t);
          float shearFold = mix(0.92, 0.10 + turbulence * 1.28,
            smoothstep(0.08, 0.74, t));
          float breakup = mix(1.0, smoothstep(0.30, 0.66, turbulence),
            smoothstep(0.44, 0.92, t));
          float mixingLayer = interior * mix(0.58, 0.24, smoothstep(0.12, 0.78, t))
            + shell * mix(0.42, 0.88, smoothstep(0.08, 0.70, t));

          /* Restrained compression cells live only in the hot potential core.
             They modulate radius and radiance together, reading as pressure
             structure rather than a row of glowing sprites. */
          float pressureWave = 0.66 + compression * 0.34;
          float shear = mixingLayer * rootAttach * spent
            * shearFold * breakup * pressureWave;
          float coreRadius = (0.19 + t * 0.13)
            * mix(0.94, 1.10, compression);
          float coreProfile = 1.0 - smoothstep(0.02, coreRadius, radial);
          /* White-hot gas is a compact near-field potential core.  Downstream
             pressure cells remain in the blue mixing flow instead of drawing
             a long straight white laser through the whole plume. */
          float coreAxial = (1.0 - smoothstep(0.30, 0.53, t))
            * exp(-t * 1.55);
          float potentialCore = coreProfile * coreProfile * coreAxial
            * (0.95 + compression * 0.20)
            * smoothstep(-0.050, 0.015, t);
          float weightedShear = shear * (0.060 + drive * 0.098);
          float weightedCore = potentialCore * (0.25 + drive * 0.32);
          float density = weightedShear + weightedCore;
          float sampleAlpha = 1.0 - exp(-density * stepLength * 0.68);
          float coreMix = clamp(weightedCore / max(density, 0.001), 0.0, 1.0);
          float shellMix = clamp(shell * (1.0 - coreMix), 0.0, 1.0);
          vec3 innerBlue = mix(vec3(0.58, 0.82, 1.0), vec3(0.12, 0.30, 0.72),
            smoothstep(0.08, 0.95, t));
          vec3 shellBlue = mix(vec3(0.26, 0.55, 0.96), vec3(0.035, 0.12, 0.42),
            smoothstep(0.10, 0.95, t));
          vec3 shearColor = mix(innerBlue, shellBlue, shellMix * 0.72);
          vec3 coreColor = mix(vec3(0.82, 0.94, 1.0), vec3(0.20, 0.48, 0.92),
            smoothstep(0.10, 0.48, t));
          vec3 sampleColor = mix(shearColor, coreColor, coreMix);
          float radiance = mix(1.24, 0.34, smoothstep(0.08, 0.96, t))
            + coreMix * (0.88 + drive * 0.52 + compression * 0.04);
          float remaining = 1.0 - accumulatedAlpha;
          accumulatedColor += remaining * sampleColor * radiance * sampleAlpha;
          accumulatedAlpha += remaining * sampleAlpha;
        }
        accumulatedAlpha = min(accumulatedAlpha, 0.40);
        gl_FragColor = clamp(vec4(accumulatedColor, accumulatedAlpha), 0.0, 4.0);
        if (accumulatedAlpha < 0.002) discard;
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
      varying float vRadius; varying float vEngineRadius;
      varying vec2 vDisc; varying vec3 vWorld;
      void main(){
        mat4 instance = mat4(1.0);
        #ifdef USE_INSTANCING
          instance = instanceMatrix;
        #endif
        vec4 wp = modelMatrix * instance * vec4(position, 1.0);
        vRadius = length(position.xy);
        vEngineRadius = length(instance[0].xyz);
        vDisc = position.xy;
        vWorld = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: `
      #include <logdepthbuf_pars_fragment>
      uniform float uPower; uniform float uTime;
      varying float vRadius; varying float vEngineRadius;
      varying vec2 vDisc; varying vec3 vWorld;
      void main(){
        #include <logdepthbuf_fragment>
        float drive = smoothstep(0.06, 1.7, uPower);
        float gasFill = 1.0 - smoothstep(0.58, 0.86, vRadius);
        float hotCore = exp(-pow((vRadius - 0.27) / 0.085, 2.0));
        float ionRing = exp(-pow((vRadius - 0.52) / 0.10, 2.0));
        float wallRing = exp(-pow((vRadius - 0.72) / 0.075, 2.0));
        float cameraFade = smoothstep(0.35, 1.35, distance(cameraPosition, vWorld));
        float fillAlpha = (0.135 + drive * 0.085) * gasFill;
        float coreAlpha = (0.095 + drive * 0.125) * hotCore;
        float ringAlpha = (0.065 + drive * 0.095) * ionRing;
        float wallAlpha = (0.042 + drive * 0.060) * wallRing;
        float smallEngineBoost = mix(4.50, 1.0,
          smoothstep(0.34, 0.82, vEngineRadius));
        float baseAlpha = fillAlpha + coreAlpha + ringAlpha + wallAlpha;
        float thermal = 0.955 + 0.045
          * sin(vDisc.x * 7.0 + uTime * 3.0)
          * cos(vDisc.y * 8.5 - uTime * 5.0);
        float alpha = baseAlpha * cameraFade * thermal;
        vec3 fillColor = vec3(0.018, 0.070, 0.18);
        vec3 coreColor = vec3(0.38, 0.74, 1.0);
        vec3 ringColor = vec3(0.34, 0.68, 1.0);
        vec3 wallColor = vec3(0.08, 0.35, 0.82);
        vec3 color = (fillColor * fillAlpha + coreColor * coreAlpha
          + ringColor * ringAlpha + wallColor * wallAlpha)
          / max(baseAlpha, 0.001);
        float radiance = (1.10 + drive * 0.62)
          * mix(3.60, 1.0, smoothstep(0.34, 0.82, vEngineRadius));
        float alphaCap = mix(0.82, 0.46,
          smoothstep(0.34, 0.82, vEngineRadius));
        alpha = min(alpha * smallEngineBoost, alphaCap);
        gl_FragColor = clamp(vec4(color * radiance * alpha, alpha), 0.0, 1.8);
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
