import { describe, it, expect } from 'vitest';
import { labelComponents, labelComponentsMerged, downsampleAlpha, findElementBounds, orderRowMajor } from '../src/lib/segment.js';

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

describe('labelComponentsMerged（近距合并：解决图标内细缝过分割）', () => {
  it('相距 6px 的两块，膨胀半径 3 → 合并为一，边界取并集不外扩', () => {
    // 两块 4x4，x 间隔 6：0-4 与 10-14
    const a = grid(20, 10, [{ left: 0, top: 0, right: 4, bottom: 4 }, { left: 10, top: 0, right: 14, bottom: 4 }]);
    const boxes = labelComponentsMerged(a, 20, 10, 1, 3);
    expect(boxes).toHaveLength(1);
    expect(boxes[0]).toMatchObject({ left: 0, top: 0, right: 14, bottom: 4 });   // 并集，未被膨胀撑大
  });

  it('相距 30px 的两块，膨胀半径 3 → 仍分开', () => {
    const a = grid(50, 10, [{ left: 0, top: 0, right: 4, bottom: 4 }, { left: 34, top: 0, right: 38, bottom: 4 }]);
    expect(labelComponentsMerged(a, 50, 10, 1, 3)).toHaveLength(2);
  });

  it('r=0 退化为普通 labelComponents', () => {
    const a = grid(20, 10, [{ left: 0, top: 0, right: 4, bottom: 4 }, { left: 10, top: 0, right: 14, bottom: 4 }]);
    expect(labelComponentsMerged(a, 20, 10, 1, 0)).toHaveLength(2);
    expect(labelComponentsMerged(a, 20, 10, 1, 0)).toEqual(labelComponents(a, 20, 10, 1));
  });

  it('三方链式合并：A-B 近、B-C 近、A-C 远 → 全并为一', () => {
    const a = grid(60, 10, [
      { left: 0, top: 0, right: 4, bottom: 4 },
      { left: 10, top: 0, right: 14, bottom: 4 },
      { left: 20, top: 0, right: 24, bottom: 4 },
    ]);
    const boxes = labelComponentsMerged(a, 60, 10, 1, 3);
    expect(boxes).toHaveLength(1);
    expect(boxes[0].right).toBe(24);
  });

  it('噪点过滤在合并后仍生效：孤立小块不因膨胀吸附远处元素', () => {
    // 大块 8x8 与 40px 外的 1x1 噪点：膨胀 r=3 不接触，噪点被 minArea 过滤
    const a = grid(60, 20, [{ left: 0, top: 0, right: 8, bottom: 8 }, { left: 48, top: 0, right: 49, bottom: 1 }]);
    const boxes = labelComponentsMerged(a, 60, 20, 20, 3);
    expect(boxes).toHaveLength(1);
    expect(boxes[0].right).toBe(8);
  });

  it('findElementBounds 集成：视觉一个图标（两笔细缝 6px）→ 一个边界框', () => {
    const buf = rgba(100, 40, [
      { left: 10, top: 10, right: 40, bottom: 14 },   // 横笔
      { left: 10, top: 20, right: 40, bottom: 24 },   // 横笔（与上一笔隔 6px）
      { left: 70, top: 10, right: 90, bottom: 24 },   // 远处的另一个元素
    ]);
    const boxes = findElementBounds(buf, 100, 40, { factor: 1, minAreaPx: 1, mergeGapPx: 10 });
    expect(boxes).toHaveLength(2);
    expect(boxes[0]).toMatchObject({ left: 10, top: 10, right: 40, bottom: 24 });  // 两笔合为一
  });

  it('mergeGapPx=0 关闭合并（旧行为）', () => {
    const buf = rgba(100, 40, [
      { left: 10, top: 10, right: 40, bottom: 14 },
      { left: 10, top: 20, right: 40, bottom: 24 },
    ]);
    expect(findElementBounds(buf, 100, 40, { factor: 1, minAreaPx: 1, mergeGapPx: 0 })).toHaveLength(2);
  });
});

