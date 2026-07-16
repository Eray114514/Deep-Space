import bpy
from pathlib import Path


project = Path(bpy.data.filepath).parent
root = bpy.data.objects.get("ASTERION_HERO_ROOT")
if root is None:
    raise RuntimeError("ASTERION_HERO_ROOT was not found in the ship source file")

bpy.ops.object.select_all(action="DESELECT")
stack = [root]
while stack:
    obj = stack.pop()
    obj.select_set(True)
    stack.extend(obj.children)

bpy.context.view_layer.objects.active = root
bpy.ops.export_scene.gltf(
    filepath=str(project / "asterion-s9-raw.glb"),
    export_format="GLB",
    use_selection=True,
    export_animations=False,
    export_yup=True,
    export_apply=True,
)
print("Exported static ship hierarchy to asterion-s9-raw.glb")
