import { productionColumnCondensateGLSL } from './production-shape.js';
import { productionCloudGLSL } from './production-medium-glsl.js';
import { weatherAtlasGLSL } from './weather-atlas.js';

// Both producers share every per-footprint density and accumulation expression.
function cloudColumnFootprintGLSL(pixel='floor(gl_FragCoord.xy)') {
  return `
            // Deterministic stratified footprint, without RNG/frame changes.
            vec2 offset=vec2((float(p)+0.5)/float(uFootprintSamples),
              fract((float(p)+0.5)*0.61803398875));
            vec2 uv=(${pixel}+offset)/uColumnSize;
            float latitude=(0.5-uv.y)*3.14159265359,longitude=uv.x*6.28318530718;
            vec3 weatherRadial=vec3(cos(latitude)*cos(longitude),sin(latitude),cos(latitude)*sin(longitude));
            vec3 radial=transpose(uSpin)*weatherRadial;
            float surface=productionSurfaceAt(radial);
            vec2 tau=vec2(0),moment=vec2(0);
            float speciesTau[16],speciesHeight[16];int speciesFamily[16];
            for(int species=0;species<int(uSpeciesCount);species++) {
              speciesTau[species]=0.0;speciesHeight[species]=0.0;speciesFamily[species]=0;
              if(uSpeciesMask>=0.0 && abs(uSpeciesMask-float(species))>.5)continue;
              vec4 shape=speciesShapeAt(species),parameters=speciesOpticsAt(species);
              if(shape.z>0.5)continue;
              vec4 band=productionBandAt(uv,species);
              band=speciesAbsoluteBand(band,shape,surface);
              if(band.r<=0.0)continue;
              float guard=(parameters.y+parameters.z)*0.5+2.0;
              float bottom=max(surface,band.g-guard),top=band.b+guard;
              int count=min(uColumnSamples,max(8,int(ceil((top-bottom)/80.0))));
              vec3 axis,frame;productionSpeciesFrame(weatherRadial,species,axis,frame);
              float stepMeters=(top-bottom)/float(count);
              float integrated=0.0,firstMoment=0.0;
              vec2 columnRegion=productionAreaBand(uv,species);
              float minimumDepth=speciesStructureAt(species).x;
              float columnAmount=columnSpeciesAmount(frame,band,columnRegion);
              if(columnAmount<=0.0)continue;
              for(int k=0;k<count;k++) {
                // A space-facing ray first interacts at the top of a dense
                // deck, not at its extinction-weighted interior centroid.
                float altitude=top-(float(k)+0.5)*stepMeters;
                float sigma=columnSpeciesCondensate(frame,axis,altitude,band,parameters.x,parameters.y,parameters.z,int(shape.x),minimumDepth,columnAmount)*parameters.w;
                float opticalDepth=sigma*stepMeters;
                firstMoment+=exp(-integrated)*(1.0-exp(-opticalDepth))*altitude;
                integrated+=opticalDepth;
              }
              int family=shape.y<.5?0:1;speciesFamily[species]=family;
              speciesTau[species]=integrated;
              speciesHeight[species]=firstMoment/max(1.0-exp(-integrated),1e-20);
              tau[family]+=integrated;
            }
            for(int species=0;species<int(uSpeciesCount);species++) {
              if(speciesTau[species]<=0.0)continue;
              float above=0.0;
              for(int other=0;other<int(uSpeciesCount);other++) {
                if(speciesFamily[other]!=speciesFamily[species])continue;
                if(speciesHeight[other]>speciesHeight[species]
                  || (speciesHeight[other]==speciesHeight[species] && other>species))above+=speciesTau[other];
              }
              moment[speciesFamily[species]]+=exp(-above)*(1.0-exp(-speciesTau[species]))*speciesHeight[species];
            }
            vec2 opacity=vec2(1)-exp(-tau);
            total+=vec4(opacity,tau);
            jointOpacity+=1.0-exp(-tau.x-tau.y);
            altitudeMoment+=moment;weightMoment+=opacity;
          `;
}

export function cloudColumnFragmentGLSL({tiled=false}={}) {
  const prefix=`precision highp sampler3D;uniform sampler3D uNoise3;
      uniform sampler2D uWeatherMapHi;uniform mat3 uSpin;
      uniform vec3 uCOff;uniform float uBodyR,uSurfaceRange,uRin,uRout;
      ${weatherAtlasGLSL}\n${productionCloudGLSL}${productionColumnCondensateGLSL}`;
  if(tiled)return prefix+`
        uniform vec2 uColumnSize,uColumnTileOrigin,uColumnTargetOrigin;
        uniform int uColumnSamples,uFootprintSamples,uColumnFootprintStart,uColumnFootprintCount;
        uniform sampler2D uColumnPreviousTotal,uColumnPreviousMoments,uColumnPreviousJoint;
        layout(location=0) out vec4 optical;
        layout(location=1) out vec4 heights;
        #if COLUMN_TILE_FINAL == 0
          layout(location=2) out vec4 columnCarry;
        #endif
        void main() {
          ivec2 tileCell=ivec2(gl_FragCoord.xy)-ivec2(uColumnTargetOrigin);
          vec2 globalCell=vec2(tileCell)+uColumnTileOrigin;
          vec4 total=vec4(0);vec2 altitudeMoment=vec2(0),weightMoment=vec2(0);float jointOpacity=0.0;
          if(uColumnFootprintStart>0) {
            total=texelFetch(uColumnPreviousTotal,tileCell,0);
            vec4 saved=texelFetch(uColumnPreviousMoments,tileCell,0);
            altitudeMoment=saved.xy;weightMoment=saved.zw;
            jointOpacity=texelFetch(uColumnPreviousJoint,tileCell,0).x;
          }
          for(int p=uColumnFootprintStart;p<uColumnFootprintStart+uColumnFootprintCount;p++) {${cloudColumnFootprintGLSL('globalCell')}}
          #if COLUMN_TILE_FINAL == 1
          total/=float(uFootprintSamples);
          optical=vec4(total.xy,log(vec2(1)+total.zw)/log(129.0));
          heights=vec4(altitudeMoment/max(weightMoment,vec2(0.000001)),jointOpacity/float(uFootprintSamples),1);
          #else
          optical=total;heights=vec4(altitudeMoment,weightMoment);
          columnCarry=vec4(jointOpacity,0.0,0.0,0.0);
          #endif
        }`;
  return prefix+`
        uniform vec2 uColumnSize; uniform int uColumnSamples,uFootprintSamples;
        layout(location=0) out vec4 optical;
        layout(location=1) out vec4 heights;
        void main() {
          vec4 total=vec4(0);vec2 altitudeMoment=vec2(0),weightMoment=vec2(0);float jointOpacity=0.0;
          for(int p=0;p<uFootprintSamples;p++) {${cloudColumnFootprintGLSL()}}
          total/=float(uFootprintSamples);
          optical=vec4(total.xy,log(vec2(1)+total.zw)/log(129.0));
          heights=vec4(altitudeMoment/max(weightMoment,vec2(0.000001)),jointOpacity/float(uFootprintSamples),1);
        }`;
}
