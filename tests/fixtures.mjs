export function pose(action, offset = 0, width = 640, height = 480) {
  const points = Array.from({ length: 33 }, () => ({ x: 0, y: 0, visibility: 0 }));
  const coordinates = {
    0: [320, 120], 9: [330, 137], 10: [310, 137], 11: [370, 185], 12: [270, 185],
    13: [380, 235], 14: [260, 235], 15: [380, 289], 16: [260, 289],
  };
  const positions = {
    'hands-up': { 13: [391, 141], 14: [249, 141], 15: [380, 68], 16: [260, 68] },
    'arms-out': { 13: [418, 187], 14: [222, 187], 15: [474, 188], 16: [166, 188] },
    'arms-crossed': { 13: [376, 246], 14: [264, 246], 15: [265, 218], 16: [371, 229] },
    'wave-left': { 15: [409 + offset, 147] },
    'wave-right': { 16: [231 - offset, 147] },
    'hand-on-chin': { 13: [345, 233], 15: [333, 164], 17: [324, 154], 19: [318, 150] },
    'chin-right': { 14: [295, 233], 16: [307, 164], 18: [316, 154], 20: [322, 150] },
  };
  for (const [index, [x, y]] of Object.entries({ ...coordinates, ...positions[action] })) {
    points[index] = { x: x / width, y: y / height, visibility: 0.99 };
  }
  return points;
}
