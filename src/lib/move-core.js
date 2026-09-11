// 快速平移的纯逻辑：八方向换算、输入解析、负数归一。
// 不依赖 Photoshop，可在 Node 下单测（见 tests/move-core.test.js）。

/** 八个方向（四正向 + 四斜向）。名字同时就是 HTML 里 data-dir 的取值。 */
export const DIRS = ['upLeft', 'up', 'upRight', 'left', 'right', 'downLeft', 'down', 'downRight'];

// 方向 → 单位向量。右/下为正，和 PS 的 offset 描述符同一套符号，省掉中间翻译
const VEC = {
  upLeft: [-1, -1], up: [0, -1], upRight: [1, -1],
  left: [-1, 0], right: [1, 0],
  downLeft: [-1, 1], down: [0, 1], downRight: [1, 1],
};

// 距离为 0 时 -1 * 0 会算出 -0；归一成 0，免得下发给 PS 和写进日志时碍眼
const z = (n) => (n === 0 ? 0 : n);

/** 方向 → 单位向量；认不出的方向给零向量（调用方据此不下发） */
export function dirVector(dir) {
  const v = VEC[dir];
  return v ? { sx: v[0], sy: v[1] } : { sx: 0, sy: 0 };
}

/** 单位向量 → 方向名；(0,0) 这种八个方向里没有的组合返回 null */
export function dirFromVector(sx, sy) {
  const x = Math.sign(sx);
  const y = Math.sign(sy);
  return DIRS.find((d) => VEC[d][0] === x && VEC[d][1] === y) || null;
}

/**
 * 这个方向要填几个值：斜向两个轴都要，正向只要一个。
 * 界面据此显隐输入框 —— 选「向右」时垂直距离框根本不出现，
 * 也就不会把上一次填的垂直值偷偷带上，让对象斜着跑。
 * @returns {{x:boolean, y:boolean}}
 */
export function dirAxes(dir) {
  const { sx, sy } = dirVector(dir);
  return { x: sx !== 0, y: sy !== 0 };
}

/** 整个反向：两个分量都取反（↖ → ↘） */
export function flipDir(dir) {
  const { sx, sy } = dirVector(dir);
  return dirFromVector(-sx, -sy) || dir;
}

/** 只翻一个轴：↖ 翻水平轴是 ↗。用不到那个轴的方向原样返回（↑ 翻水平轴还是 ↑） */
export function flipAxis(dir, axis) {
  const { sx, sy } = dirVector(dir);
  const next = axis === 'x' ? dirFromVector(-sx, sy) : dirFromVector(sx, -sy);
  return next || dir;
}

/**
 * 解析距离输入框的内容。
 * 空 → 0（该轴不移动）；小数允许（PS 支持亚像素定位）；非数字 → null（调用方置错误态、不执行）。
 * @param {*} raw
 * @returns {number|null}
 */
export function parseDistance(raw) {
  const s = String(raw ?? '').trim();
  if (s === '') return 0;
  if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(s)) return null;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * 方向 + 两个轴的输入值 → 位移量。整个平移功能的换算都收在这一个函数里。
 * - 该方向**用不到的轴一律置 0**：选「向右」时哪怕垂直框里还留着 30，也只往右走；
 * - 负数不算错：把那**一个轴**翻个向（→ 填 -20 等于 ← 20），返回翻过之后的方向，
 *   界面据此点亮对面那一格 —— 用户看到的永远是「方向 + 正数」，
 *   不会出现「← 配 -20」这种要在脑子里算两次的双重反向。
 * @param {string} dir DIRS 里的一个
 * @param {number} xVal 水平输入值（可带负号）
 * @param {number} yVal 垂直输入值（可带负号）
 * @returns {{dx:number, dy:number, dir:string, xDist:number, yDist:number}}
 *          dx/dy 是最终位移（右/下为正），xDist/yDist 是归一成正数后该回填到框里的值
 */
export function planMove(dir, xVal, yVal) {
  let { sx, sy } = dirVector(dir);
  let x = Number(xVal) || 0;
  let y = Number(yVal) || 0;
  if (sx === 0) x = 0;
  else if (x < 0) { sx = -sx; x = -x; }
  if (sy === 0) y = 0;
  else if (y < 0) { sy = -sy; y = -y; }
  return { dx: z(sx * x), dy: z(sy * y), dir: dirFromVector(sx, sy) || dir, xDist: x, yDist: y };
}

/**
 * 键盘微调输入框：↑/↓ 加减 1，按住 Shift 加减 10。
 * 结果可能为负——交给 planMove 翻那一轴的方向，于是 5 再往下按会变成「反方向 5」。
 */
export function nudgeValue(value, up, shift) {
  return (Number(value) || 0) + (up ? 1 : -1) * (shift ? 10 : 1);
}

/** 距离显示：最多两位小数，去掉尾随的 0（避免浮点算出 10.000000000000002） */
export function formatDist(n) {
  if (!Number.isFinite(Number(n))) return '0';
  return String(Math.round(Number(n) * 100) / 100);
}

/** 位移量 → 「右 20px、下 10px」这样的可读描述；全 0 返回空串 */
export function describeDelta(dx, dy) {
  const parts = [];
  if (dx) parts.push(`${dx > 0 ? '右' : '左'} ${formatDist(Math.abs(dx))}px`);
  if (dy) parts.push(`${dy > 0 ? '下' : '上'} ${formatDist(Math.abs(dy))}px`);
  return parts.join('、');
}
