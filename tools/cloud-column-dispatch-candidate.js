// Diagnostic source transform only; no production shader is changed.
import assert from 'node:assert/strict';

const original = `          if(uColumnsReady>0.5 && footprint>2400.0) column=cloudCachedColumn(dir,t0,t1);
          else {
            column=cloudFarColumn(dir,t0,t1);
            if(uColumnsReady>0.5 && footprint>900.0) column=mix(column,cloudCachedColumn(dir,t0,t1),smoothstep(900.0,2400.0,footprint));
          }`;
const replacement = `          bool cachedOnly=uColumnsReady>0.5 && footprint>2400.0;
          if(!cachedOnly) column=cloudFarColumn(dir,t0,t1);
          if(uColumnsReady>0.5 && footprint>900.0) {
            vec4 cachedColumn=cloudCachedColumn(dir,t0,t1);
            if(cachedOnly) column=cachedColumn;
            else column=mix(column,cachedColumn,smoothstep(900.0,2400.0,footprint));
          }`;

export function cloudColumnDispatchCandidate(source) {
  assert.equal(source.split(original).length, 2, 'One exact original far dispatch required');
  return source.replace(original, replacement);
}
