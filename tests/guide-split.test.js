import { describe, it, expect } from 'vitest';
import {
  cellsFromGuides, contentBoxes,
  ERR_NO_CANVAS, ERR_NO_GUIDES, ERR_ONE_CELL,
} from '../src/lib/guide-split.js';

const CANVAS = { width: 400, height: 300 };
const g = (vertical = [], horizontal = []) => ({ vertical, horizontal });

/**
 * 造一小块 RGBA 当「拍平层的像素」：
 * @param {number} w 宽
 * @param {number} h 高
 * @param {Array<{left:number,top:number,right:number,bottom:number}>} filled 这些矩形填成不透明
 */
function makeRgba(w, h, filled) {
  const buf = new Uint8Array(w * h * 4);
  for (const r of filled) {
    for (let y = r.top; y < r.bottom; y++) {
      for (let x = r.left; x < r.right; x++) buf[(y * w + x) * 4 + 3] = 255;
    }
  }
  return buf;
}

describe('参考线 → 网格单元格', () => {
  it('3 竖 2 横 = 4 列 × 3 行 = 12 格，按行主序排（上到下、每行左到右）', () => {
    const r = cellsFromGuides(g([100, 200, 300], [100, 200]), CANVAS);
    expect(r.error).toBeUndefined();
    expect([r.cols, r.rows]).toEqual([4, 3]);
    expect(r.cells).toHaveLength(12);
    // 第一格是左上，第二格是它右边的（行主序），最后一格是右下
    expect(r.cells[0]).toEqual({ left: 0, top: 0, right: 100, bottom: 100, row: 1, col: 1 });
    expect(r.cells[1]).toEqual({ left: 100, top: 0, right: 200, bottom: 100, row: 1, col: 2 });
    expect(r.cells[11]).toEqual({ left: 300, top: 200, right: 400, bottom: 300, row: 3, col: 4 });
    // 格子首尾相接、完整铺满画布，不重叠不漏缝
    const area = r.cells.reduce((s, c) => s + (c.right - c.left) * (c.bottom - c.top), 0);
    expect(area).toBe(CANVAS.width * CANVAS.height);
  });

  it('只有竖线 → 切出整条的列；只有横线 → 切出整条的行', () => {
    const cols = cellsFromGuides(g([150], []), CANVAS);
    expect([cols.cols, cols.rows]).toEqual([2, 1]);
    expect(cols.cells.every((c) => c.top === 0 && c.bottom === 300)).toBe(true);

    const rows = cellsFromGuides(g([], [150]), CANVAS);
    expect([rows.cols, rows.rows]).toEqual([1, 2]);
    expect(rows.cells.every((c) => c.left === 0 && c.right === 400)).toBe(true);
  });

  it('坐标一律取整（选区要整数像素，否则边缘会带半透明）', () => {
    const r = cellsFromGuides(g([133.6], [99.4]), CANVAS);
    expect(r.cells.map((c) => [c.left, c.top, c.right, c.bottom])).toEqual([
      [0, 0, 134, 99], [134, 0, 400, 99],
      [0, 99, 134, 300], [134, 99, 400, 300],
    ]);
  });

  it('压在画布边缘、跑到画布外、两条肉眼重合的线都不会切出碎条', () => {
    // 0 与画布宽本来就是外边界；-20 / 500 在画布外；200 与 200.4 取整后重合
    const r = cellsFromGuides(g([0, 400, -20, 500, 200, 200.4], [150]), CANVAS);
    expect([r.cols, r.rows]).toEqual([2, 2]);
    expect(r.cells.every((c) => c.right - c.left >= 1 && c.bottom - c.top >= 1)).toBe(true);
  });

  it('没有参考线 / 只切出 1 格 / 没有画布 → 各自给出错误，不返回格子', () => {
    expect(cellsFromGuides(g([], []), CANVAS).error).toBe(ERR_NO_GUIDES);
    // 有参考线，但全压在边缘上 → 等于没切开
    expect(cellsFromGuides(g([0], []), CANVAS).error).toBe(ERR_ONE_CELL);
    expect(cellsFromGuides(g([100], []), null).error).toBe(ERR_NO_CANVAS);
  });
});

describe('每格内容的紧贴外框', () => {
  const cells = cellsFromGuides(g([50], [50]), { width: 100, height: 100 }).cells;
  const bounds = { left: 0, top: 0, right: 100, bottom: 100 };

  it('整格全透明 → null（空白格不该切出空图层）', () => {
    // 只在左上格里画一块，其余三格全空
    const rgba = makeRgba(100, 100, [{ left: 10, top: 10, right: 20, bottom: 20 }]);
    const boxes = contentBoxes(rgba, bounds, cells);
    expect(boxes[0]).toEqual({ left: 10, top: 10, right: 20, bottom: 20 });
    expect(boxes.slice(1)).toEqual([null, null, null]);
  });

  it('内容偏在格子一角时外框≠格子——这就是要校正位移的原因', () => {
    // 右下格里内容贴着右下角，格子是 50..100，内容只有 90..100
    const rgba = makeRgba(100, 100, [{ left: 90, top: 90, right: 100, bottom: 100 }]);
    const box = contentBoxes(rgba, bounds, cells)[3];
    expect(box).toEqual({ left: 90, top: 90, right: 100, bottom: 100 });
    expect(box).not.toEqual({ left: 50, top: 50, right: 100, bottom: 100 });
  });

  it('内容铺满整格（如带背景的拍平图）→ 外框就是格子本身', () => {
    const rgba = makeRgba(100, 100, [{ left: 0, top: 0, right: 100, bottom: 100 }]);
    const boxes = contentBoxes(rgba, bounds, cells);
    expect(boxes[0]).toEqual({ left: 0, top: 0, right: 50, bottom: 50 });
    expect(boxes[3]).toEqual({ left: 50, top: 50, right: 100, bottom: 100 });
  });

  it('拍平层只占画布一角时，落在它之外的格子算空', () => {
    // 像素缓冲只覆盖画布左上 60×60，右下格完全在它之外
    const small = { left: 0, top: 0, right: 60, bottom: 60 };
    const rgba = makeRgba(60, 60, [{ left: 0, top: 0, right: 60, bottom: 60 }]);
    const boxes = contentBoxes(rgba, small, cells);
    expect(boxes[0]).toEqual({ left: 0, top: 0, right: 50, bottom: 50 });
    expect(boxes[1]).toEqual({ left: 50, top: 0, right: 60, bottom: 50 });   // 与缓冲求交
    expect(boxes[3]).toEqual({ left: 50, top: 50, right: 60, bottom: 60 });
  });

  it('半透明像素按 alpha 阈值判定（默认 8）', () => {
    const rgba = new Uint8Array(100 * 100 * 4);
    rgba[(10 * 100 + 10) * 4 + 3] = 4;          // 几乎透明的噪点
    expect(contentBoxes(rgba, bounds, cells)[0]).toBeNull();
    expect(contentBoxes(rgba, bounds, cells, 2)[0])
      .toEqual({ left: 10, top: 10, right: 11, bottom: 11 });
  });
});
