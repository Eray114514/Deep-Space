// Tool-only: share the density call between inbound/outbound radial columns.
// Keep all radial nodes, early exits, optical weights and their ordering.
import assert from 'node:assert/strict';

export function cloudColumnHalvesCandidate(source) {
  const start = '        for(int k=0;k<columns;k++) {';
  const first = source.indexOf('      vec4 cloudFarColumn(');
  assert.ok(first >= 0);
  const a = source.indexOf(start, first), b = source.indexOf('        if(moment<0.004)', a);
  assert.ok(a > first && b > a);
  const original = source.slice(a, b);
  assert.equal(original.split('cloudExtinctionAt(').length, 3);
  assert.equal(original.split('for(int k=0;k<columns;k++)').length, 3);
  const replacement = `        for(int side=0;side<(end>closest?2:1);side++) {
          if(side==1) {
            if(T<0.0002)break;
            radiusStart=sqrt(impact2);radiusEnd=length(uCameraLocal+dir*end);
            previous=closest;
          }
          for(int k=0;k<columns;k++) {
            float radius=mix(radiusStart,radiusEnd,float(k+1)/float(columns));
            float offset=sqrt(max(0.0,(radius-sqrt(impact2))*(radius+sqrt(impact2))));
            float next=min(end,side==0?closest-offset:closest+offset);
            float distance=max(0.0,next-previous),middle=(next+previous)*0.5;
            float ext=cloudExtinctionAt(uCameraLocal+dir*middle,0.0);
            float weight=T*(1.0-exp(-ext*distance));
            weightedDistance+=middle*weight;moment+=weight;T-=weight;previous=next;
            if(T<0.0002)break;
          }
        }
`;
  return source.slice(0, a) + replacement + source.slice(b);
}
