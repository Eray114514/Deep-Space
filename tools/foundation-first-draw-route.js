import assert from 'node:assert/strict';

// Exact one-line observation hook. No shader, scheduling or quality override.
export function instrumentFoundationFirstDraw(source) {
  const anchor = '\nframe();\n\n// ---- debug / test API';
  const insertion = '\nwindow.__foundationFirstDrawProbe.attach(nodePipeline, () => loadingCleared);';
  assert.equal(source.split(anchor).length, 2, 'Exactly one first synchronous main frame boundary required');
  const served = source.replace(anchor, insertion + anchor);
  assert.equal(served.replace(insertion, ''), source, 'First-draw observation must be exactly reversible');
  return served;
}

// Keep the normal page free of Playwright Fetch interception. The static
// server's existing handler still owns every resource except this exact module.
export function installFoundationMainResponse(server, source) {
  const listeners = server.rawListeners('request');
  assert.equal(listeners.length, 1, 'A single existing static request handler is required');
  const original = listeners[0], bytes = Buffer.from(source);
  const state = { transport: 'local-http-response', matchedRequests: 0, delegatedRequests: 0,
    restored: false, restoreConflict: false };
  let stopped = false;
  function handler(request, response) {
    let path;
    try { path = new URL(request.url, 'http://localhost').pathname; }
    catch { return original.call(this, request, response); }
    if (path !== '/src/main.js') {
      state.delegatedRequests++;
      return original.call(this, request, response);
    }
    state.matchedRequests++;
    response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
    response.end(bytes);
  }
  server.removeListener('request', original);
  server.on('request', handler);
  return {
    snapshot: () => ({ ...state }),
    restore() {
      if (stopped) return; stopped = true;
      if (!server.rawListeners('request').includes(handler)) { state.restoreConflict = true; return; }
      server.removeListener('request', handler);
      server.prependListener('request', original);
      state.restored = true;
    },
  };
}
