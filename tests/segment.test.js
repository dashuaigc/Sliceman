import { describe, it, expect } from 'vitest';
import { labelComponents, downsampleAlpha, findElementBounds, orderRowMajor } from '../src/lib/segment.js';

/** 造一张 w*h 的 0/1 网格，把给定矩形涂成 1 */
function grid(w, h, rects = []) {
  const a = new Uint8Array(w * h);
  for (const r of rects) {
    for (let y = r.top; y < r.bottom; y++)
      for (let x = r.left; x < r.right; x++)
        a[y * w + x] = 1;
  }
  return a;
}

/** 造一张 w*h 的 RGBA 缓冲，把给定矩形涂成不透明 */
function rgba(w, h, rects = []) {
  const buf = new Uint8Array(w * h * 4);
  for (const r of rects) {
    for (let y = r.top; y < r.bottom; y++)
      for (let x = r.left; x < r.right; x++) {
        const i = (y * w + x) * 4;
        buf[i] = buf[i + 1] = buf[i + 2] = 200; buf[i + 3] = 255;
      }
  }
  return buf;
}

describe('labelComponents', () => {
  it('两个分开的矩形 → 两个连通域', () => {
    const a = grid(20, 10, [{ left: 1, top: 1, right: 4, bottom: 4 }, { left: 12, top: 5, right: 18, bottom: 9 }]);
    const boxes = labelComponents(a, 20, 10, 1);
    expect(boxes).toHaveLength(2);
  });

  it('对角相接（8 连通）→ 算同一块', () => {
    // A 占 (0,0)-(2,2)，B 占 (2,2)-(4,4)，仅角对角接触
    const a = grid(6, 6, [{ left: 0, top: 0, right: 2, bottom: 2 }, { left: 2, top: 2, right: 4, bottom: 4 }]);
    expect(labelComponents(a, 6, 6, 1)).toHaveLength(1);
  });

  it('隔了空行/空列 → 分开', () => {
    const a = grid(10, 10, [{ left: 0, top: 0, right: 2, bottom: 2 }, { left: 5, top: 5, right: 8, bottom: 8 }]);
    expect(labelComponents(a, 10, 10, 1)).toHaveLength(2);
  });

  it('L 形 / 凹形是同一个连通域', () => {
    const a = grid(6, 6, [{ left: 1, top: 1, right: 2, bottom: 5 }, { left: 1, top: 4, right: 5, bottom: 5 }]);
    expect(labelComponents(a, 6, 6, 1)).toHaveLength(1);
  });

  it('minArea 过滤小块噪点', () => {
    const a = grid(20, 20, [{ left: 0, top: 0, right: 1, bottom: 1 }, { left: 5, top: 5, right: 15, bottom: 15 }]);
    const boxes = labelComponents(a, 20, 20, 50);
    expect(boxes).toHaveLength(1);
    expect(boxes[0]).toMatchObject({ left: 5, top: 5, right: 15, bottom: 15 });
  });

  it('边界框正确', () => {
    const a = grid(30, 20, [{ left: 3, top: 4, right: 10, bottom: 12 }]);
    const boxes = labelComponents(a, 30, 20, 1);
    expect(boxes[0]).toMatchObject({ left: 3, top: 4, right: 10, bottom: 12 });
  });
});

describe('downsampleAlpha', () => {
  it('factor=2 降采样尺寸正确', () => {
    const buf = rgba(8, 8, [{ left: 0, top: 0, right: 8, bottom: 8 }]);
    const { alpha, w, h } = downsampleAlpha(buf, 8, 8, 2);
    expect(w).toBe(4); expect(h).toBe(4);
    expect(Array.from(alpha)).toEqual(new Array(16).fill(1));
  });

  it('块内只要有一个实心像素就记 1', () => {
    const buf = rgba(8, 8, [{ left: 0, top: 0, right: 1, bottom: 1 }]);   // 只有 (0,0) 一个像素
    const { alpha } = downsampleAlpha(buf, 8, 8, 2);
    expect(alpha[0]).toBe(1);
    expect(alpha[1]).toBe(0);
  });

  it('低于 alpha 阈值视为空', () => {
    const buf = new Uint8Array(4 * 4 * 4);
    buf[3] = 4;   // alpha=4 < 阈值 8
    const { alpha } = downsampleAlpha(buf, 4, 4, 1, 8);
    expect(Array.from(alpha)).toEqual(new Array(16).fill(0));
  });
});

