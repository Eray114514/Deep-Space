import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import { productionSpeciesGLSL, productionColumnCondensateGLSL } from '../src/cloud/production-shape.js';
import { productionCloudGLSL } from '../src/cloud/production-medium-glsl.js';

// Freeze the source before extraction. A later commit must still compare against
// the independent, interpolation-free original, not evaluate the new source.
const historical=file=>readFileSync(new URL('./fixtures/cloud-column-kernel-2272e923/'+file.split('/').at(-1),import.meta.url),'utf8');
const originalSource=historical('src/cloud/production-shape.js');
const literal=originalSource.match(/export const productionSpeciesGLSL = \/\* glsl \*\/(`[^`]*`);/);
assert.ok(literal,'The independent point-density template must be present');
assert.equal(literal[1].includes('${'),false,'The reference cannot depend on current interpolation helpers');
const original=vm.runInNewContext(literal[1],{},{timeout:1000});
assert.equal(createHash('sha256').update(original).digest('hex'),
  'fd9f3ec69bc6f43a0ef171c67d3b1917b9f71db34b0fb70b5a1155f52f622f47');
assert.equal(productionSpeciesGLSL,original,'Every character of existing point-density GLSL must remain unchanged');

const mediumTemplate=historical('src/cloud/production-medium-glsl.js')
  .match(/export const productionCloudGLSL = \/\* glsl \*\/(`[^`]*`);/);
assert.ok(mediumTemplate);
const originalMedium=vm.runInNewContext(mediumTemplate[1],{productionSpeciesGLSL:original},{timeout:1000});
assert.equal(productionCloudGLSL,originalMedium,'The existing production-medium consumer must remain identical too');

function body(source,name) {
  const match=source.match(new RegExp(`  float ${name}\\([^]*?\\n  \\}`));
  assert.ok(match,`Missing GLSL function ${name}`);
  return match[0].slice(match[0].indexOf('{')+1,match[0].lastIndexOf('}'));
}
const pointBody=body(original,'speciesCondensate');
const shareStart=pointBody.indexOf('    float share=');
const heightStart=pointBody.indexOf('    if(amount<=0.0)');
assert.ok(shareStart>0&&heightStart>shareStart);
const support=pointBody.slice(1,shareStart);
const amount=pointBody.slice(shareStart,heightStart);
const profile=pointBody.slice(heightStart,-2);
assert.equal(support,'    if(!speciesHasSupport(altitude,band,baseJitter,depthJitter))return 0.0;\n');
assert.equal(body(productionColumnCondensateGLSL,'columnSpeciesAmount'),`\n${amount}    return amount;\n  `,
  'Column amount must use the original share/coverage arithmetic and early share gate');
assert.equal(body(productionColumnCondensateGLSL,'columnSpeciesCondensate'),`\n${support}${profile}  `,
  'Every support/amount gate and height-profile character must match the original');
assert.match(productionColumnCondensateGLSL,
  /columnSpeciesAmount\(vec3 frame,vec4 band,vec2 region\)/);
assert.match(productionColumnCondensateGLSL,
  /columnSpeciesCondensate\(vec3 frame,vec3 axis,float altitude,vec4 band,\n    float feature,float baseJitter,float depthJitter,int mode,float minimumDepth,float amount\)/);
assert.doesNotMatch(body(productionColumnCondensateGLSL,'columnSpeciesAmount'),/\b(?:altitude|axis|mode|feature|parameters)\b/,
  'Only horizontal dependencies may be cached across height samples');
assert.match(profile,/float cellTop=cloudNoiseAt\(frame,tile\)\.r;/,'Mode 1 stays in the unmodified height profile');
assert.match(profile,/return amount\*shape\*profile\*peak;/,'Do not reassociate the final product');
assert.doesNotMatch(productionColumnCondensateGLSL,/parameters\.w/,'Extinction multiplication remains owned by the column caller');
assert.equal((productionColumnCondensateGLSL.match(/float share=/g)||[]).length,1);
assert.equal((productionColumnCondensateGLSL.match(/vec2 fine=/g)||[]).length,1);
const producer=readFileSync(new URL('../src/cloud/cloud-column-map.js',import.meta.url),'utf8');
assert.ok(producer.includes('${productionCloudGLSL}${productionColumnCondensateGLSL}'));
const loop=producer.indexOf('for(int k=0;k<count;k++)');
const amountIndex=producer.indexOf('float columnAmount=columnSpeciesAmount(frame,band,columnRegion);');
assert.ok(amountIndex>=0 && amountIndex<loop);
assert.match(producer.slice(loop),/columnSpeciesCondensate\(frame,axis,altitude,band,parameters\.x,parameters\.y,parameters\.z,int\(shape\.x\),minimumDepth,columnAmount\)\*parameters\.w/);
assert.doesNotMatch(producer.slice(loop),/productionAreaBand\(uv,species\)|columnSpeciesAmount\(/);
const digest=createHash('sha256').update(productionSpeciesGLSL).digest('hex');
console.log(`PASS: original point-density and medium GLSL exact (${Buffer.byteLength(original)} bytes, sha256 ${digest}); shared column amount/profile/gates and multiplication order; no GPU.`);