describe('自适应合并（mergeGapPx:"auto"，按间隙分布定阈值）', () => {
  // 布局：一个"图标"由 3 块 10x10 组成（缝 6px），另一个独立块距它 40px
  const layout = [
    { left: 0, top: 0, right: 10, bottom: 10 },
    { left: 16, top: 0, right: 26, bottom: 10 },
    { left: 32, top: 0, right: 42, bottom: 10 },
    { left: 82, top: 0, right: 92, bottom: 10 },
  ];
  // 同布局整体放大 s 倍
  const scale = (rects, s) => rects.map((r) => ({
    left: r.left * s, top: r.top * s, right: r.right * s, bottom: r.bottom * s,
  }));

  it('小尺寸：内部细缝合并、独立元素分开', () => {
    const buf = rgba(100, 20, layout);
    const boxes = findElementBounds(buf, 100, 20, { factor: 1, minAreaPx: 1 });   // 默认 auto
    expect(boxes).toHaveLength(2);
  });

  it('尺度不变：同布局放大 10 倍，结果仍为 2 个元素', () => {
    const buf = rgba(1000, 200, scale(layout, 10));
    const boxes = findElementBounds(buf, 1000, 200, { factor: 1, minAreaPx: 1 });
    expect(boxes).toHaveLength(2);
  });

  it('无明显双峰（等距排布）→ 保守不误并', () => {
    // 四块等距 30px，彼此间距完全相同：无双峰，退化为保守相对值，保持 4 块
    const buf = rgba(160, 10, [
      { left: 0, top: 0, right: 10, bottom: 10 },
      { left: 40, top: 0, right: 50, bottom: 10 },
      { left: 80, top: 0, right: 90, bottom: 10 },
      { left: 120, top: 0, right: 130, bottom: 10 },
    ]);
    expect(findElementBounds(buf, 160, 10, { factor: 1, minAreaPx: 1 })).toHaveLength(4);
  });

  it('重度碎片化场景（NN 统计失效）：两个图标各由 3 片组成，片间距远小于图标间距', () => {
    // 图标1：x 0-20 / 40-60 / 80-100（缝 20px）；图标2：x 500-520 / 540-560 / 580-600
    // 每一片的最近邻都是自己图标的相邻片 → NN 统计里根本没有 380px 的图标间距（旧算法因此失效）
    const rects = [0, 40, 80, 500, 540, 580].map((x) => ({ left: x, top: 5, right: x + 20, bottom: 25 }));
    const buf = rgba(640, 30, rects);
    const boxes = findElementBounds(buf, 640, 30, { factor: 1, minAreaPx: 1 });
    expect(boxes).toHaveLength(2);
    expect(boxes[0]).toMatchObject({ left: 0, right: 100 });      // 图标1 三片合一
    expect(boxes[1]).toMatchObject({ left: 500, right: 600 });    // 图标2 三片合一
  });

  it('规则网格布局（3 行×4 列，行距小于列距）→ 按格分割不合并', () => {
    // 行间距 20、列间距 80：间隙分布双峰、切割点会按列粘连——但网格检测应阻止合并
    const rects = [];
    for (let r = 0; r < 3; r++)
      for (let c = 0; c < 4; c++)
        rects.push({ left: c * 130, top: r * 110, right: c * 130 + 110, bottom: r * 110 + 90 });
    const buf = rgba(530, 350, rects);
    const info = {};
    const boxes = findElementBounds(buf, 530, 350, { factor: 1, minAreaPx: 1, info });
    expect(boxes).toHaveLength(12);
    expect(info.grid).toBe(true);
  });

  it('碎片散布（非网格）不受网格检测影响，仍合并', () => {
    // 3 片同属一个"图标"（横向错落、纵向也不对齐），远处 1 片
    const buf = rgba(300, 200, [
      { left: 10, top: 10, right: 50, bottom: 50 },
      { left: 60, top: 30, right: 100, bottom: 70 },
      { left: 30, top: 90, right: 70, bottom: 130 },
      { left: 240, top: 10, right: 280, bottom: 50 },
    ]);
    const boxes = findElementBounds(buf, 300, 200, { factor: 1, minAreaPx: 1 });
    expect(boxes).toHaveLength(2);
  });

  it('gap=0 完全关闭合并（纯连通域）', () => {
    const buf = rgba(100, 20, layout);
    expect(findElementBounds(buf, 100, 20, { factor: 1, minAreaPx: 1, mergeGapPx: 0 })).toHaveLength(4);
  });

  it('合并后的边界为原始块并集（不外扩）', () => {
    const buf = rgba(100, 20, layout);
    const boxes = findElementBounds(buf, 100, 20, { factor: 1, minAreaPx: 1 });
    expect(boxes[0]).toMatchObject({ left: 0, top: 0, right: 42, bottom: 10 });
    expect(boxes[1]).toMatchObject({ left: 82, top: 0, right: 92, bottom: 10 });
  });
});

