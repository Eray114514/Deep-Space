// Shared browser harness for the tools/* browser scripts.
// Centralises the Chrome executable resolution and the SwiftShader / GPU
// args so every test launches headless Chromium the same way. CI has no
// real GPU, so the swiftshader flags are mandatory for WebGL to work at all.

import { chromium } from 'playwright';
import { existsSync } from 'node:fs';

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

export function resolveSystemChromePath() {
  if (process.env.WEBGPU_EXECUTABLE_PATH) return process.env.WEBGPU_EXECUTABLE_PATH;
  const candidates = process.platform === 'win32' ? [
    `${process.env.PROGRAMFILES || 'C:\\Program Files'}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)'}\\Microsoft\\Edge\\Application\\msedge.exe`,
    `${process.env.LOCALAPPDATA || ''}\\Google\\Chrome\\Application\\chrome.exe`,
  ] : process.platform === 'darwin' ? [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ] : [
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/microsoft-edge',
  ];
  return candidates.find((candidate) => candidate && existsSync(candidate)) || null;
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

// Performance captures must exercise the machine's real graphics adapter.
// Keep this separate from launchBrowser(): the latter deliberately forces
// SwiftShader so correctness tests stay portable on GPU-less CI hosts.
export async function launchHardwareBrowser(opts = {}) {
  const { args: extraArgs = [], adapterLuid = process.env.PERF_ADAPTER_LUID, ...rest } = opts;
  const args = [
    '--no-sandbox',
    '--enable-webgl',
    '--ignore-gpu-blocklist',
    '--disable-gpu-sandbox',
    ...(adapterLuid ? [`--use-adapter-luid=${adapterLuid}`] : []),
    ...extraArgs,
  ];
  return chromium.launch({
    executablePath: resolveExecutablePath(),
    args,
    ...rest,
  });
}

// Full WebGPU validation must not use the bundled SwiftShader Chromium: on
// Windows that runtime can expose navigator.gpu yet fail device creation when
// its DXIL runtime is absent. Prefer an installed Chrome/Edge and return null
// on headless CI where no system browser is present.
export async function launchWebGPUHardwareBrowser(opts = {}) {
  const executablePath = resolveSystemChromePath();
  if (!executablePath) return null;
  const { args: extraArgs = [], adapterLuid = process.env.WEBGPU_ADAPTER_LUID, ...rest } = opts;
  return chromium.launch({
    executablePath,
    args: [
      '--no-sandbox', '--enable-webgpu', '--ignore-gpu-blocklist',
      '--disable-gpu-sandbox',
      ...(adapterLuid ? [`--use-adapter-luid=${adapterLuid}`] : []),
      ...extraArgs,
    ],
    ...rest,
  });
}
