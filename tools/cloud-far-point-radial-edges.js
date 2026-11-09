import { farPointRadialShader } from './cloud-far-point-radial.js';

// Cache the angular cell constants, while measuring the original distances
// from each actual Float32 sample position to those same planes and cones.
export function farPointRadialEdgesShader(source) {
  const replace=(text,from,to)=>{
    if (text.split(from).length!==2) throw Error('Expected one Far radial edge boundary');
    return text.replace(from,to);
  };
  let shader=replace(farPointRadialShader(source),'  ivec2 pointRadialCell=ivec2(0);',`  ivec2 pointRadialCell=ivec2(0);
  vec2 pointRadialLatitudes=vec2(0);
  vec3 pointRadialPlanes[2];`);
  shader=replace(shader,`      float latitude=float(cell.y+side)*3.14159265359/float(size.y);
      distance=min(distance,radius*abs(sin(theta-latitude)));
      float longitude=float(cell.x+side)*6.28318530718/float(size.x);
      distance=min(distance,abs(dot(point,vec3(-sin(longitude),0,cos(longitude)))));`,`      float latitude;
      vec3 plane;
      if(pointRadialEmpty && uPointRadialMode>=3) {
        latitude=pointRadialLatitudes[side];
        plane=pointRadialPlanes[side];
      } else {
        latitude=float(cell.y+side)*3.14159265359/float(size.y);
        float longitude=float(cell.x+side)*6.28318530718/float(size.x);
        plane=vec3(-sin(longitude),0,cos(longitude));
      }
      distance=min(distance,radius*abs(sin(theta-latitude)));
      distance=min(distance,abs(dot(point,plane)));`);
  return replace(shader,'                    pointRadialCell=clamp(ivec2(floor(cellPosition)),ivec2(0),size.xy-1);',
`                    pointRadialCell=clamp(ivec2(floor(cellPosition)),ivec2(0),size.xy-1);
                    if(uPointRadialMode>=3)for(int side=0;side<2;side++) {
                      pointRadialLatitudes[side]=float(pointRadialCell.y+side)*3.14159265359/float(size.y);
                      float longitude=float(pointRadialCell.x+side)*6.28318530718/float(size.x);
                      pointRadialPlanes[side]=vec3(-sin(longitude),0,cos(longitude));
                    }`);
}
