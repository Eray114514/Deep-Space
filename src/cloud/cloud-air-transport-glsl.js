// Interval transport owned by the cloud ray. The atmosphere pass supplies the
// namespaced physical kernel and uniforms; this module owns no LUT or texture.
export const cloudAirTransportGLSL = /* glsl */`
      void cloudAirTransport(vec3 origin,vec3 dir,float a,float b,bool reuseCells,
        inout float cellEnd,inout vec3 cellExt,inout vec3 cellSource,
        out vec3 light,out vec3 transmission) {
        light=vec3(0);transmission=vec3(1);
        if(air_uEnabled<0.5 || b<=a)return;
        float limit=max(25.0,min(air_uRayleighScaleHeight,air_uMieScaleHeight)*0.1);
        float cursor=a,gapStart=a,gapPrevious=a,gapStride=0.0;
        int advanced=0,gapIndex=0,gapCount=0;
        bool gap=!reuseCells,gapReady=false,quadratic=false;
        vec3 prefixLight=vec3(0),prefixTransmission=vec3(1);
        // At most 64 cached cells followed by the original 48-cell fallback.
        // All paths submit through one physical evaluateCell/transfer call site.
        for(int work=0;work<64+int(air_uViewSteps);work++) {
          if(!gap && cursor>=b)break;
          bool evaluateCell=false,saveCell=false;
          vec3 position=vec3(0),extinction=cellExt,source=cellSource;
          float sampleLength=0.0,next=cursor;
          if(!gap) {
            if(advanced>=64) {gap=true;cellEnd=b;}
            else if(cellEnd<=cursor) {
              cellEnd=cursor+limit;
              vec3 start=origin+dir*cursor,end=origin+dir*cellEnd;
              bool crossing=false;
              for(int star=0;star<2;star++) {
                vec3 sun=star==0?air_uSunDirection0:air_uSunDirection1;
                float energy=star==0?air_uSunEnergy0:air_uSunEnergy1;
                if(energy<=0.0)continue;
                crossing=crossing || air_solarHorizonClearance(start,sun)
                  *air_solarHorizonClearance(end,sun)<=0.0;
                float v0=air_eclipseVisibility(start,sun),v1=air_eclipseVisibility(end,sun);
                crossing=crossing || min(v0,v1)<0.999 && max(v0,v1)>0.001;
              }
              if(crossing) {gap=true;cellEnd=b;}
              else {
                position=origin+dir*(cursor+limit*0.5);
                sampleLength=limit;evaluateCell=true;saveCell=true;
              }
            }
          }
          if(gap) {
            if(!gapReady) {
              prefixLight=light;prefixTransmission=transmission;
              light=vec3(0);transmission=vec3(1);
              gapStart=cursor;gapPrevious=cursor;
              float cellLimit=min(air_uRayleighScaleHeight,air_uMieScaleHeight)*0.25;
              quadratic=b-cursor>cellLimit*min(32.0,air_uViewSteps);
              gapCount=quadratic?int(air_uViewSteps)
                :int(clamp(ceil((b-cursor)/max(cellLimit,50.0)),1.0,32.0));
              gapStride=(b-cursor)/float(gapCount);gapReady=true;
            }
            if(gapIndex>=gapCount)break;
            if(quadratic) {
              next=atmosphereSampleBoundary(gapStart,b,-dot(origin,dir),float(gapIndex+1)/air_uViewSteps);
              sampleLength=next-gapPrevious;
              position=origin+dir*(gapPrevious+next)*0.5;
            } else {
              sampleLength=gapStride;
              position=origin+dir*(gapStart+(float(gapIndex)+0.5)*gapStride);
            }
            evaluateCell=true;
          } else next=min(b,cellEnd);
          if(evaluateCell)airSample(position,dir,sampleLength,extinction,source);
          if(saveCell) {cellExt=extinction;cellSource=source;}
          mediumStep(light,transmission,extinction,source,gap?sampleLength:next-cursor);
          if(gap) {gapPrevious=next;gapIndex++;}
          else {cursor=next;advanced++;}
        }
        if(gapReady) {light=prefixLight+prefixTransmission*light;transmission=prefixTransmission*transmission;}
      }
      void cloudAirGap(vec3 origin,vec3 dir,float a,float b,out vec3 light,out vec3 transmission) {
        float cellEnd=-1.0;vec3 cellExt=vec3(0),cellSource=vec3(0);
        cloudAirTransport(origin,dir,a,b,false,cellEnd,cellExt,cellSource,light,transmission);
      }
      void cloudAirAdvance(vec3 origin,vec3 dir,float a,float b,
        inout float cellEnd,inout vec3 cellExt,inout vec3 cellSource,
        out vec3 light,out vec3 transmission) {
        cloudAirTransport(origin,dir,a,b,true,cellEnd,cellExt,cellSource,light,transmission);
      }
`;
