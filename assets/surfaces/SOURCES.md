# Surface material sources

All source textures are CC0 assets from Poly Haven. The shipped files were
downloaded at 1K, then converted to mipmapped KTX2 on 2026-07-22 with Khronos
KTX-Software 4.4.2 through glTF Transform 4.3.0. Color and packed roughness
maps use ETC1S quality 180; tangent-space OpenGL normal maps use UASTC level 2
with RDO. No source pixels were repainted.

| Shipped prefix | Poly Haven asset | Author/source | Use |
| --- | --- | --- | --- |
| `sparse_grass_*` | `sparse_grass` | [Poly Haven](https://polyhaven.com/a/sparse_grass) | organic soil/grass structure, normal, packed ARM |
| `rock_ground_*` | `rock_ground` | [Poly Haven](https://polyhaven.com/a/rock_ground) | exposed rock/gravel structure, normal, roughness |

License: [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/).
The six shipped KTX2 files total less than 3.5 MiB; procedural palette tinting
keeps them reusable across terrestrial and alien biomes.
