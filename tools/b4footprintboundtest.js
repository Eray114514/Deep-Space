import assert from 'node:assert/strict';
import {minimumCloudRayCone} from '../src/cloud/cloud-footprint.js';
const ray=(x,y,horizontal,vertical)=>{
  const v=[x/horizontal,y/vertical,-1],length=Math.hypot(...v);
  return v.map(n=>n/length);
};
let checks=0,minRatio=Infinity;
for(const fov of [20,62,120,170])for(const aspect of [.45,16/9,3.8])
  for(const [width,height] of [[16,13],[736,414],[2560,1440],[3840,2160]]) {
    const vertical=1/Math.tan(fov*Math.PI/360),horizontal=vertical/aspect;
    const projection=Array(16).fill(0);projection[0]=horizontal;projection[5]=vertical;
    const bound=minimumCloudRayCone(projection,width,height);
    for(let y=0;y<=20;y++)for(let x=0;x<=20;x++) {
      const u=x/10-1,v=y/10-1,a=ray(u,v,horizontal,vertical);
      for(const [du,dv] of [[2/width,0],[0,2/height]]) {
        const b=ray(u+du,v+dv,horizontal,vertical);
        const measured=Math.hypot(...b.map((n,i)=>n-a[i]));
        assert.ok(bound<=measured+1e-12,`Unsafe ${fov}/${aspect}/${width}/${height}/${u}/${v}`);
        minRatio=Math.min(minRatio,measured/bound);checks++;
      }
    }
  }
assert.equal(minimumCloudRayCone(Array(16).fill(0),736,414),0);
console.log('PASS conservative cloud pixel cones', {checks,minRatio});
