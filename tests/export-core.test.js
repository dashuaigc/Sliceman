import { describe, it, expect } from 'vitest';
import { computeBleedRect } from '../src/lib/export-core.js';

// 这个函数替掉了 Photoshop 的 Reveal All —— revealAll 连隐藏图层也算，而切图的工作文档
// 里整个 PSD 的图层都还在（只是被隐藏），每张都撑一次巨画布，切图因此奇慢。
describe('computeBleedRect：只按参与合并的层扩画布', () => {
  it('内容完全在画布内 → null（不用动画布）', () => {
    expect(computeBleedRect([{ left: 10, top: 10, right: 90, bottom: 90 }], 200, 200)).toBe(null);
  });

  it('内容正好铺满画布 → 也是 null', () => {
    expect(computeBleedRect([{ left: 0, top: 0, right: 200, bottom: 200 }], 200, 200)).toBe(null);
  });

  it('右下溢出 → 只往右下扩，左上保持 0', () => {
    expect(computeBleedRect([{ left: 50, top: 60, right: 260, bottom: 300 }], 200, 200))
      .toEqual({ left: 0, top: 0, right: 260, bottom: 300 });
  });

  it('左上溢出 → left/top 取负（crop 到画布外会补透明）', () => {
    expect(computeBleedRect([{ left: -40, top: -25, right: 100, bottom: 100 }], 200, 200))
      .toEqual({ left: -40, top: -25, right: 200, bottom: 200 });
  });

  it('多个层取并集，四边都溢出', () => {
    const rects = [
      { left: -30, top: 20, right: 50, bottom: 80 },
      { left: 100, top: -10, right: 240, bottom: 150 },
      { left: 20, top: 60, right: 120, bottom: 260 },
    ];
    expect(computeBleedRect(rects, 200, 200))
      .toEqual({ left: -30, top: -10, right: 240, bottom: 260 });
  });

  it('小数边界：left/top 向下取整、right/bottom 向上取整，一个像素都不切掉', () => {
    expect(computeBleedRect([{ left: -0.4, top: 10.2, right: 200.3, bottom: 199.6 }], 200, 200))
      .toEqual({ left: -1, top: 0, right: 201, bottom: 200 });
  });

  it('空层（宽或高为 0）不参与并集', () => {
    const rects = [
      { left: 0, top: 0, right: 0, bottom: 0 },          // 全透明层，PS 给的就是这种
      { left: 5, top: 5, right: 5, bottom: 300 },        // 宽为 0
      { left: 10, top: 10, right: 260, bottom: 100 },
    ];
    expect(computeBleedRect(rects, 200, 200))
      .toEqual({ left: 0, top: 0, right: 260, bottom: 200 });
  });

  it('没有可用的层 → null，调用方跳过 crop', () => {
    expect(computeBleedRect([], 200, 200)).toBe(null);
    expect(computeBleedRect([{ left: 0, top: 0, right: 0, bottom: 0 }], 200, 200)).toBe(null);
    expect(computeBleedRect(null, 200, 200)).toBe(null);
  });
});