describe('findElementBounds', () => {
  it('两个分散元素 → 两个原始像素边界框', () => {
    const buf = rgba(100, 60, [{ left: 4, top: 4, right: 20, bottom: 20 }, { left: 60, top: 30, right: 90, bottom: 50 }]);
    const boxes = findElementBounds(buf, 100, 60, { factor: 2, minAreaPx: 64 });
    expect(boxes).toHaveLength(2);
    // 每个框大致包住对应元素（降采样外扩 1 格，允许误差）
    for (const b of boxes) {
      expect(b.right - b.left).toBeGreaterThanOrEqual(14);
      expect(b.bottom - b.top).toBeGreaterThanOrEqual(14);
    }
  });

  it('整图填满 → 单个连通域', () => {
    const buf = rgba(50, 50, [{ left: 0, top: 0, right: 50, bottom: 50 }]);
    expect(findElementBounds(buf, 50, 50, { factor: 2, minAreaPx: 1 })).toHaveLength(1);
  });

  it('排序规则由 orderRowMajor 提供（行序），详见下方 orderRowMajor 组', () => {
    // 行序排列的断言在 orderRowMajor describe 中覆盖；这里只确认多块输出数量正确
    const buf = rgba(100, 100, [{ left: 0, top: 0, right: 10, bottom: 10 }, { left: 30, top: 30, right: 90, bottom: 90 }]);
    expect(findElementBounds(buf, 100, 100, { factor: 1, minAreaPx: 1 })).toHaveLength(2);
  });

  it('结果坐标钳制在图内', () => {
    const buf = rgba(40, 30, [{ left: 36, top: 26, right: 40, bottom: 30 }]);
    const boxes = findElementBounds(buf, 40, 30, { factor: 2, minAreaPx: 1 });
    for (const b of boxes) {
      expect(b.right).toBeLessThanOrEqual(40);
      expect(b.bottom).toBeLessThanOrEqual(30);
      expect(b.left).toBeGreaterThanOrEqual(0);
      expect(b.top).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('orderRowMajor（行序排列：从上到下、每行从左到右）', () => {
  it('两行三块：第一行左→右，再到第二行', () => {
    // 第一行 y 5-10：B 在左 A 在右；第二行 y 20-30：C
    const A = { left: 40, top: 5, right: 60, bottom: 10 };
    const B = { left: 0, top: 5, right: 20, bottom: 10 };
    const C = { left: 10, top: 20, right: 30, bottom: 30 };
    expect(orderRowMajor([A, B, C]).map(b => b.left)).toEqual([0, 40, 10]);
  });

  it('高度不同的两块纵向有重叠 → 算同一行，按 left 排', () => {
    // A 高（y0-40），B 矮（y10-20）但和 A 纵向重叠 → 同行；B 在 A 右边
    const A = { left: 0, top: 0, right: 30, bottom: 40 };
    const B = { left: 50, top: 10, right: 80, bottom: 20 };
    expect(orderRowMajor([B, A])).toEqual([A, B]);
  });

  it('错开的行（无纵向重叠）→ 严格分两行', () => {
    const A = { left: 30, top: 0, right: 60, bottom: 10 };
    const B = { left: 0, top: 20, right: 20, bottom: 30 };
    expect(orderRowMajor([A, B])).toEqual([A, B]);   // 虽 B 的 left 更小，但 A 在上面一行
  });

  it('findElementBounds 输出即为行序（不再是面积序）', () => {
    // 左上小块 + 右下大块：行序应左上在前，尽管大块面积更大
    const buf = rgba(100, 100, [
      { left: 0, top: 0, right: 10, bottom: 10 },
      { left: 80, top: 60, right: 100, bottom: 100 },
    ]);
    const boxes = findElementBounds(buf, 100, 100, { factor: 1, minAreaPx: 1 });
    expect(boxes).toHaveLength(2);
    expect(boxes[0].top).toBe(0);                    // 左上小块排第一
    expect(boxes[1].top).toBeGreaterThan(0);
  });
});
