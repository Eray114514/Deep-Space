export function nearReplayShader(source, variant) {
  const replace=(from,to,reverse=false)=>{
    if(reverse)[from,to]=[to,from];
    if(source.split(from).length!==2)throw Error('Unexpected near replay shader boundary');
    source=source.replace(from,to);
  };
  if(variant==='prefix') {
    // The runtime owns the prefix. Reconstruct the pre-prefix control.
    replace('        float totalOpacity=0.0;',`        float totalOpacity=0.0;
        // Before the first positive extinction, every density cell leaves T at
        // one. Resume at the original step and distance to preserve the grid.
        int firstDensityStep=-1;
        float firstDensityDistance=0.0;`,true);
    replace(`          relativeDistance=0.0;T=1.0;int bin=0;
          for(int i=0;i<STEPS;i++) {`,`          relativeDistance=pass==1?firstDensityDistance:0.0;T=1.0;int bin=0;
          for(int i=pass==1?max(0,firstDensityStep):0;i<STEPS;i++) {`,true);
    replace('            float nextT=T*exp(-ext*cellLength);',`            if(pass==0 && firstDensityStep<0 && ext>0.0) {
              firstDensityStep=i;
              firstDensityDistance=relativeDistance;
            }
            float nextT=T*exp(-ext*cellLength);`,true);
  } else if(variant==='blocks') {
    source=nearReplayShader(source,'prefix');
    replace('        float totalOpacity=0.0;',`        float totalOpacity=0.0;
        vec2 checkpoints[8];
        int checkpointCount=0;
        int stride=(STEPS+7)/8;`);
    replace(`          relativeDistance=0.0;T=1.0;int bin=0;
          for(int i=0;i<STEPS;i++) {
            if(relativeDistance>=seg)break;`,`          relativeDistance=0.0;T=1.0;int bin=0;
          int block=0,boundary=0;
          for(int i=0;i<STEPS;i++) {
            if(relativeDistance>=seg)break;
            if(i==boundary) {
              block++;boundary+=stride;
              if(pass==0) {
                checkpoints[block-1]=vec2(relativeDistance,T);
                checkpointCount=block;
              } else if(block<checkpointCount) {
                vec2 next=checkpoints[block];
                float probability=totalOpacity*(float(bin)+0.5)/float(bins);
                if(1.0-next.y<probability) {
                  relativeDistance=next.x;T=next.y;i=boundary-1;
                  continue;
                }
              }
            }`);
  } else throw Error(`Unknown near replay shader variant ${variant}`);
  return source;
}
