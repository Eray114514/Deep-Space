// Shared browser harness for the tools/* browser scripts.
// Centralises the Chrome executable resolution and the SwiftShader / GPU
// args so every test launches headless Chromium the same way. CI has no
// real GPU, so the swiftshader flags are mandatory for WebGL to work at all.

import { chromium } from 'playwright';

// Default SwiftShader args. Mirrors tools/screenshot.js and is shared by every
// browser test. `--enable-unsafe-swiftshader` + `--use-angle=swiftshader-webgl`
// give us a working WebGL implementation on GPU-less CI; `--no-sandbox` is
// required for running as root in containers; `--enable-webgl` and
// `--ignore-gpu-blocklist` make sure Chromium doesn't quietly disable WebGL.
export const DEFAULT_ARGS = [
  '--no-sandbox',
  '--enable-unsafe-swiftshader',
  '--use-angle=swiftshader-webgl',
  '--enable-webgl',
  '--ignore-gpu-blocklist',
  '--disable-gpu-sandbox',
];

// Resolve the Chrome binary. Honours PLAYWRIGHT_EXECUTABLE_PATH (the env name
// already used by screenshot.js / seamtest.js / touchtest.js), and falls back
// to whatever Playwright's bundled chromium points at — never to a Windows
// hard-coded path that would explode on Linux CI.
export function resolveExecutablePath() {
  return process.env.PLAYWRIGHT_EXECUTABLE_PATH || chromium.executablePath();
}

// Launch Chromium with the shared args. Caller may override anything via opts:
//   const browser = await launchBrowser({ headless: true });
// opts.args, when supplied, is merged ON TOP of DEFAULT_ARGS (caller wins on
// duplicates because Playwright's last occurrence of a flag is the effective
// one — but we keep DEFAULT_ARGS first for predictability).
export async function launchBrowser(opts = {}) {
  const { args: extraArgs, ...rest } = opts;
  const args = extraArgs && extraArgs.length
    ? [...DEFAULT_ARGS, ...extraArgs]
    : DEFAULT_ARGS;
  return chromium.launch({
    executablePath: resolveExecutablePath(),
    args,
    ...rest,
  });
}
