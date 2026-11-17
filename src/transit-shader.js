import * as THREE from 'three';

// Camera-space transit pass shared by the pulse and the interstellar warp.
// It runs on the lit scene before the foreground ship pass, so the hull is
// never covered and is instead lit by the transit (see main.js hull light).
//
//   - radial motion blur of the real scene toward the vanishing point
//   - pulse: space pinched into the vanishing point, then a refractive ring
//   - warp: a long, gently curving tunnel solved per pixel as a ray/tube
//     intersection. Its mouth sweeps outward from the centre on entry and its
//     exit opens from the centre on arrival, because both are depth planes in
//     the tube: nothing ever cross-fades between unrelated layers.
export const TransitShader = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uAspect: { value: 1 },
    uTanHalfFov: { value: Math.tan(Math.PI / 6) },
    uAxis: { value: new THREE.Vector3(0, 0, -1) },
    uCenter: { value: new THREE.Vector2(0.5, 0.5) },
    uBlur: { value: 0 },
    uFold: { value: 0 },
    uShockR: { value: 0 },
    uShockAmp: { value: 0 },
    uFlash: { value: 0 },
    uTunnel: { value: 0 },
    uMouth: { value: 1e4 },
    uExit: { value: 1e4 },
    uFlow: { value: 0 },
    uEndGlow: { value: 0 },
    uBend: { value: new THREE.Vector2(0, 0) },
    uTwist: { value: 0 },
    uColorA: { value: new THREE.Color(1, 0.92, 0.82) },
    uColorB: { value: new THREE.Color(0.75, 0.85, 1) },
    uColorMix: { value: 0 },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform float uAspect;
    uniform float uTanHalfFov;
    uniform vec3 uAxis;
    uniform vec2 uCenter;
    uniform float uBlur;
    uniform float uFold;
    uniform float uShockR;
    uniform float uShockAmp;
    uniform float uFlash;
    uniform float uTunnel;
    uniform float uMouth;
    uniform float uExit;
    uniform float uFlow;
    uniform float uEndGlow;
    uniform vec2 uBend;
    uniform float uTwist;
    uniform vec3 uColorA;
    uniform vec3 uColorB;
    uniform float uColorMix;
    varying vec2 vUv;

    const float TAU = 6.28318530718;
    const float BEND_LENGTH = 22.0;
    const float MAX_DEPTH = 3000.0;

    float hash13(vec3 p) {
      p = fract(p * .1031);
      p += dot(p, p.zyx + 31.32);
      return fract((p.x + p.y) * p.z);
    }
    float hash12(vec2 p) {
      vec3 q = fract(vec3(p.xyx) * .1031);
      q += dot(q, q.yzx + 33.33);
      return fract((q.x + q.y) * q.z);
    }
    float noise3(vec3 p) {
      vec3 i = floor(p), f = fract(p);
      f = f * f * (3.0 - 2.0 * f);
      float n000 = hash13(i), n100 = hash13(i + vec3(1, 0, 0));
      float n010 = hash13(i + vec3(0, 1, 0)), n110 = hash13(i + vec3(1, 1, 0));
      float n001 = hash13(i + vec3(0, 0, 1)), n101 = hash13(i + vec3(1, 0, 1));
      float n011 = hash13(i + vec3(0, 1, 1)), n111 = hash13(i + vec3(1, 1, 1));
      return mix(mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
        mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y), f.z);
    }
    float fbm(vec3 p) {
      float v = 0.0, a = .5;
      for (int i = 0; i < 4; i++) {
        v += a * noise3(p);
        p = p * 2.03 + vec3(1.7, 9.2, 4.1);
        a *= .5;
      }
      return v / .9375;
    }

    vec2 bendAt(float z) {
      float q = max(z, 0.0) / BEND_LENGTH;
      return uBend * BEND_LENGTH * q * q / (1.0 + q);
    }

    // First wall crossing of a ray from the camera (on the tube axis) with a
    // tube of radius R whose centre line bends by bendAt(z). Coarse geometric
    // search for the first sign change, then bisection: robust for rays that
    // look straight down a bent passage, where a fixed-point solve diverges.
    float tubeField(float s, float a, vec2 pv, float R) {
      return length(s * pv - bendAt(s * a)) - R;
    }
    vec3 tubeHit(vec3 ray, vec3 e1, vec3 e2, float R) {
      float a = dot(ray, uAxis);
      vec2 pv = vec2(dot(ray, e1), dot(ray, e2));
      float sMax = a > 1e-3 ? MAX_DEPTH / a : 4.0 * R / max(length(pv), 1e-3) + 4.0;
      float lo = 0.0, hi = sMax;
      bool found = false;
      float prev = 0.0;
      for (int i = 1; i <= 14; i++) {
        float s = .03 * R * pow(sMax / (.03 * R), float(i) / 14.0);
        if (tubeField(s, a, pv, R) >= 0.0) { lo = prev; hi = s; found = true; break; }
        prev = s;
      }
      float s = sMax;
      if (found) {
        for (int i = 0; i < 12; i++) {
          float mid = .5 * (lo + hi);
          if (tubeField(mid, a, pv, R) >= 0.0) hi = mid; else lo = mid;
        }
        s = hi;
      }
      float z = s * a;
      vec2 local = s * pv - bendAt(z);
      return vec3(s, z, atan(local.y, local.x));
    }

    vec3 sceneSample(vec2 uv) { return texture2D(tDiffuse, clamp(uv, vec2(.001), vec2(.999))).rgb; }

    void main() {
      vec2 p = (vUv - uCenter) * vec2(uAspect, 1.0);
      float r = length(p);
      vec2 dir = p / max(r, 1e-4);

      // ---- space distortion: fold (pinch into the vanishing point) + shock ring
      // Strongest around the vanishing point and zero at the frame edge, so the
      // pinch never samples (and smears) pixels from outside the image.
      float fold = uFold * .30 * exp(-r * r * 7.0) * smoothstep(.0, .06, r);
      float g = (r - uShockR) / .065;
      float edgeGuard = smoothstep(.0, .05, min(min(vUv.x, 1.0 - vUv.x), min(vUv.y, 1.0 - vUv.y)));
      float ring = uShockAmp * .032 * g * exp(-g * g) * edgeGuard;
      vec2 baseUv = uCenter + (vUv - uCenter) * (1.0 + fold) + dir * ring / vec2(uAspect, 1.0);
      // Lens-like dispersion stays a hint: strongest on the refractive ring.
      float chroma = abs(ring) * .22 + uFold * .0016 * r + uBlur * .0018 * r;
      vec2 cd = dir / vec2(uAspect, 1.0) * chroma;

      // ---- radial motion blur of the lit scene
      vec3 scene;
      if (uBlur > .002) {
        vec3 acc = vec3(0.0);
        float wsum = 0.0;
        float reach = uBlur * .11 * smoothstep(.015, .55, r);
        for (int i = 0; i < 12; i++) {
          float k = float(i) / 11.0;
          vec2 uv = uCenter + (baseUv - uCenter) * (1.0 - reach * k);
          float w = 1.0 - k * .55;
          acc += vec3(sceneSample(uv + cd).r, sceneSample(uv).g, sceneSample(uv - cd).b) * w;
          wsum += w;
        }
        scene = acc / wsum;
      } else {
        scene = vec3(sceneSample(baseUv + cd).r, sceneSample(baseUv).g, sceneSample(baseUv - cd).b);
      }
      vec3 hot = vec3(1.0, .98, .95);
      vec3 star = mix(uColorA, uColorB, uColorMix);
      scene *= 1.0 + uFlash * 1.4 * exp(-r * r * 5.0);
      scene += mix(star, hot, .5) * uFlash * .35 * exp(-r * r * 40.0);
      scene += vec3(.35, .55, 1.0) * ring * ring * 30.0 * uShockAmp;

      if (uTunnel < .002 && uExit > 1e3) {
        gl_FragColor = vec4(scene, 1.0);
        return;
      }

      // ---- the tunnel
      vec2 ndc = vUv * 2.0 - 1.0;
      vec3 ray = normalize(vec3(ndc.x * uTanHalfFov * uAspect, ndc.y * uTanHalfFov, -1.0));
      vec3 up = abs(uAxis.y) < .95 ? vec3(0, 1, 0) : vec3(1, 0, 0);
      vec3 e1 = normalize(cross(uAxis, up));
      vec3 e2 = cross(e1, uAxis);

      vec3 wallHit = tubeHit(ray, e1, e2, 1.0);
      float z = wallHit.y;
      float zc = max(z, 0.0);
      float w = z - uFlow;
      // The passage turns slowly about its own axis; its filaments are wound
      // helically, so perspective draws them as spiral arms.
      float phi = wallHit.z + uTime * .06;
      vec2 cs = vec2(cos(phi + uTwist * zc * .05), sin(phi + uTwist * zc * .05));
      float phiH = phi + uTwist * zc * .16;
      vec2 csH = vec2(cos(phiH), sin(phiH));

      // Palette: deep indigo near the camera, electric blue mid-tube, and a
      // white core tinted by the destination star - the Doppler gradient of
      // the starflow continued as light. Some filaments burn amber.
      float depthT = 1.0 - exp(-zc / 120.0);
      vec3 nearCol = vec3(.05, .05, .22);
      vec3 midCol = vec3(.18, .46, 1.0);
      vec3 coreCol = mix(vec3(.80, .92, 1.0), star, .35);
      vec3 grad = depthT < .4 ? mix(nearCol, midCol, depthT / .4)
        : mix(midCol, coreCol, (depthT - .4) / .6);
      vec3 endColor = mix(coreCol, hot, .55);

      // wall: luminous plasma with helical filaments and passing ripples
      float plasma = fbm(vec3(cs * 2.2, w * .09));
      float clouds = .02 + 1.5 * pow(plasma, 3.4);
      float filaments = fbm(vec3(csH * 5.0, w * .06 + 3.0));
      float strands = pow(smoothstep(.6, .93, filaments), 2.0);
      float warm = smoothstep(.6, .76, fbm(vec3(cs * 2.6, w * .03 + 40.0)));
      vec3 strandCol = mix(mix(grad, vec3(1.0), .3), vec3(1.0, .58, .28), warm * .85);
      float ringPhase = fract(w * .022 + .18 * noise3(vec3(cs * 1.6, floor(w * .022) * 3.1)));
      float ripple = exp(-pow((ringPhase - .5) * 11.0, 2.0)) * smoothstep(.25, .7, plasma + .2);
      float fine = noise3(vec3(csH * 26.0, w * .5 + 9.0));
      float sparks = pow(smoothstep(.78, .98, fine), 4.0);
      vec3 wall = grad * clouds * (1.0 + ripple * 1.4) + strandCol * strands * (1.15 + ripple)
        + mix(grad, vec3(1.0), .6) * sparks * .4;
      wall *= mix(.5, 1.6, depthT);
      float far = 1.0 - exp(-zc / 420.0);
      wall = mix(wall, endColor * (.3 + 1.1 * uEndGlow), far * far);

      // Participating medium inside the tube: a few samples along the view ray
      // through drifting plasma give soft volumetric glow with real parallax
      // (near wisps rush past, deep ones crawl).
      vec3 medium = vec3(0.0);
      float transmit = 1.0;
      float sHit = wallHit.x;
      for (int i = 0; i < 5; i++) {
        float s = sHit * (float(i) + .5) / 5.0;
        float pz = s * dot(ray, uAxis);
        if (pz < uMouth) continue;
        vec2 radial = s * vec2(dot(ray, e1), dot(ray, e2)) - bendAt(pz);
        float rr = clamp(length(radial), 0.0, 1.0);
        float pa = atan(radial.y, radial.x) + uTwist * max(pz, 0.0) * .1 - uTime * .12;
        float d = fbm(vec3(cos(pa) * 2.4 * rr, sin(pa) * 2.4 * rr, (pz - uFlow * .85) * .05 + 23.0));
        float dens = smoothstep(.5, .86, d) * mix(.2, 1.0, rr * rr) * (1.0 - smoothstep(60.0, 500.0, pz));
        float pd = 1.0 - exp(-max(pz, 0.0) / 120.0);
        vec3 pc = pd < .4 ? mix(nearCol, midCol, pd / .4) : mix(midCol, coreCol, (pd - .4) / .6);
        medium += transmit * pc * dens * .3;
        transmit *= exp(-dens * .45);
      }

      // Mouth and exit are depth planes in the tube. Their edges are ragged:
      // the plasma surges ahead in tongues instead of a geometric circle.
      float edgeNoise = noise3(vec3(cs * 2.5, uTime * .7)) - .5;
      float mouth = uMouth * (1.0 + .45 * edgeNoise);
      float mouthSoft = max(2.0, uMouth * .6);
      float zIn = smoothstep(mouth - mouthSoft, mouth, z);
      float exitZ = uExit * (1.0 + .4 * edgeNoise);
      float exitSoft = max(.8, uExit * .3);
      float zOut = 1.0 - smoothstep(exitZ - exitSoft, exitZ, z);
      float density = smoothstep(.15, 1.0, uTunnel);
      float wallA = density * zIn * zOut;

      vec3 tunnel = wall * transmit + medium;
      vec3 col = mix(scene, tunnel, wallA);

      // incandescent lip where the exit opens
      float rimW = .5 + uExit * .05;
      float rim = exp(-pow((z - exitZ) / rimW, 2.0)) * step(uExit, 1e3) * density;
      col += endColor * rim * uEndGlow * .8;

      // the end light, with a soft corona and an anamorphic streak
      // aim the end light at the actual exit section while it is in view
      float farZ = uExit < 900.0 ? max(uExit, 1.0) : 900.0;
      vec2 fc = bendAt(farZ);
      vec3 endDir = normalize(uAxis * farZ + e1 * fc.x + e2 * fc.y);
      float ang = acos(clamp(dot(ray, endDir), -1.0, 1.0));
      vec3 endView = endDir / max(-endDir.z, 1e-3);
      vec2 endUv = vec2(endView.x / (uTanHalfFov * uAspect), endView.y / uTanHalfFov) * .5 + .5;
      vec2 dv = (vUv - endUv) * vec2(uAspect, 1.0);
      float streak = exp(-abs(dv.y) * 220.0) * exp(-abs(dv.x) * 4.5);
      float endLight = (exp(-ang * ang * 3200.0) * 2.4 + exp(-ang * 14.0) * .3) * uEndGlow;
      col += endColor * (endLight * wallA + streak * .2 * uEndGlow * density);

      gl_FragColor = vec4(col, 1.0);
    }
  `,
};
