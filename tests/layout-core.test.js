import { describe, it, expect } from 'vitest';
import { groupIntoBands, orderItems, planLayout, planCanvas, defaultAlign } from '../src/lib/layout-core.js';

// 简写：造一个带 id 的矩形
const R = (id, left, top, w, h) => ({ id, left, top, right: left + w, bottom: top + h });
const ids = (arr) => arr.map((x) => x.id);

describe('groupIntoBands 行/列识别', () => {
  it('顶边不齐、高度不同，仍按 Y 重叠归为同一行', () => {
    const items = [R('A', 0, 0, 100, 100), R('B', 200, 20, 200, 50), R('C', 500, -10, 80, 200)];
    const bands = groupIntoBands(items, 'y');
    expect(bands).toHaveLength(1);
    expect(ids(bands[0].members.map((m) => m.it))).toEqual(['A', 'B', 'C']);
  });

  it('Y 完全不重叠的两组分成两行，上面的行在前', () => {
    const items = [R('D', 0, 300, 50, 50), R('A', 0, 0, 50, 50), R('B', 100, 0, 50, 50), R('E', 100, 300, 50, 50)];
    const bands = groupIntoBands(items, 'y');
    expect(bands).toHaveLength(2);
    expect(bands[0].start).toBe(0);
    expect(ids(bands[0].members.map((m) => m.it))).toEqual(['A', 'B']);
    expect(ids(bands[1].members.map((m) => m.it))).toEqual(['D', 'E']);
  });

  it('重叠不足一半（错开 80%）判为不同行', () => {
    const items = [R('A', 0, 0, 50, 100), R('B', 100, 80, 50, 100)];
    expect(groupIntoBands(items, 'y')).toHaveLength(2);
  });

  it('分列时用 X 重叠，左边的列在前', () => {
    const items = [R('D', 300, 0, 50, 50), R('A', 0, 0, 50, 50), R('B', 0, 100, 50, 50), R('E', 300, 100, 50, 50)];
    const bands = groupIntoBands(items, 'x');
    expect(bands).toHaveLength(2);
    expect(ids(bands[0].members.map((m) => m.it))).toEqual(['A', 'B']);
    expect(ids(bands[1].members.map((m) => m.it))).toEqual(['D', 'E']);
  });
});

describe('orderItems 智能空间排序', () => {
  it('横排：2x3 网格 → 从上到下、行内从左到右', () => {
    const items = [
      R('E', 100, 200, 50, 50), R('C', 200, 0, 50, 50), R('A', 0, 0, 50, 50),
      R('F', 200, 200, 50, 50), R('B', 100, 0, 50, 50), R('D', 0, 200, 50, 50),
    ];
    expect(ids(orderItems(items, 'h'))).toEqual(['A', 'B', 'C', 'D', 'E', 'F']);
  });

  it('竖排：同样的网格 → 从左到右、列内从上到下', () => {
    const items = [
      R('B', 0, 100, 50, 50), R('E', 200, 100, 50, 50), R('A', 0, 0, 50, 50),
      R('D', 200, 0, 50, 50), R('C', 0, 200, 50, 50), R('F', 200, 200, 50, 50),
    ];
    expect(ids(orderItems(items, 'v'))).toEqual(['A', 'B', 'C', 'D', 'E', 'F']);
  });

  it('横排两行数量不一致：上面的行整行优先', () => {
    const items = [
      R('A', 0, 0, 50, 50), R('B', 100, 0, 50, 50), R('C', 200, 0, 50, 50), R('D', 300, 0, 50, 50),
      R('E', 0, 200, 50, 50), R('F', 100, 200, 50, 50),
    ];
    expect(ids(orderItems(items, 'h'))).toEqual(['A', 'B', 'C', 'D', 'E', 'F']);
  });

  it('竖排三列数量不一致：左侧的列整列优先', () => {
    const items = [
      R('A', 0, 0, 50, 50), R('B', 0, 100, 50, 50), R('C', 0, 200, 50, 50),
      R('D', 200, 0, 50, 50), R('E', 200, 100, 50, 50), R('F', 400, 0, 50, 50),
    ];
    expect(ids(orderItems(items, 'v'))).toEqual(['A', 'B', 'C', 'D', 'E', 'F']);
  });

  it('散乱对象也给出稳定顺序：换输入次序结果不变', () => {
    const items = [R('B', 300, 0, 50, 50), R('A', 0, 120, 50, 50), R('D', 600, 260, 50, 50), R('C', 200, 400, 50, 50)];
    const once = ids(orderItems(items, 'h'));
    const twice = ids(orderItems(items.slice().reverse(), 'h'));
    expect(once).toEqual(twice);
    expect(once).toHaveLength(4);
  });
});

