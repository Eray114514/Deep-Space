import * as THREE from 'three';
import { Pass, FullScreenQuad } from '../vendor/jsm/postprocessing/Pass.js';

const DEBUG_MODES = {
  off: 0,
  velocity: 1,
  disocclusion: 2,
  weight: 3,
};

function makeHdrTarget(w, h, name, depth = false) {
  const rt = new THREE.WebGLRenderTarget(w, h, {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: depth,
    stencilBuffer: false,
  });
  rt.texture.name = name;
  rt.texture.generateMipmaps = false;
  return rt;
}

function makeMotionTarget(w, h, name) {
  const rt = new THREE.WebGLRenderTarget(w, h, {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    depthBuffer: true,
    stencilBuffer: false,
  });
  rt.texture.name = name;
  rt.texture.generateMipmaps = false;
  return rt;
}

export class TemporalAAPass extends Pass {
  constructor(camera, frameState, {
    foregroundLayer = 1,
  } = {}) {
    super();
    this.camera = camera;
    this.frameState = frameState;
    this.foregroundLayer = foregroundLayer;
    this.enabled = false;
    this.needsSwap = true;
    this.debugMode = 'off';
    this.width = 1;
    this.height = 1;
    this.historyValid = false;
    this.historySequence = -1;

    this.motionA = makeMotionTarget(1, 1, 'taa.motionA');
    this.motionB = makeMotionTarget(1, 1, 'taa.motionB');
    this.motionWrite = this.motionA;
    this.motionRead = this.motionB;

    this.historyA = makeHdrTarget(1, 1, 'taa.historyA');
    this.historyB = makeHdrTarget(1, 1, 'taa.historyB');
    this.historyWrite = this.historyA;
    this.historyRead = this.historyB;

    this.sceneDepthSource = null;
    this.volumeSource = null;

    const zeroModes = Array.from({ length: 12 }, () => new THREE.Vector4(1, 0, 0, 0.05));
    const zeroPhases = Array.from({ length: 12 }, () => new THREE.Vector2(1, 0));

    this.baseMotionMaterial = new THREE.ShaderMaterial({
      name: 'TemporalMotionBase',
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
      uniforms: {
        tSceneDepth: { value: null },
        tCloudVolume: { value: null },
        tCloudRepDepth: { value: null },
        uDepthReady: { value: 0 },
        uCloudReady: { value: 0 },
        uCloudRepMode: { value: 0 },
        uCameraFar: { value: camera.far },
        uInvProjection: { value: new THREE.Matrix4() },
        uCameraWorld: { value: new THREE.Matrix4() },
        uPrevViewProjection: { value: new THREE.Matrix4() },
        uBodyValid: { value: 0 },
        uBodyRotation: { value: new THREE.Matrix3() },
        uBodyTranslation: { value: new THREE.Vector3() },
        uWeatherAdvectValid: { value: 0 },
        uCurBodyInv: { value: new THREE.Matrix3() },
        uPrevBodyRot: { value: new THREE.Matrix3() },
        uCurBodyCenter: { value: new THREE.Vector3() },
        uPrevBodyCenter: { value: new THREE.Vector3() },
        uBodyRadius: { value: 6000000 },
        uWeatherWindDeltaRad: { value: 0 },
        uOceanDeformValid: { value: 0 },
        uSeaRadius: { value: 6000000 },
        uOceanHeight: { value: 0 },
        uOceanNorm: { value: 1 },
        uOceanModes: { value: zeroModes },
        uOceanPhasesCur: { value: zeroPhases },
        uOceanPhasesPrev: { value: zeroPhases.map(v => v.clone()) },
      },
      vertexShader: /* glsl */`
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }`,
      fragmentShader: /* glsl */`
        precision highp float;
        uniform sampler2D tSceneDepth, tCloudVolume, tCloudRepDepth;
        uniform float uDepthReady, uCloudReady, uCloudRepMode, uCameraFar;
        uniform mat4 uInvProjection, uCameraWorld, uPrevViewProjection;
        uniform float uBodyValid, uWeatherAdvectValid, uBodyRadius, uWeatherWindDeltaRad;
        uniform mat3 uBodyRotation, uCurBodyInv, uPrevBodyRot;
        uniform vec3 uBodyTranslation, uCurBodyCenter, uPrevBodyCenter;
        uniform float uOceanDeformValid, uSeaRadius, uOceanHeight, uOceanNorm;
        uniform vec4 uOceanModes[12];
        uniform vec2 uOceanPhasesCur[12];
        uniform vec2 uOceanPhasesPrev[12];
        varying vec2 vUv;

        vec3 rotateLocalY(vec3 v, float angle) {
          float c = cos(angle), s = sin(angle);
          return vec3(v.x * c + v.z * s, v.y, -v.x * s + v.z * c);
        }

        float evalOceanVertical(vec3 localPos, bool usePrev) {
          vec3 radial = normalize(localPos);
          float sum = 0.0;
          for (int i = 0; i < 12; i++) {
            vec4 mode = uOceanModes[i];
            vec2 ph = usePrev ? uOceanPhasesPrev[i] : uOceanPhasesCur[i];
            float theta = dot(radial, mode.xyz) * uSeaRadius * mode.w;
            float s = sin(theta) * ph.x + cos(theta) * ph.y;
            float amp = 1.0 / (1.0 + float(i) * 0.45);
            sum += s * amp;
          }
          return sum * uOceanNorm * uOceanHeight;
        }

        vec2 projectPrevious(vec3 prevRenderPos, vec2 fallbackUv) {
          vec4 prevClip = uPrevViewProjection * vec4(prevRenderPos, 1.0);
          if (prevClip.w <= 1e-5) return fallbackUv;
          return prevClip.xy / prevClip.w * 0.5 + 0.5;
        }

        void main() {
          float sceneDepth = uDepthReady > 0.5 ? texture2D(tSceneDepth, vUv).r : 1.0;
          vec4 clip = vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
          vec4 view = uInvProjection * clip;
          vec3 dirView = normalize(view.xyz / max(abs(view.w), 1e-6));
          vec3 dirWorld = normalize((uCameraWorld * vec4(dirView, 0.0)).xyz);
          vec3 rayOrigin = uCameraWorld[3].xyz;

          bool isSky = sceneDepth >= 0.999999;
          float tag = isSky ? 0.0 : 1.0;
          vec2 prevUv = vUv;

          if (isSky) {
            // Pure rotational sky reprojection at far distance
            vec3 skyPoint = rayOrigin + dirWorld * (uCameraFar * 0.25);
            prevUv = projectPrevious(skyPoint, vUv);
          } else {
            float forwardDist = pow(uCameraFar + 1.0, sceneDepth) - 1.0;
            float rayT = forwardDist / max(-dirView.z, 0.0005);
            vec3 curRenderPos = rayOrigin + dirWorld * rayT;
            vec3 prevRenderPos = uBodyValid > 0.5
              ? (uBodyRotation * curRenderPos + uBodyTranslation)
              : curRenderPos;

            // Deforming ocean wave displacement correspondence
            if (uOceanDeformValid > 0.5 && uWeatherAdvectValid > 0.5) {
              vec3 localPos = uCurBodyInv * (curRenderPos - uCurBodyCenter);
              float r = length(localPos);
              if (abs(r - uSeaRadius) <= max(12.0, uOceanHeight * 4.5)) {
                float wCur = evalOceanVertical(localPos, false);
                float wPrev = evalOceanVertical(localPos, true);
                vec3 baseLocal = localPos - normalize(localPos) * (wCur - wPrev);
                prevRenderPos = uPrevBodyRot * baseLocal + uPrevBodyCenter;
                tag = 1.5;
              }
            }
            prevUv = projectPrevious(prevRenderPos, vUv);
          }

          // Mixed-layer participating cloud correspondence via representative optical depth + 3-layer wind shear
          if (uCloudReady > 0.5 && uCloudRepMode > 0.5 && uWeatherAdvectValid > 0.5) {
            float cloudAlpha = clamp(texture2D(tCloudVolume, vUv).a, 0.0, 1.0);
            vec2 rep = texture2D(tCloudRepDepth, vUv).rg;
            if (cloudAlpha > 0.30 && rep.x > 0.0) {
              vec3 cloudCur = rayOrigin + dirWorld * rep.x;
              vec3 cloudLocal = uCurBodyInv * (cloudCur - uCurBodyCenter);
              float alt = max(0.0, length(cloudLocal) - uBodyRadius);
              float shear = mix(1.0, 1.25, smoothstep(2200.0, 4200.0, alt))
                + 0.40 * smoothstep(5500.0, 8000.0, alt);
              vec3 advectedLocal = rotateLocalY(cloudLocal, -uWeatherWindDeltaRad * shear);
              vec3 cloudPrev = uPrevBodyRot * advectedLocal + uPrevBodyCenter;
              vec2 cloudPrevUv = projectPrevious(cloudPrev, prevUv);
              float cloudDominance = smoothstep(0.30, 0.82, cloudAlpha);
              prevUv = mix(prevUv, cloudPrevUv, cloudDominance);
              if (cloudAlpha > 0.65) tag = 1.25;
            }
          }

          vec2 velocity = vUv - prevUv;
          gl_FragColor = vec4(velocity, tag, sceneDepth);
        }`,
    });
    this.baseMotionQuad = new FullScreenQuad(this.baseMotionMaterial);

    this.rigidVelocityMaterial = new THREE.ShaderMaterial({
      name: 'TemporalMotionRigidMesh',
      depthTest: true,
      depthWrite: true,
      blending: THREE.NoBlending,
      uniforms: {
        uCurClipFromLocal: { value: new THREE.Matrix4() },
        uPrevClipFromLocal: { value: new THREE.Matrix4() },
        uJitterNdc: { value: new THREE.Vector2() },
        uLayerTag: { value: 3.0 },
        uCameraFar: { value: camera.far },
      },
      vertexShader: /* glsl */`
        uniform mat4 uCurClipFromLocal, uPrevClipFromLocal;
        uniform vec2 uJitterNdc;
        varying vec4 vCurUnjitteredClip;
        varying vec4 vPrevUnjitteredClip;
        varying float vFragDepthW;
        void main() {
          vec4 curClip = uCurClipFromLocal * vec4(position, 1.0);
          vCurUnjitteredClip = curClip;
          vPrevUnjitteredClip = uPrevClipFromLocal * vec4(position, 1.0);
          vec4 rasterClip = curClip;
          rasterClip.xy += uJitterNdc * curClip.w;
          vFragDepthW = 1.0 + rasterClip.w;
          gl_Position = rasterClip;
        }`,
      fragmentShader: /* glsl */`
        precision highp float;
        uniform float uLayerTag, uCameraFar;
        varying vec4 vCurUnjitteredClip;
        varying vec4 vPrevUnjitteredClip;
        varying float vFragDepthW;
        void main() {
          float logDepth = log2(max(1e-6, vFragDepthW)) / log2(uCameraFar + 1.0);
          gl_FragDepth = logDepth;
          vec2 curUv = vCurUnjitteredClip.xy / max(abs(vCurUnjitteredClip.w), 1e-6) * 0.5 + 0.5;
          vec2 prevUv = vPrevUnjitteredClip.xy / max(abs(vPrevUnjitteredClip.w), 1e-6) * 0.5 + 0.5;
          gl_FragColor = vec4(curUv - prevUv, uLayerTag, logDepth);
        }`,
    });
    this.rigidScene = new THREE.Scene();
    this.rigidProxy = new THREE.Mesh(new THREE.BufferGeometry(), this.rigidVelocityMaterial);
    this.rigidProxy.matrixAutoUpdate = false;
    this.rigidProxy.frustumCulled = false;
    this.rigidScene.add(this.rigidProxy);
    this.rigidCamera = new THREE.Camera();

    this.resolveMaterial = new THREE.ShaderMaterial({
      name: 'TemporalAAResolve',
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
      uniforms: {
        tCurrent: { value: null },
        tHistory: { value: null },
        tMotion: { value: null },
        tPrevMotion: { value: null },
        tCloudVolume: { value: null },
        uCloudReady: { value: 0 },
        uHistoryValid: { value: 0 },
        uStationary: { value: 0 },
        uExposureRatio: { value: 1 },
        uResolution: { value: new THREE.Vector2(1, 1) },
        uTexelSize: { value: new THREE.Vector2(1, 1) },
        uJitterPixels: { value: new THREE.Vector2(0, 0) },
        uCameraFar: { value: camera.far },
        uDebugMode: { value: 0 },
      },
      vertexShader: /* glsl */`
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }`,
      fragmentShader: /* glsl */`
        precision highp float;
        uniform sampler2D tCurrent, tHistory, tMotion, tPrevMotion, tCloudVolume;
        uniform float uCloudReady, uHistoryValid, uStationary, uExposureRatio, uCameraFar;
        uniform int uDebugMode;
        uniform vec2 uResolution, uTexelSize, uJitterPixels;
        varying vec2 vUv;

        vec3 rgbToYCoCg(vec3 c) {
          return vec3(
            0.25 * c.r + 0.5 * c.g + 0.25 * c.b,
            0.5 * c.r - 0.5 * c.b,
            -0.25 * c.r + 0.5 * c.g - 0.25 * c.b
          );
        }

        vec3 yCoCgToRgb(vec3 y) {
          float tmp = y.x - y.z;
          return max(vec3(0.0), vec3(tmp + y.y, y.x + y.z, tmp - y.y));
        }

        float karisWeight(vec3 rgb) {
          float luma = dot(max(rgb, vec3(0.0)), vec3(0.2126, 0.7152, 0.0722));
          return 1.0 / (1.0 + luma);
        }

        // 5-tap Catmull-Rom bicubic history fetch to preserve fine terrain/ship/star sharpness
        vec4 sampleHistoryCatmullRom(sampler2D tex, vec2 uv) {
          vec2 samplePos = uv * uResolution;
          vec2 texPos1 = floor(samplePos - 0.5) + 0.5;
          vec2 f = samplePos - texPos1;
          vec2 w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
          vec2 w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
          vec2 w2 = f * (0.5 + f * (2.0 - 1.5 * f));
          vec2 w3 = f * f * (-0.5 + 0.5 * f);
          vec2 w12 = w1 + w2;
          vec2 offset12 = w2 / max(w12, vec2(1e-5));
          vec2 texPos0 = (texPos1 - 1.0) * uTexelSize;
          vec2 texPos3 = (texPos1 + 2.0) * uTexelSize;
          vec2 texPos12 = (texPos1 + offset12) * uTexelSize;
          vec4 result = vec4(0.0);
          result += texture2D(tex, vec2(texPos12.x, texPos0.y)) * (w12.x * w0.y);
          result += texture2D(tex, vec2(texPos0.x, texPos12.y)) * (w0.x * w12.y);
          result += texture2D(tex, vec2(texPos12.x, texPos12.y)) * (w12.x * w12.y);
          result += texture2D(tex, vec2(texPos3.x, texPos12.y)) * (w3.x * w12.y);
          result += texture2D(tex, vec2(texPos12.x, texPos3.y)) * (w12.x * w3.y);
          float totalW = w12.x * w0.y + w0.x * w12.y + w12.x * w12.y + w3.x * w12.y + w12.x * w3.y;
          return max(vec4(0.0), result / max(totalW, 1e-5));
        }

        void main() {
          // Dialate velocity using closest-depth 3x3 neighborhood so silhouette edges anti-alias cleanly
          vec4 centerMotion = texture2D(tMotion, vUv);
          vec4 bestMotion = centerMotion;
          for (int dy = -1; dy <= 1; dy++) {
            for (int dx = -1; dx <= 1; dx++) {
              if (dx == 0 && dy == 0) continue;
              vec4 m = texture2D(tMotion, vUv + vec2(float(dx), float(dy)) * uTexelSize);
              if (m.a < bestMotion.a || m.b > bestMotion.b + 0.4) bestMotion = m;
            }
          }

          vec2 velocity = bestMotion.rg;
          float curTag = bestMotion.b;
          float curDepth = bestMotion.a;
          vec4 curSample = texture2D(tCurrent, vUv);
          if (!all(lessThan(abs(curSample.rgb), vec3(65500.0)))) curSample.rgb = vec3(0.0);

          if (uHistoryValid < 0.5) {
            gl_FragColor = curSample;
            return;
          }

          vec2 prevUv = vUv - velocity;
          bool inBounds = prevUv.x >= 0.0 && prevUv.x <= 1.0 && prevUv.y >= 0.0 && prevUv.y <= 1.0;

          vec4 prevMotion = inBounds ? texture2D(tPrevMotion, prevUv) : vec4(0.0, 0.0, -9.0, 1.0);
          float prevTag = prevMotion.b;
          float prevDepth = prevMotion.a;

          // Disocclusion checks: layer tag mismatch (e.g. foreground ship vs ocean/clouds) or depth jump
          float tagMismatch = smoothstep(0.18, 0.38, abs(curTag - prevTag));
          float depthDisoccl = 0.0;
          if (curTag > 0.2 && prevTag > 0.2) {
            float zCur = pow(uCameraFar + 1.0, curDepth) - 1.0;
            float zPrev = pow(uCameraFar + 1.0, prevDepth) - 1.0;
            float relDiff = abs(zCur - zPrev) / max(1.5, max(zCur, zPrev) * 0.045);
            depthDisoccl = smoothstep(0.85, 2.2, relDiff);
          }
          // Velocity divergence disocclusion
          float velDiv = length(velocity - prevMotion.rg) * length(uResolution);
          float velDisoccl = smoothstep(2.5, 8.0, velDiv);
          float disoccluded = !inBounds ? 1.0 : max(tagMismatch, max(depthDisoccl, velDisoccl * 0.65));

          // 3x3 Karis-weighted YCoCg neighborhood moments + star point detection
          vec3 m1 = vec3(0.0), m2 = vec3(0.0);
          float wSum = 0.0, neighborLumaSum = 0.0;
          vec3 centerRgb = max(vec3(0.0), curSample.rgb);
          vec3 minNeighborY = rgbToYCoCg(centerRgb), maxNeighborY = minNeighborY;
          for (int y = -1; y <= 1; y++) {
            for (int x = -1; x <= 1; x++) {
              vec3 s = max(vec3(0.0), texture2D(tCurrent, vUv + vec2(float(x), float(y)) * uTexelSize).rgb);
              if (!all(lessThan(abs(s), vec3(65500.0)))) s = centerRgb;
              float kw = karisWeight(s);
              vec3 yc = rgbToYCoCg(s);
              m1 += yc * kw;
              m2 += yc * yc * kw;
              wSum += kw;
              minNeighborY = min(minNeighborY, yc);
              maxNeighborY = max(maxNeighborY, yc);
              if (x != 0 || y != 0) neighborLumaSum += yc.x;
            }
          }
          vec3 mu = m1 / max(wSum, 1e-6);
          vec3 sigma = sqrt(max(vec3(0.0), m2 / max(wSum, 1e-6) - mu * mu));

          float pixelSpeed = length(velocity * uResolution);
          float cloudAlpha = uCloudReady > 0.5 ? clamp(texture2D(tCloudVolume, vUv).a, 0.0, 1.0) : 0.0;
          float transmissiveEdge = cloudAlpha * (1.0 - cloudAlpha) * 4.0;

          // Star protection: isolated 1-pixel HDR stars on sky background must not be clipped down on camera pan
          float centerLuma = rgbToYCoCg(centerRgb).x;
          float avgRingLuma = neighborLumaSum * 0.125;
          bool isIsolatedStar = curTag < 0.25 && centerLuma > 0.22 && centerLuma > avgRingLuma * 3.2;

          float gamma = mix(1.35, 0.78, clamp(pixelSpeed * 0.12 + transmissiveEdge * 0.4, 0.0, 1.0));
          vec3 boxMin = min(mu - gamma * sigma, isIsolatedStar ? rgbToYCoCg(centerRgb) * 0.92 : minNeighborY);
          vec3 boxMax = max(mu + gamma * sigma, isIsolatedStar ? rgbToYCoCg(centerRgb) * 1.08 : maxNeighborY);

          vec4 histSample = sampleHistoryCatmullRom(tHistory, prevUv);
          if (!all(lessThan(abs(histSample.rgb), vec3(65500.0)))) histSample = curSample;
          // Apply pre-exposure ratio in linear HDR without altering alpha/transmittance!
          vec3 histRgb = histSample.rgb * uExposureRatio;
          vec3 histYCoCg = clamp(rgbToYCoCg(histRgb), boxMin, boxMax);
          vec3 clippedHistRgb = yCoCgToRgb(histYCoCg);

          float baseFeedback = mix(0.88, 0.68, clamp(pixelSpeed * 0.08, 0.0, 1.0));
          // Avoid stacking double temporal accumulation on partial-alpha clouds
          baseFeedback *= mix(1.0, 0.45, transmissiveEdge);
          if (isIsolatedStar && pixelSpeed > 0.35) baseFeedback *= 0.35;
          float historyWeight = baseFeedback * (1.0 - disoccluded);

          // Karis luminance weighting prevents HDR specular fireflies from flickering
          float wCur = karisWeight(centerRgb) * (1.0 - historyWeight);
          float wHist = karisWeight(clippedHistRgb) * historyWeight;
          vec3 resolvedRgb = (centerRgb * wCur + clippedHistRgb * wHist) / max(wCur + wHist, 1e-6);

          // Subtle contrast-preserving unsharp recovery under motion so textures never soften
          if (pixelSpeed > 0.15 && !isIsolatedStar && curTag >= 0.9) {
            vec3 blurRgb = yCoCgToRgb(mu);
            resolvedRgb = max(vec3(0.0), resolvedRgb + (centerRgb - blurRgb) * 0.10 * (1.0 - disoccluded));
          }

          if (uDebugMode == 1) {
            vec2 vis = clamp(abs(velocity * uResolution) * 0.12, 0.0, 1.0);
            gl_FragColor = vec4(vis.x, vis.y, curTag / 3.0, 1.0);
            return;
          }
          if (uDebugMode == 2) {
            gl_FragColor = vec4(disoccluded, 1.0 - disoccluded, curTag / 3.0, 1.0);
            return;
          }
          if (uDebugMode == 3) {
            gl_FragColor = vec4(vec3(historyWeight), 1.0);
            return;
          }

          gl_FragColor = vec4(resolvedRgb, curSample.a);
        }`,
    });
    this.resolveQuad = new FullScreenQuad(this.resolveMaterial);

    this.copyMaterial = new THREE.ShaderMaterial({
      name: 'TemporalAACopy',
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
      uniforms: { tInput: { value: null } },
      vertexShader: /* glsl */`
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
      fragmentShader: /* glsl */`
        precision highp float;
        uniform sampler2D tInput;
        varying vec2 vUv;
        void main() { gl_FragColor = texture2D(tInput, vUv); }`,
    });
    this.copyQuad = new FullScreenQuad(this.copyMaterial);
    this._curClip = new THREE.Matrix4();
    this._prevClip = new THREE.Matrix4();
  }

  setDebugMode(mode = 'off') {
    const key = typeof mode === 'string' ? mode : 'off';
    this.debugMode = Object.hasOwn(DEBUG_MODES, key) ? key : 'off';
    this.resolveMaterial.uniforms.uDebugMode.value = DEBUG_MODES[this.debugMode];
  }

  resetHistory() {
    this.historyValid = false;
  }

  setSize(width, height) {
    const w = Math.max(1, Math.round(width)), h = Math.max(1, Math.round(height));
    if (w === this.width && h === this.height) return;
    this.width = w;
    this.height = h;
    this.motionA.setSize(w, h);
    this.motionB.setSize(w, h);
    this.historyA.setSize(w, h);
    this.historyB.setSize(w, h);
    this.resolveMaterial.uniforms.uResolution.value.set(w, h);
    this.resolveMaterial.uniforms.uTexelSize.value.set(1 / w, 1 / h);
    this.historyValid = false;
  }

  render(renderer, writeBuffer, readBuffer) {
    const fs = this.frameState;
    if (!fs.pending) {
      this.copyMaterial.uniforms.tInput.value = readBuffer.texture;
      renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
      this.copyQuad.render(renderer);
      return;
    }

    const oldTarget = renderer.getRenderTarget();
    const oldFace = renderer.getActiveCubeFace(), oldMip = renderer.getActiveMipmapLevel();
    const oldAutoClear = renderer.autoClear;
    const oldColor = renderer.getClearColor(new THREE.Color());
    const oldAlpha = renderer.getClearAlpha();

    try {
      const depthTex = this.sceneDepthSource?.sceneDepthTexture || readBuffer.depthTexture || null;
      const vp = this.volumeSource;
      const cloudTex = vp?.enabled ? vp.latestResolvedTexture || null : null;
      const cloudRepTex = vp?.enabled ? vp.latestRepDepthTexture || null : null;
      const cloudRepMode = vp?.enabled ? (vp.latestRepDepthMode || 0) : 0;

      const mu = this.baseMotionMaterial.uniforms;
      mu.tSceneDepth.value = depthTex;
      mu.uDepthReady.value = depthTex ? 1 : 0;
      mu.tCloudVolume.value = cloudTex;
      mu.tCloudRepDepth.value = cloudRepTex;
      mu.uCloudReady.value = cloudTex ? 1 : 0;
      mu.uCloudRepMode.value = cloudRepMode;
      mu.uCameraFar.value = fs.current.far || this.camera.far;
      mu.uInvProjection.value.copy(fs.current.inverseProjection);
      mu.uCameraWorld.value.copy(fs.current.cameraWorld);
      mu.uPrevViewProjection.value.copy(fs.previous.viewProjection);

      const bodyValid = fs.mapBody();
      mu.uBodyValid.value = bodyValid ? 1 : 0;
      if (bodyValid) {
        mu.uBodyRotation.value.copy(fs.rotation);
        mu.uBodyTranslation.value.copy(fs.translation);
      }
      const weatherValid = fs.mapWeatherAdvection();
      mu.uWeatherAdvectValid.value = weatherValid ? 1 : 0;
      const body = fs.current.body;
      if (weatherValid && body) {
        mu.uCurBodyInv.value.copy(fs.curBodyInv);
        mu.uPrevBodyRot.value.copy(fs.prevBodyRot);
        mu.uCurBodyCenter.value.copy(fs.curBodyCenter);
        mu.uPrevBodyCenter.value.copy(fs.prevBodyCenter);
        mu.uBodyRadius.value = body.R || 6000000;
        mu.uWeatherWindDeltaRad.value = fs.weatherWindDeltaRad;
      }

      // Bind analytical ocean deformation modes & current/previous phases when near water
      const oceanUniforms = body?.liquidMat?.userData?.shader?.uniforms
        || body?.liquidMat?.userData?.waterUniforms || null;
      const curPhases = fs.current.oceanPhases, prevPhases = fs.previous.oceanPhases;
      const modes = oceanUniforms?.uOceanModes?.value;
      if (weatherValid && body?.hasLiquid && Array.isArray(modes) && modes.length >= 12
          && curPhases?.length >= 12 && prevPhases?.length >= 12) {
        mu.uOceanDeformValid.value = 1;
        mu.uSeaRadius.value = body.seaRadius || body.R;
        mu.uOceanHeight.value = oceanUniforms.uOceanHeight?.value ?? 2;
        mu.uOceanNorm.value = oceanUniforms.uOceanNormalization?.value ?? 1;
        for (let i = 0; i < 12; i++) {
          mu.uOceanModes.value[i].copy(modes[i]);
          mu.uOceanPhasesCur.value[i].copy(curPhases[i]);
          mu.uOceanPhasesPrev.value[i].copy(prevPhases[i]);
        }
      } else {
        mu.uOceanDeformValid.value = 0;
      }

      // 1. Render fullscreen base + ocean deformation + cloud representative motion into motionWrite
      renderer.autoClear = false;
      renderer.setRenderTarget(this.motionWrite);
      renderer.setClearColor(0x000000, 1);
      renderer.clear(true, true, false);
      this.baseMotionQuad.render(renderer);

      // 2. Rasterize registered rigid objects (world Layer 0 first, then foreground ship Layer 1 with cleared depth)
      const rigidMeshes = fs.current.capturedRigidMeshes;
      if (fs.valid && rigidMeshes.length > 0) {
        const ru = this.rigidVelocityMaterial.uniforms;
        ru.uJitterNdc.value.copy(fs.current.jitterNdc);
        ru.uCameraFar.value = fs.current.far || this.camera.far;
        const fgBit = 1 << this.foregroundLayer;
        for (let passLayer = 0; passLayer < 2; passLayer++) {
          const wantForeground = passLayer === 1;
          let clearedFgDepth = false;
          for (let i = 0; i < rigidMeshes.length; i++) {
            const entry = rigidMeshes[i];
            const mesh = entry.mesh;
            const isFg = (mesh.layers.mask & fgBit) !== 0 && (mesh.layers.mask & 1) === 0;
            if (isFg !== wantForeground) continue;
            if (!mesh.geometry) continue;
            if (!fs.rigidProjection(mesh, this._curClip, this._prevClip)) continue;
            if (wantForeground && !clearedFgDepth) {
              renderer.clear(false, true, false);
              clearedFgDepth = true;
            }
            ru.uCurClipFromLocal.value.copy(this._curClip);
            ru.uPrevClipFromLocal.value.copy(this._prevClip);
            ru.uLayerTag.value = wantForeground ? 3.0 : 2.0;
            this.rigidVelocityMaterial.side = mesh.material?.side ?? THREE.FrontSide;
            this.rigidProxy.geometry = mesh.geometry;
            renderer.render(this.rigidScene, this.rigidCamera);
          }
        }
        this.rigidProxy.geometry = null;
      }

      // 3. Resolve HDR TAA into historyWrite
      const precedingFrame = this.historySequence + 1 === fs.sequence;
      const canUseHistory = this.historyValid && fs.valid && precedingFrame;
      const ru = this.resolveMaterial.uniforms;
      ru.tCurrent.value = readBuffer.texture;
      ru.tHistory.value = this.historyRead.texture;
      ru.tMotion.value = this.motionWrite.texture;
      ru.tPrevMotion.value = this.motionRead.texture;
      ru.tCloudVolume.value = cloudTex;
      ru.uCloudReady.value = cloudTex ? 1 : 0;
      ru.uHistoryValid.value = canUseHistory ? 1 : 0;
      ru.uStationary.value = fs.stationaryBodyView() ? 1 : 0;
      ru.uExposureRatio.value = fs.exposureRatio();
      ru.uJitterPixels.value.copy(fs.current.jitterPixels);
      ru.uCameraFar.value = fs.current.far || this.camera.far;

      renderer.setRenderTarget(this.historyWrite);
      this.resolveQuad.render(renderer);

      // 4. Output resolved HDR to composer writeBuffer (or screen)
      this.copyMaterial.uniforms.tInput.value = this.historyWrite.texture;
      renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
      if (this.clear) renderer.clear();
      this.copyQuad.render(renderer);

      // Swap ping-pong buffers after successful resolve
      this.historyValid = true;
      this.historySequence = fs.sequence;
      const tmpH = this.historyRead; this.historyRead = this.historyWrite; this.historyWrite = tmpH;
      const tmpM = this.motionRead; this.motionRead = this.motionWrite; this.motionWrite = tmpM;
    } finally {
      this.rigidProxy.geometry = null;
      renderer.autoClear = oldAutoClear;
      renderer.setClearColor(oldColor, oldAlpha);
      renderer.setRenderTarget(oldTarget, oldFace, oldMip);
    }
  }

  releaseTargets() {
    this.motionA.dispose();
    this.motionB.dispose();
    this.historyA.dispose();
    this.historyB.dispose();
    this.historyValid = false;
  }

  dispose() {
    this.releaseTargets();
    this.baseMotionQuad.dispose();
    this.baseMotionMaterial.dispose();
    this.rigidVelocityMaterial.dispose();
    this.resolveQuad.dispose();
    this.resolveMaterial.dispose();
    this.copyQuad.dispose();
    this.copyMaterial.dispose();
  }
}
