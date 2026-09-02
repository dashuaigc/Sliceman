// 快速平移的纯逻辑：输入解析、负数归一、方向换算。
// 不依赖 Photoshop，可在 Node 下单测（见 tests/move-core.test.js）。

/** 四个方向的反向 */
const OPPOSITE = { left: 'right', right: 'left', up: 'down', down: 'up' };

// 距离为 0 时 -1 * 0 会算出 -0；归一成 0，免得下发给 PS 和写进日志时碍眼
const z = (n) => (n === 0 ? 0 : n);

/** 取反方向；未知方向原样返回 */
export function flipDir(dir) { return OPPOSITE[dir] || dir; }

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
 * 负数归一：输入框只保存「绝对距离」，负号用来翻转方向。
 * 这样用户看到的永远是「方向 + 正数」，不会出现「左 + -20」这种双重反向。
 * @param {number} value 可能带负号的距离
 * @param {string} dir 当前方向
 * @returns {{dist:number, dir:string}}
 */
export function applySign(value, dir) {
  return value < 0 ? { dist: -value, dir: flipDir(dir) } : { dist: value, dir };
}

/**
 * 方向 + 绝对距离 → 位移量。右/下为正，左/上为负。
 * @param {{xDir:string, xDist:number, yDir:string, yDist:number}} cfg
 * @returns {{dx:number, dy:number}}
 */
export function toDelta(cfg) {
  const sx = cfg.xDir === 'left' ? -1 : 1;
  const sy = cfg.yDir === 'up' ? -1 : 1;
  return {
    dx: z(sx * (Number(cfg.xDist) || 0)),
    dy: z(sy * (Number(cfg.yDist) || 0)),
  };
}

/**
 * 键盘微调输入框：↑/↓ 加减 1，按住 Shift 加减 10。
 * 结果可能为负——交给 applySign 翻方向，于是 5 再往下按会变成「反方向 5」。
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
