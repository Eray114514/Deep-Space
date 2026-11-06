// Compiler attribution only: the point-column program is valid only when the
// caller does not require cached-column blending. No runtime route is installed.
import assert from 'node:assert/strict';
const original = `          if(uColumnsReady>0.5 && footprint>2400.0) column=cloudCachedColumn(dir,t0,t1);
          else {
            column=cloudFarColumn(dir,t0,t1);
            if(uColumnsReady>0.5 && footprint>900.0) column=mix(column,cloudCachedColumn(dir,t0,t1),smoothstep(900.0,2400.0,footprint));
          }`;
export function cloudPointProgramCandidate(source) {
  assert.equal(source.split(original).length, 2);
  return source.replace(original, '          column=cloudFarColumn(dir,t0,t1);');
}
