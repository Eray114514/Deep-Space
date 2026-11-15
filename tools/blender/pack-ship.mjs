// Pack the raw Blender export into the shipped GLB.
//
//   node tools/blender/pack-ship.mjs <raw.glb> <out.glb>
//
// Meshopt-compressed like the other hero assets, but POSITION stays float:
// the ship shaders evaluate their weathering noise in object space (metres),
// and position quantisation would hide a per-node scale in every mesh.
import { NodeIO, PropertyType } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTMeshoptCompression } from '@gltf-transform/extensions';
import { dedup, prune, quantize, reorder, weld } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  console.error('usage: node tools/blender/pack-ship.mjs <raw.glb> <out.glb>');
  process.exit(1);
}
await MeshoptDecoder.ready;
await MeshoptEncoder.ready;
const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });
const document = await io.read(input);
// Blender can only export baked light as a second vertex colour; the game
// reads it as a custom attribute (three's loader drops COLOR_1).
for (const mesh of document.getRoot().listMeshes()) {
  for (const primitive of mesh.listPrimitives()) {
    const light = primitive.getAttribute('COLOR_1');
    if (!light) continue;
    primitive.setAttribute('_IRRADIANCE', light);
    primitive.setAttribute('COLOR_1', null);
  }
}
await document.transform(
  // never merge materials: the game keys its surfaces on their names
  dedup({ propertyTypes: [PropertyType.ACCESSOR, PropertyType.MESH, PropertyType.TEXTURE] }),
  // quantise first: baked light is per face corner, and corners only weld
  // back into shared vertices once their values are snapped to 8 bits
  quantize({ pattern: /^(NORMAL|TEXCOORD_\d+|COLOR_\d+|_\w+)$/, quantizeNormal: 10, quantizeTexcoord: 14, quantizeColor: 8, quantizeGeneric: 8 }),
  weld(),
  prune({ keepAttributes: true, keepLeaves: true }),
  reorder({ encoder: MeshoptEncoder }),
);
document.createExtension(EXTMeshoptCompression)
  .setRequired(true)
  .setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.QUANTIZE });
await io.write(output, document);
const root = document.getRoot();
let triangles = 0;
for (const mesh of root.listMeshes()) {
  for (const primitive of mesh.listPrimitives()) triangles += (primitive.getIndices()?.getCount() ?? 0) / 3;
}
console.log(`packed ${output}: ${root.listNodes().length} nodes, ${root.listMaterials().length} materials, ${triangles} triangles`);
