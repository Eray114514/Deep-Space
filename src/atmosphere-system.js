// WebGPU-native atmosphere shell. A clean TSL rewrite of the participating
// medium that atmosphere-webgl.js expresses in GLSL: a 14-step ray-march with
// Rayleigh + Mie (g=0.76) phase functions, exponential sun transmission, and
// an ambient floor that keeps the terminator from going black.
//
// Two artefacts of the prior WebGPU port (src/planet.js makeAtmosphereMaterial)
// are deliberately NOT carried over:
//   1. The sunset colour-temperature shift that warmed rayleighColor toward
//      orange as the view ray neared the sun horizon. WebGL never had it, and
//      it was the root cause of clouds looking blue from inside the shell.
//   2. The 0.82 alpha cap that was lowered from WebGL's 0.985 to mask that
//      blue tint. With the tint removed the proper scattering integral keeps
//      the shell translucent enough for clouds to show through, so the alpha
//      cap is restored to the WebGL value.
//
// Depth occlusion uses the WebGPU-native logarithmicDepthToViewZ +
// positionViewDirection formula rather than WebGL's pow(far+1, depth)-1 path.

import * as THREE from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import {
  dot, exp, float, Fn, logarithmicDepthToViewZ, Loop, mix,
  positionLocal, positionViewDirection, screenUV, smoothstep, sqrt,
  texture, uniform, vec3, vec4,
} from 'three/tsl';

// 1x1 DepthTexture placeholder so TSL's texture() node compiles with the
// correct depth-sampler type before the render pipeline binds the real scene
// depth texture each frame (see node-render-pipeline.js, which assigns
// tSceneDepth.value / uDepthReady).
let _depthTex = null;
function depthPlaceholder() {
  if (_depthTex) return _depthTex;
  const tex = new THREE.DepthTexture(1, 1);
  tex.name = 'atmosphere-v2-depth-placeholder';
  _depthTex = tex;
  return tex;
}

