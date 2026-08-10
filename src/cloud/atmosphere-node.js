// Atmospheric scattering (TSL / WebGPU). PHASE 5 — SKELETON.
//
// Deliberately DECOUPLED from the cloud volume. The two share only the scene
// depth limit and the final composite; they must not share a march loop. The
// previous implementation entangled them, so every cloud step-budget change
// also perturbed the atmosphere integral.
//
// THE FLICKER, AND WHY THREE EARLIER FIXES MISSED IT
// -------------------------------------------------
// Reported symptom: from orbit, any camera motion — even smooth easing — makes
// the atmosphere flicker.
//
// Three plausible causes were fixed, each real, none responsible:
//   1. cloud-atlas UV polarity mismatch (a genuine equator seam),
//   2. volume render-target size thrash (genuine, but not the flicker), and
//   3. the depth-guided upsample returning 0 when all four taps were rejected.
// The flicker survived all three.
//
// The actual cause was in the atmosphere march itself: every ray started at a
// FIXED `stepLength * 0.5` midpoint. With only 8-20 samples spread over a span
// that changes by kilometres from one pixel to the next across the limb, the
// quantisation error of the integral is a deterministic function of the span —
// so as the camera moved, that error swept across the disc as visible banding.
// Per-pixel jittering the ray start measured staticPose p95 0.1726 -> 0 and
// edgeToFlat 6.225 -> 0 in `test:atmosphere-motion`.
//
// STATIC vs TEMPORAL JITTER — READ BEFORE TOUCHING
// -----------------------------------------------
// The jitter must be a STATIC function of screen position unless phase 2
// (`temporal-resolve.js`) is complete and active. Adding a frame counter to the
// hash without accumulation was measured at 75-138 px of shimmer on a PARKED
// camera against a 0 px baseline (`seamtest` phase 1). Per-frame jitter with no
// accumulation to average it is just noise. See temporal-resolve.js.
//
// PHYSICS (phase 5)
//   - Rayleigh + Mie with physical scale heights (~8000 m / ~1200 m for an
//     Earth-like body), scaled from the body's actual atmosphere height.
//   - Rayleigh coefficients in inverse metres at 680/550/440 nm. These are
//     per-metre coefficients and must be multiplied by a metre-scale step
//     length; a previous version used normalised colours here, so a clear
//     vertical column reached alpha ~= 1 and blacked out the world.
//   - Bounded Kasten-like air mass so a horizon view reaches ~18 air masses at
//     zero elevation. This is what produces golden hour: blue is removed by
//     the long slant path. A naive 1/cos with a large clamp cannot.
//   - Multiple scattering: bounded ambient term so the night side and deep
//     shadow are not pure black.
//   - Eclipse visibility, shared with the cloud module.
//
// OUTPUT CONTRACT
//   - Straight alpha out; the composite premultiplies exactly once. Doing it
//     in both places cost the WebGPU path an alpha-squared haze loss.
//   - The un-premultiply reciprocal floor stays at 1e-3, not 1e-4. At 1e-4 a
//     nearly transparent limb pixel amplifies residual RGB by 1e4 and the
//     integration noise becomes camera-dependent speckle along the disc edge.
//
// VERIFICATION TRAP (doc §5 constraint 6)
//   All-zero motion metrics do NOT prove success — they are also what you get
//   if the atmosphere stopped rendering entirely. `test:atmosphere-motion`
//   must be paired with a screenshot confirming the atmosphere is still drawn.
//   This exact mistake was made once already in the previous round.
//
// HARD CONSTRAINT: TSL / NodeMaterial only on the WebGPU path (AGENTS.md).

export function createAtmosphereNode() {
  throw new Error(
    'atmosphere-node: not implemented (phase 5). '
    + 'See docs/cloud-atmosphere-rewrite.md §4 phase 5.',
  );
}
