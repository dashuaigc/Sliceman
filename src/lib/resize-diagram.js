// Fixed teaching examples, not document/output previews. Inline SVG uses only
// basic shapes supported by UXP; no image decoding, filters or external assets.
const blue = '#76a4ff';
function scene(x, y, w, h, stretch = false) {
  const sunW = Math.min(w, h * 2) * .12;
  const sunH = stretch ? h * .24 : sunW;
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#59ace5"/>
    <ellipse cx="${x + w * .4}" cy="${y + h * .3}" rx="${sunW / 2}" ry="${sunH / 2}" fill="#ffc35a"/>
    <polygon points="${x},${y + h * .78} ${x + w * .3},${y + h * .49} ${x + w * .63},${y + h} ${x},${y + h}" fill="#58aa78"/>
    <polygon points="${x + w * .18},${y + h} ${x + w * .74},${y + h * .43} ${x + w},${y + h * .72} ${x + w},${y + h}" fill="#32885b"/>`;
}
function checker(x, y, w, h) {
  let s = `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#bcc2ca"/>`;
  for (let row = 0; row < h / 8; row++) {
    for (let col = 0; col < w / 8; col++) {
      if ((row + col) % 2 === 0) s += `<rect x="${x + col * 8}" y="${y + row * 8}" width="${Math.min(8, w - col * 8)}" height="${Math.min(8, h - row * 8)}" fill="#e3e6eb"/>`;
    }
  }
  return s;
}
const arrow = '<path d="M59 43H72M67 38L72 43 67 48" fill="none" stroke="#8c98ab" stroke-width="2"/>';
function edge(x, y, w, h, vertical) {
  return vertical
    ? `<path d="M${x + w + 5} ${y}v${h}m-3 0h6m-6 ${-h}h6" fill="none" stroke="${blue}" stroke-width="2"/>`
    : `<path d="M${x} ${y - 5}h${w}m0 -3v6m${-w} -6v6" fill="none" stroke="${blue}" stroke-width="2"/>`;
}
function graphic(key) {
  if (key === 'contain') return checker(0, 0, 88, 88) + scene(0, 22, 88, 44);
  // The same 2:1 scene scaled to 176×88, then cropped 44px on each side.
  // Pre-clipped polygons avoid relying on SVG clipPath support in UXP.
  if (key === 'cover') return '<rect width="88" height="88" fill="#59ace5"/>'
    + '<circle cx="26.4" cy="26.4" r="10.56" fill="#ffc35a"/>'
    + '<polygon points="0,47.37 8.8,43.12 66.88,88 0,88" fill="#58aa78"/>'
    + '<polygon points="0,81.73 86.24,37.84 88,38.82 88,88 0,88" fill="#32885b"/>';
  if (key === 'stretch') return scene(0, 0, 88, 88, true);
  if (key === 'scale') return scene(0, 0, 88, 44);
  if (key === 'long' || key === 'short') {
    return scene(0, 12, 64, 32) + edge(0, 12, 64, 32, key === 'short')
      + scene(87, 12, 32, 64) + edge(87, 12, 32, 64, key === 'long');
  }
  if (key === 'max') {
    return `<rect x="77" y="4" width="56" height="56" fill="none" stroke="#8c98ab" stroke-dasharray="4 3"/>`
      + scene(0, 25, 52, 26) + arrow + scene(77, 18, 56, 28);
  }
  if (key === 'times') return scene(0, 32, 32, 16) + arrow + scene(76, 24, 64, 32);
  if (key === 'percent') return scene(0, 24, 52, 26) + arrow + scene(83, 31, 26, 13);
  return scene(0, 25, 52, 26) + arrow + scene(79, 29, 40, 20) + edge(79, 29, 40, 20, key === 'h');
}
const captions = {
  contain: ['保留完整图片，空白处补边', '目标1000×1000：1600×800 → 1000×1000'],
  cover: ['保持比例铺满，裁掉超出部分', '目标1000×1000：1600×800 → 1000×1000'],
  stretch: ['直接改为指定宽高，图片可能变形', '目标1000×1000：1600×800 → 1000×1000'],
  scale: ['保持比例，不补边、不裁切', '目标1000×1000：1600×800 → 1000×500'],
  w: ['输入宽度，高度按原比例自动调整', '宽度设为1000：1600×800 → 1000×500'],
  h: ['输入高度，宽度按原比例自动调整', '高度设为500：1600×800 → 1000×500'],
  long: ['按较长的一边缩放，另一边保持比例', '蓝线设为1000：横图1000×500 / 竖图500×1000'],
  short: ['按较短的一边缩放，另一边保持比例', '蓝线设为500：横图1000×500 / 竖图500×1000'],
  percent: ['宽高一起缩放，50%即各缩小一半', '缩放50%：1600×800 → 800×400'],
  times: ['宽高一起乘以倍数，比例不变', '设为2倍：1600×800 → 3200×1600'],
  max: ['超出上限才等比缩小，不放大、不补边', '上限1000×1000：1600×800 → 1000×500'],
};

export function resizeDiagram(mode = 'wh', fit = 'contain') {
  const key = mode === 'wh' ? fit : mode;
  const safe = Object.prototype.hasOwnProperty.call(captions, key) ? key : 'contain';
  const [caption, example] = captions[safe];
  return {
    asset: safe,
    anchor: mode === 'wh' && (safe === 'contain' || safe === 'cover'),
    caption,
    example,
    svg: `<svg xmlns="http://www.w3.org/2000/svg" width="140" height="88" viewBox="0 0 140 88" role="img" aria-label="${caption}">${graphic(safe)}</svg>`,
  };
}
