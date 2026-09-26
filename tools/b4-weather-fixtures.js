// Fixed body-local columns, not camera-picked/cloud-picked success cases.
// Append morphology/weather cases later; keep these coordinate controls.
export const B4_WEATHER_FIXTURES = Object.freeze({
  planetIndices: [0, 2, 4],
  absoluteHours: [0, 9.5, 48.5],
  altitudesMeters: [800, 12000, 300000],
  columns: [
    ['equator-x', [1, 0, 0]], ['equator-z', [0, 0, 1]],
    ['equator-minus-x', [-1, 0, 0]], ['equator-minus-z', [0, 0, -1]],
    ['north-pole', [0, 1, 0]], ['south-pole', [0, -1, 0]],
    ['seam-west', [-1, 0.25, -1e-7]], ['seam-east', [-1, 0.25, 1e-7]],
    ['north-east', [1, 0.5, 1]], ['north-west', [-1, 0.5, 1]],
    ['south-east', [1, -0.5, -1]], ['south-west', [-1, -0.5, -1]],
  ],
});