describe('planLayout 位移计算', () => {
  it('横排底部对齐：锚点不动，相邻边缘间距严格等于设定值', () => {
    const items = [R('A', 10, 10, 50, 100), R('B', 500, 400, 500, 40), R('C', 900, 380, 80, 200)];
    const { moves, ordered } = planLayout(items, { direction: 'h', align: 'bottom', gap: 10 });
    expect(ids(ordered)).toEqual(['A', 'B', 'C']);
    // 锚点 A 保持原位
    expect(moves[0]).toEqual({ id: 'A', dx: 0, dy: 0 });
    // 落位：A 右边缘 60 → B 左边缘 70；B 右边缘 570 → C 左边缘 580
    const at = (id) => {
      const m = moves.find((x) => x.id === id);
      const it = items.find((x) => x.id === id);
      return { left: it.left + m.dx, top: it.top + m.dy, right: it.right + m.dx, bottom: it.bottom + m.dy };
    };
    expect(at('B').left - at('A').right).toBe(10);
    expect(at('C').left - at('B').right).toBe(10);
    // 底部对齐：三者底边同一水平线
    expect(at('B').bottom).toBe(at('A').bottom);
    expect(at('C').bottom).toBe(at('A').bottom);
  });

  it('横排顶部对齐 / 垂直居中', () => {
    const items = [R('A', 0, 0, 100, 100), R('B', 300, 300, 100, 40)];
    const top = planLayout(items, { direction: 'h', align: 'top', gap: 20 });
    expect(top.moves[1].dy).toBe(-300);                       // B.top 对到 A.top=0
    const mid = planLayout(items, { direction: 'h', align: 'middle', gap: 20 });
    expect(300 + mid.moves[1].dy).toBe(30);                   // A 中心 50，B 高 40 → top=30
  });

  it('竖排左对齐：底边到顶边的间距等于设定值，左边缘对齐', () => {
    const items = [R('A', 40, 40, 60, 60), R('B', 500, 500, 200, 30), R('C', 800, 900, 30, 90)];
    const { moves } = planLayout(items, { direction: 'v', align: 'left', gap: 25 });
    const at = (id) => {
      const m = moves.find((x) => x.id === id);
      const it = items.find((x) => x.id === id);
      return { left: it.left + m.dx, top: it.top + m.dy, right: it.right + m.dx, bottom: it.bottom + m.dy };
    };
    expect(at('B').top - at('A').bottom).toBe(25);
    expect(at('C').top - at('B').bottom).toBe(25);
    expect(at('B').left).toBe(40);
    expect(at('C').left).toBe(40);
  });

  it('竖排右对齐 / 水平居中', () => {
    const items = [R('A', 0, 0, 100, 50), R('B', 0, 300, 40, 50)];
    expect(planLayout(items, { direction: 'v', align: 'right', gap: 0 }).moves[1].dx).toBe(60);
    expect(planLayout(items, { direction: 'v', align: 'center', gap: 0 }).moves[1].dx).toBe(30);
  });

  it('间距 0：两个对象边缘严格相接', () => {
    const items = [R('A', 0, 0, 50, 50), R('B', 900, 0, 50, 50)];
    const { moves } = planLayout(items, { direction: 'h', align: 'top', gap: 0 });
    expect(900 + moves[1].dx).toBe(50);
  });

  it('小数 bounds 下取整不累积：每段间距误差不超过 1px', () => {
    const items = Array.from({ length: 8 }, (_, i) => R(i, i * 137 + 0.3, 0.7, 33.4, 20.6));
    const { moves, ordered } = planLayout(items, { direction: 'h', align: 'top', gap: 10 });
    const pos = new Map(moves.map((m) => [m.id, m]));
    for (let i = 1; i < ordered.length; i++) {
      const prev = ordered[i - 1], cur = ordered[i];
      const gapReal = (cur.left + pos.get(cur.id).dx) - (prev.right + pos.get(prev.id).dx);
      expect(Math.abs(gapReal - 10)).toBeLessThanOrEqual(1);
    }
  });

  it('返回排版后的整体外接框', () => {
    const items = [R('A', 100, 100, 50, 50), R('B', 0, 0, 50, 80)];
    const { bounds } = planLayout(items, { direction: 'h', align: 'top', gap: 10 });
    // 锚点是位置靠上的 B（0,0,50,80），A 排到它右边 top=0
    expect(bounds).toEqual({ left: 0, top: 0, right: 110, bottom: 80 });
  });

  it('空输入与单对象不报错', () => {
    expect(planLayout([], {}).moves).toEqual([]);
    expect(planLayout([R('A', 5, 5, 10, 10)], {}).moves).toEqual([{ id: 'A', dx: 0, dy: 0 }]);
  });

  it('默认方向横排、默认对齐底部/左侧', () => {
    expect(defaultAlign('h')).toBe('bottom');
    expect(defaultAlign('v')).toBe('left');
    const items = [R('A', 0, 0, 50, 100), R('B', 300, 0, 50, 40)];
    expect(planLayout(items, { gap: 10 }).moves[1].dy).toBe(60);   // 未传方向/对齐 → 横排底对齐
  });
});

describe('planCanvas 画布扩展量', () => {
  const canvas = { width: 1920, height: 1080 };

  it('右侧超出：只向右扩，扩到留出边距', () => {
    const e = planCanvas({ left: 10, top: 10, right: 2200, bottom: 500 }, canvas, 10);
    expect(e).toEqual({ left: 0, top: 0, right: 290, bottom: 0 });   // 2200-1920+10
  });

  it('底部超出：只向下扩', () => {
    const e = planCanvas({ left: 10, top: 10, right: 500, bottom: 1200 }, canvas, 50);
    expect(e).toEqual({ left: 0, top: 0, right: 0, bottom: 170 });
  });

  it('顶部/左侧为负坐标时向上、向左扩', () => {
    const e = planCanvas({ left: -30, top: -5, right: 500, bottom: 500 }, canvas, 10);
    expect(e).toEqual({ left: 40, top: 15, right: 0, bottom: 0 });
  });

  it('完全在画布内：不扩也不缩', () => {
    expect(planCanvas({ left: 0, top: 0, right: 1920, bottom: 1080 }, canvas, 10))
      .toEqual({ left: 0, top: 0, right: 0, bottom: 0 });
  });

  it('边距与间距互相独立：边距 50 时按 50 算', () => {
    expect(planCanvas({ left: 10, top: 10, right: 2000, bottom: 100 }, canvas, 50).right).toBe(130);
  });
});