describe('不透明实底图（无 alpha，底色分离模式）', () => {
  /** 全不透明白底图，把矩形涂成指定颜色 */
  function opaque(w, h, rects, color = [200, 60, 60], bg = [255, 255, 255]) {
    const buf = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      buf[i * 4] = bg[0]; buf[i * 4 + 1] = bg[1]; buf[i * 4 + 2] = bg[2]; buf[i * 4 + 3] = 255;
    }
    for (const r of rects) {
      for (let y = r.top; y < r.bottom; y++)
        for (let x = r.left; x < r.right; x++) {
          const i = (y * w + x) * 4;
          buf[i] = color[0]; buf[i + 1] = color[1]; buf[i + 2] = color[2]; buf[i + 3] = 255;
        }
    }
    return buf;
  }

  it('白底不透明图上的两个色块 → 2 个元素（旧逻辑会并成 1 块）', () => {
    const buf = opaque(100, 50, [
      { left: 5, top: 5, right: 30, bottom: 30 },
      { left: 60, top: 10, right: 90, bottom: 40 },
    ]);
    const info = {};
    const boxes = findElementBounds(buf, 100, 50, { factor: 1, minAreaPx: 1, info });
    expect(boxes).toHaveLength(2);
    expect(info.mode).toBe('color');
  });

  it('整图与底色几乎同色 → 退回整层一个元素（而非 0 个）', () => {
    // 色块 (250,250,250) 与白底 (255,255,255) 差 5 < 容差 24 → 分离后无内容 → 整层 1 个
    const buf = opaque(100, 50, [{ left: 5, top: 5, right: 30, bottom: 30 }], [250, 250, 250]);
    expect(findElementBounds(buf, 100, 50, { factor: 1, minAreaPx: 1 })).toHaveLength(1);
  });

  it('底色分离后仍走自适应合并：碎片化的图标并回一个', () => {
    // 白底上一个"图标"由两片组成（缝 4px），远处另一个独立片
    const buf = opaque(100, 30, [
      { left: 5, top: 5, right: 25, bottom: 25 },
      { left: 29, top: 5, right: 49, bottom: 25 },
      { left: 80, top: 5, right: 95, bottom: 25 },
    ]);
    const boxes = findElementBounds(buf, 100, 30, { factor: 1, minAreaPx: 1 });
    expect(boxes).toHaveLength(2);
    expect(boxes[0]).toMatchObject({ left: 5, right: 49 });
  });

  it('有透明的图仍走 alpha 模式（回归）', () => {
    const buf = rgba(100, 50, [{ left: 5, top: 5, right: 30, bottom: 30 }]);   // 透明底
    const info = {};
    findElementBounds(buf, 100, 50, { factor: 1, minAreaPx: 1, info });
    expect(info.mode).toBe('alpha');
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
