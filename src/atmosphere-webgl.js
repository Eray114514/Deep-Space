import * as THREE from 'three';

export function makeAtmosphereMaterialWebGL(color, density, groundR, atmoR) {
  return new THREE.ShaderMaterial({
    uniforms: {
      atmoColor: { value: color },
      density: { value: density },
      sunDir: { value: new THREE.Vector3(0, 1, 0) },   // planet-local, set by the system
      uStellarDirections0: { value: new THREE.Vector3(0, 1, 0) },
      uStellarRadiance0: { value: new THREE.Color(1, 1, 1) },
      uStarIrradiance0: { value: 1 },
      uStellarDirections1: { value: new THREE.Vector3(0, 1, 0) },
      uStellarRadiance1: { value: new THREE.Color(1, 1, 1) },
      uStarIrradiance1: { value: 0 },
      uEclipseEnabled: { value: 0 },
      uEclipseCenter: { value: new THREE.Vector3() },
      uEclipseRadius: { value: 1 },
      uEclipseStarAngle: { value: 0 },
      uCameraLocal: { value: new THREE.Vector3() },
      uGroundR: { value: groundR },
      uAtmoR: { value: atmoR },
      tSceneDepth: { value: null },
      uDepthReady: { value: 0 },
      uCameraFar: { value: 1.2e11 },
      uVolumeSize: { value: new THREE.Vector2(1, 1) },
      // Camera proximity is retained for compatibility with planet updates.
      // The active planet uses atmosphere-pass-webgl; this material is the
      // physical-scale fallback for distant bodies and portal views.
      uCamProx: { value: 1 },
    },
    vertexShader: /* glsl */`
      uniform vec3 uCameraLocal;
      varying vec3 vDirection;
      varying vec3 vViewDirection;
      void main() {
        vDirection = position - uCameraLocal;
        vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
        vViewDirection = viewPosition.xyz;
        gl_Position = projectionMatrix * viewPosition;
      }`,
    fragmentShader: /* glsl */`
      precision highp float;
      uniform vec3 atmoColor;
      uniform float density, uGroundR, uAtmoR, uCamProx;
      uniform sampler2D tSceneDepth;
      uniform float uDepthReady, uCameraFar;
      uniform vec2 uVolumeSize;
      uniform vec3 sunDir, uCameraLocal;
      uniform vec3 uStellarDirections0, uStellarRadiance0;
      uniform vec3 uStellarDirections1, uStellarRadiance1;
      uniform float uStarIrradiance0, uStarIrradiance1;
      uniform float uEclipseEnabled, uEclipseRadius, uEclipseStarAngle;
      uniform vec3 uEclipseCenter;
      varying vec3 vDirection;
      varying vec3 vViewDirection;

      vec2 sphereHits(vec3 origin, float r, vec3 dir) {
        float b = dot(origin, dir);
        float disc = b * b - dot(origin, origin) + r * r;
        if (disc < 0.0) return vec2(-1.0);
        float s = sqrt(disc);
        return vec2(-b - s, -b + s);
      }

      float eclipseVisibility(vec3 samplePosition, vec3 lightDirection) {
        if (uEclipseEnabled < 0.5) return 1.0;
        vec3 toOccluder = uEclipseCenter - samplePosition;
        float distanceToOccluder = length(toOccluder);
        if (distanceToOccluder <= uEclipseRadius) return 0.0;
        float angularRadius = asin(clamp(
          uEclipseRadius / distanceToOccluder, 0.0, 0.9999));
        float separation = acos(clamp(dot(normalize(toOccluder),
          normalize(lightDirection)), -1.0, 1.0));
        float penumbra = max(uEclipseStarAngle, 0.00002);
        return smoothstep(max(angularRadius - penumbra, 0.0),
          angularRadius + penumbra, separation);
      }

      vec3 stellarScatter(vec3 position, vec3 viewDirection, vec3 radial,
        float rhoR, float rhoM, vec3 lightDirection, vec3 lightColor,
        float energy) {
        if (energy <= 0.00001) return vec3(0.0);
        vec3 lightDir = normalize(lightDirection);
        float sunMu = dot(radial, lightDir);
        float horizon = smoothstep(-0.13, 0.055, sunMu);
        float slant = 1.0 / max(0.16, sunMu + 0.32);
        float sunTrans = exp(-(rhoR * 0.32 + rhoM * 1.4) * slant) * horizon;
        float mu = dot(viewDirection, lightDir);
        float rayleighPhase = 0.05968 * (1.0 + mu * mu);
        float g = 0.76;
        float miePhase = 0.07958 * (1.0 - g * g)
          / pow(max(0.04, 1.0 + g * g - 2.0 * g * mu), 1.5);
        vec3 rayleighColor = mix(vec3(0.48, 0.68, 1.0),
          max(atmoColor, vec3(0.015)), 0.58);
        vec3 scatter = rayleighColor * rhoR * rayleighPhase
          + vec3(1.0, 0.93, 0.82) * rhoM * miePhase;
        return scatter * lightColor * energy * sunTrans
          * eclipseVisibility(position, lightDir);
      }

      float sceneRayLimit() {
        if (uDepthReady < 0.5) return 1e20;
        vec2 uv = gl_FragCoord.xy / max(uVolumeSize, vec2(1.0));
        float depth = texture2D(tSceneDepth, clamp(uv, 0.0, 1.0)).x;
        if (depth >= 0.999999) return 1e20;
        float forwardDistance = pow(uCameraFar + 1.0, depth) - 1.0;
        float forwardCos = max(-normalize(vViewDirection).z, 0.035);
        return forwardDistance / forwardCos;
      }

      void main() {
        vec3 dir = normalize(vDirection);
        // uAtmoR remains a gameplay/weather envelope. Molecular scattering is
        // confined to a 26–120 km optical top, matching the full-resolution
        // pass rather than normalizing density across an authored 630 km shell.
        float opticalTop = min(uAtmoR,
          uGroundR + clamp(uGroundR / 60.0, 26000.0, 120000.0));
        vec2 outer = sphereHits(uCameraLocal, opticalTop, dir);
        if (outer.y <= 0.0) discard;
        vec2 ground = sphereHits(uCameraLocal, uGroundR, dir);
        float t0 = max(outer.x, 0.0);
        float t1 = outer.y;
        if (ground.x > t0) t1 = min(t1, ground.x);
        t1 = min(t1, sceneRayLimit() + 1.5);
        if (t1 <= t0) discard;

        const int STEPS = 24;
        float dt = (t1 - t0) / float(STEPS);
        float t = t0 + dt * 0.5;
        vec3 col = vec3(0.0);
        float trans = 1.0;
        for (int i = 0; i < STEPS; i++) {
          vec3 p = uCameraLocal + dir * t;
          float r = length(p);
          float altitude = max(r - uGroundR, 0.0);
          float normalizedHeight = altitude / max(opticalTop - uGroundR, 1.0);
          float rhoR = exp(-altitude / 8000.0) * density;
          float rhoM = exp(-altitude / 1200.0) * density * 0.22;
          vec3 radial = p / max(r, 1.0);
          vec3 scatter = stellarScatter(p, dir, radial, rhoR, rhoM,
            uStellarDirections0, uStellarRadiance0, uStarIrradiance0);
          scatter += stellarScatter(p, dir, radial, rhoR, rhoM,
            uStellarDirections1, uStellarRadiance1, uStarIrradiance1);
          // Soft multi-scatter approximation keeps the terminator from
          // turning unnaturally black while preserving sunset.
          scatter += max(atmoColor, vec3(0.015)) * rhoR * 0.0045
            * density * (1.0 - normalizedHeight)
            * (uStarIrradiance0 + uStarIrradiance1);
          float extinction = (rhoR * 0.58 + rhoM * 1.8) * dt
            / max(opticalTop - uGroundR, 1.0);
          float a = 1.0 - exp(-extinction * 0.62);
          col += trans * a * scatter * 11.0;
          trans *= 1.0 - a;
          t += dt;
        }
        float alpha = clamp(1.0 - trans, 0.0, 0.985);
        if (alpha < 0.001) discard;
        gl_FragColor = vec4(col, alpha);
      }`,
    side: THREE.BackSide,
    transparent: true,
    premultipliedAlpha: true,
    depthWrite: false,
  });
}


