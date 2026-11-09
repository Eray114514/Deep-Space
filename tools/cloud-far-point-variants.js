function replaceOnce(source, from, to) {
  if (source.split(from).length !== 2) throw Error('Expected one Far point shader boundary');
  return source.replace(from, to);
}

export function farPointVariants(source) {
  const lightStart = '        vec3 local=uCameraLocal+dir*t;\n        vec3 source=cloudCombinedSource(local,dir,0.0,uRout-uRin,0.0);';
  const output = '        return vec4((light+transmission*source*uTint)*moment,moment);';
  const a = source.indexOf(lightStart), b = source.indexOf(output);
  if (a < 0 || b <= a) throw Error('Missing Far point lighting');
  const density = replaceOnce(source, source.slice(a,b+output.length), '        return vec4(t,0.0,0.0,moment);');

  const inward = '        float radiusStart=length(uCameraLocal+dir*start);';
  const light = '        if(moment<0.004) return vec4(0.0);';
  const start = source.indexOf(inward), end = source.indexOf(light);
  if (start < 0 || end <= start) throw Error('Missing Far point radial traversal');
  const shared = replaceOnce(source, source.slice(start,end), `        float impact=sqrt(impact2);
        float radiusStart=length(uCameraLocal+dir*start);
        float radiusEnd=length(uCameraLocal+dir*min(end,closest));
        float T=1.0, moment=0.0, weightedDistance=0.0;
        float previous=start;
        int columns=int(uColumnSteps);
        for(int leg=0;leg<2;leg++) {
          if(leg==1) {
            if(!(end>closest && T>=0.0002))break;
            radiusStart=impact;radiusEnd=length(uCameraLocal+dir*end);
            previous=closest;
          }
          for(int k=0;k<columns;k++) {
            float radius=mix(radiusStart,radiusEnd,float(k+1)/float(columns));
            float delta=sqrt(max(0.0,(radius-impact)*(radius+impact)));
            float next=min(end,leg==0?closest-delta:closest+delta);
            float distance=max(0.0,next-previous);
            float middle=(next+previous)*0.5;
            float ext=cloudExtinctionAt(uCameraLocal+dir*middle,0.0);
            float weight=T*(1.0-exp(-ext*distance));
            weightedDistance+=middle*weight; moment+=weight; T-=weight;
            previous=next;
            if(T<0.0002)break;
          }
        }
`);
  return {density,shared};
}