export function makeAtmosphereMaterialV2(color, density, groundR, atmoR) {
  const nodes = {
    atmoColor: uniform(color),
    density: uniform(density),
    sunDir: uniform(new THREE.Vector3(0, 1, 0)),
    uCameraLocal: uniform(new THREE.Vector3()),
    uGroundR: uniform(groundR),
    uAtmoR: uniform(atmoR),
    tSceneDepth: texture(depthPlaceholder()),
    uDepthReady: uniform(0),
    uCameraNear: uniform(0.1),
    uCameraFar: uniform(1.2e11),
    uVolumeSize: uniform(new THREE.Vector2(1, 1)),
  };

  // Faithful TSL port of atmosphere-webgl.js. The first WebGPU migration kept
  // this 14-step integration; the rewrite restores its physical parameters.
  const atmosphere = Fn(() => {
    const origin = nodes.uCameraLocal;
    const ray = positionLocal.sub(origin).normalize();
    const sunDirN = nodes.sunDir.normalize();

    // --- Ray / sphere intersection (outer shell + ground) -----------------
    // sphereHits(o, r, dir): t = -b ± sqrt(b^2 - |o|^2 + r^2)
    const b = dot(origin, ray);
    const discOuter = b.mul(b).sub(dot(origin, origin)).add(nodes.uAtmoR.mul(nodes.uAtmoR));
    const outerRoot = sqrt(discOuter.max(0));
    const t0 = b.negate().sub(outerRoot).max(0).toVar();
    const t1 = b.negate().add(outerRoot).toVar();

    const discGround = b.mul(b).sub(dot(origin, origin)).add(nodes.uGroundR.mul(nodes.uGroundR));
    const groundNear = b.negate().sub(sqrt(discGround.max(0)));
    const clipsGround = discGround.greaterThan(0).and(groundNear.greaterThan(t0));
    t1.assign(clipsGround.select(groundNear.min(t1), t1));

    // --- Scene-depth occlusion (WebGPU-native) ----------------------------
    // logarithmicDepthToViewZ returns negative viewZ; negate for the positive
    // forwardCos is the view-space forward cosine (positionViewDirection.z
    // is negative in front of the camera), floored at 0.035 so the ray limit
    // stays finite at grazing angles (matches WebGL's
    // max(-normalize(vViewDir).z, 0.035)).
    const depthReady = nodes.uDepthReady.greaterThan(0.5);
    const depthSample = nodes.tSceneDepth.sample(screenUV).x;
    const forwardDistance = logarithmicDepthToViewZ(depthSample,
      nodes.uCameraNear, nodes.uCameraFar).negate();
    const forwardCos = positionViewDirection.z.negate().max(0.035);
    const sceneLimit = forwardDistance.div(forwardCos);
    const useScene = depthReady.and(depthSample.lessThan(0.999999));
    t1.assign(useScene.select(sceneLimit.add(1.5).min(t1), t1));

    const valid = discOuter.greaterThan(0).and(t1.greaterThan(t0));

    // --- 14-step ray-march ------------------------------------------------
    // Step count matches WebGL: the limb gradient is sample-limited, not
    // step-limited, and doubling steps halved framerate with no visible gain.
    const span = t1.sub(t0).max(0);
    const stepLength = span.div(float(14));
    const t = t0.add(stepLength.mul(0.5)).toVar();
    const shellThickness = nodes.uAtmoR.sub(nodes.uGroundR).max(1);

    const mu = dot(ray, sunDirN);
    const rayleighPhase = float(0.05968).mul(float(1).add(mu.mul(mu)));
    const g = float(0.76);
    const miePhase = float(0.07958).mul(float(1).sub(g.mul(g)))
      .div(float(1).add(g.mul(g)).sub(g.mul(mu).mul(2)).max(0.04).pow(1.5));
    // Fixed Rayleigh palette — identical to WebGL. No sunset warming: that
    // chromatic shift was what tinted clouds blue from the inside view.
    const rayleighColor = mix(
      vec3(0.48, 0.68, 1.0),
      nodes.atmoColor.max(vec3(0.015)),
      0.58,
    );

    const integrated = vec3(0).toVar();
    const transmission = float(1).toVar();
    Loop(14, () => {
      const samplePosition = origin.add(ray.mul(t));
      const radius = samplePosition.length();
      const height = radius.sub(nodes.uGroundR)
        .div(shellThickness).clamp(0, 1);
      const rhoR = exp(height.mul(-6.2)).mul(nodes.density);
      const rhoM = exp(height.mul(-15)).mul(nodes.density).mul(0.22);
      const radial = samplePosition.div(radius.max(1));
      const sunMu = dot(radial, sunDirN);
      const horizon = smoothstep(-0.13, 0.055, sunMu);
      const slant = float(1).div(sunMu.add(0.32).max(0.16));
      const sunTransmission = exp(rhoR.mul(0.32).add(rhoM.mul(1.4)).mul(slant).negate())
        .mul(horizon);
      // Ambient floor: single-term multi-scatter approximation that keeps the
      // terminator and cloud shadows from going pure black. Matches WebGL.
      const ambient = nodes.density.mul(float(1).sub(height)).mul(0.075);
      const scatter = rayleighColor.mul(rhoR).mul(rayleighPhase)
        .add(vec3(1.0, 0.93, 0.82).mul(rhoM).mul(miePhase))
        .mul(sunTransmission.add(ambient));
      const extinction = rhoR.mul(0.58).add(rhoM.mul(1.8)).mul(stepLength)
        .div(shellThickness);
      const alphaStep = float(1).sub(exp(extinction.mul(-0.62)));
      integrated.addAssign(scatter.mul(transmission).mul(alphaStep).mul(11));
      transmission.mulAssign(float(1).sub(alphaStep));
      t.addAssign(stepLength);
    });

    // Alpha cap 0.985 — the WebGL value. Do not lower it: suppressing alpha
    // was a workaround for the blue-cloud artefact whose real cause (the
    // sunset tint above) is now gone. The scattering integral itself keeps
    // the shell readable from space and translucent from inside.
    const alpha = float(1).sub(transmission).clamp(0, 0.985);
    // WebGL discards on alpha < 0.001 and on a missed/empty ray. Emitting
    // vec4(0) is equivalent under the premultiplied (ONE, ONE_MINUS_SRC_ALPHA)
    // blend: src*1 + dst*(1-0) = dst, so empty pixels are a true no-op.
    const keep = alpha.greaterThan(0.001);
    return valid.and(keep).select(vec4(integrated, alpha), vec4(0, 0, 0, 0));
  })();

  const material = new MeshBasicNodeMaterial({
    side: THREE.BackSide,
    transparent: true,
    // atmosphere-webgl.js emits already-premultiplied vec4(col, alpha) and
    // relies on premultipliedAlpha:true to pick the (ONE, ONE_MINUS_SRC_ALPHA)
    // blend factors. On WebGPU, NodeMaterial's premultipliedAlpha:true is the
    // supported path and does NOT double-premultiply (the extra rgb*=alpha step
    // only fires on the WebGL/TSL backend). CustomBlending on WebGPU NodeMaterial
    // is not reliably parsed and was the root cause of the WebGPU black screen,
    // so keep premultipliedAlpha:true and let NodeMaterial own the blend state.
    premultipliedAlpha: true,
    depthWrite: false,
    depthTest: true,
    // atmosphere-webgl.js uses a raw ShaderMaterial (fog defaults off). The
    // NodeMaterial family defaults fog=true, which auto-composites the scene's
    // FogExp2 on top of the ray-marched shell — that extra fog mix is what
    // makes the TSL path read as over-blue/over-bright in atmosphere. Disable
    // it so the shell matches the authored GLSL behaviour exactly.
    fog: false,
  });
  // `integrated` already accumulates scatter*transmission*alphaStep — the
  // layer's transmitted premultiplied radiance — matching atmosphere-webgl.js
  // which emits vec4(col, alpha) under the same premultipliedAlpha flag.
  material.colorNode = atmosphere.rgb;
  material.opacityNode = atmosphere.a;
  material.uniforms = nodes;
  // Composition: BackSide shell, depthWrite off, depthTest on, premultiplied
  // alpha. The mesh itself is assigned to VOLUME_LAYER by the planet builder
  // (src/planet.js) so the volume pass renders it before clouds composite
  // over it; layers are an Object3D property, not a material one.
  return material;
}
