import { describe, it, expect } from 'vitest';
import {
  gapOf, gridOf, blockWidth, blockHeight, cellName, planCanvas, originOf,
  guidesOf, validateGridCfg, previewRows, buildGrid, MAX_COUNT,
} from '../src/lib/gridcell-core.js';

describe('间距（§5 §6）', () => {
  it('= (宽 + 高) ÷ 16', () => {
    expect(gapOf(1000, 600)).toBe(100);
    expect(gapOf(1200, 800)).toBe(125);
    expect(gapOf(1000, 1000)).toBe(125);
  });

  it('一律四舍五入到整数，.5 进位', () => {
    expect(gapOf(1000, 336)).toBe(84);            // 83.5 → 84
    expect(gapOf(1000, 335)).toBe(83);            // 83.4375 → 83
    expect(Number.isInteger(gapOf(777, 333))).toBe(true);
  });

  it('再小也不给 0：格子会粘死、画布也不留边距', () => {
    expect(gapOf(1, 1)).toBe(1);
    expect(gapOf(4, 4)).toBe(1);
  });
});

describe('行列布局（§7 §11）', () => {
  const g = (n) => gridOf(n, 1000, 1000, 125);

  it('1～9 个走固定表', () => {
    expect(g(1)).toEqual({ cols: 1, rows: 1 });
    expect(g(2)).toEqual({ cols: 2, rows: 1 });
    expect(g(3)).toEqual({ cols: 3, rows: 1 });
    expect(g(4)).toEqual({ cols: 2, rows: 2 });
    expect(g(5)).toEqual({ cols: 3, rows: 2 });   // 3 + 2，不是 2+2+1
    expect(g(6)).toEqual({ cols: 3, rows: 2 });
    expect(g(7)).toEqual({ cols: 4, rows: 2 });   // 4 + 3
    expect(g(8)).toEqual({ cols: 4, rows: 2 });
    expect(g(9)).toEqual({ cols: 3, rows: 3 });
  });

  it('固定表跟格子形状无关：扁格子 4 个照样 2×2', () => {
    expect(gridOf(4, 2000, 300, 144)).toEqual({ cols: 2, rows: 2 });
  });

  it('10 个以上挑「整体外框最方正」的行列', () => {
    expect(gridOf(10, 1000, 1000, 125)).toEqual({ cols: 4, rows: 3 });
    expect(gridOf(16, 1000, 1000, 125)).toEqual({ cols: 4, rows: 4 });
    expect(gridOf(100, 1000, 1000, 125)).toEqual({ cols: 10, rows: 10 });
  });

  it('方正度按【像素】算，不是按行列数：扁格子要多排几行', () => {
    // 1000×200 的扁格子，12 个排成 2 列 6 行，外框 2075×1575 最接近正方形；
    // 若只看行列数会给出 4×3，外框会宽到 4300×675
    expect(gridOf(12, 1000, 200, 75)).toEqual({ cols: 2, rows: 6 });
  });

  it('高格子反过来：多排几列', () => {
    // 200×1000 的高格子，12 个排成 8 列 2 行 → 2125×2075，几乎正方
    expect(gridOf(12, 200, 1000, 75)).toEqual({ cols: 8, rows: 2 });
  });

  it('选出来的确实是所有可行行列里最方正的那一组', () => {
    const ratio = (cols, rows, w, h, s) => {
      const bw = blockWidth(cols, w, s);
      const bh = blockHeight(rows, h, s);
      return Math.max(bw, bh) / Math.min(bw, bh);
    };
    for (const [n, w, h, s] of [[12, 1000, 200, 75], [23, 300, 700, 63], [40, 512, 512, 64]]) {
      const got = gridOf(n, w, h, s);
      const best = ratio(got.cols, got.rows, w, h, s);
      for (let cols = 1; cols <= n; cols++) {
        expect(best).toBeLessThanOrEqual(ratio(cols, Math.ceil(n / cols), w, h, s) + 1e-9);
      }
    }
  });

  it('行列乘积一定装得下，且不会白多一整行', () => {
    for (let n = 1; n <= 200; n++) {
      const { cols, rows } = gridOf(n, 800, 600, 88);
      expect(cols * rows).toBeGreaterThanOrEqual(n);
      expect(rows).toBe(Math.ceil(n / cols));      // 末行空位 < 一行
    }
  });
});

describe('整体外框（§12）', () => {
  it('C×W + (C-1)×S / R×H + (R-1)×S', () => {
    expect(blockWidth(3, 1000, 100)).toBe(3200);
    expect(blockHeight(2, 600, 100)).toBe(1300);
    expect(blockWidth(1, 1000, 100)).toBe(1000);   // 单列没有间距
  });
});

describe('图层命名（§4 §24）', () => {
  it('统一两位编号，超过 99 自然进位', () => {
    expect(cellName(1)).toBe('定位格 01');
    expect(cellName(9)).toBe('定位格 09');
    expect(cellName(10)).toBe('定位格 10');
    expect(cellName(100)).toBe('定位格 100');
  });

  it('名称里含「定位格」——Symbols 切图正是按这个关键字认基准框', () => {
    expect(cellName(7)).toContain('定位格');
  });
});

describe('画布（§13～§15）', () => {
  it('装得下就一点不改', () => {
    const r = planCanvas({ w: 1000, h: 800 }, { width: 3000, height: 2000 }, 100);
    expect(r).toEqual({ width: 3000, height: 2000, expanded: false });
  });

  it('装不下才扩，目标 = 外框 + 两个间距', () => {
    const r = planCanvas({ w: 3200, h: 1300 }, { width: 1000, height: 1000 }, 100);
    expect(r).toEqual({ width: 3400, height: 1500, expanded: true });
  });

  it('只扩不够的那一边，够的那一边原样保留', () => {
    const r = planCanvas({ w: 3200, h: 300 }, { width: 1000, height: 5000 }, 100);
    expect(r.width).toBe(3400);
    expect(r.height).toBe(5000);
  });

  it('刚好等于需要的尺寸不算扩', () => {
    const r = planCanvas({ w: 800, h: 600 }, { width: 1000, height: 800 }, 100);
    expect(r.expanded).toBe(false);
  });
});

describe('居中与整数坐标（§17）', () => {
  it('居中且坐标恒为整数', () => {
    const o = originOf({ w: 1001, h: 801 }, { width: 2000, height: 1600 });
    expect(o).toEqual({ left: 500, top: 400 });    // 499.5 / 399.5 → 取整
    expect(Number.isInteger(o.left) && Number.isInteger(o.top)).toBe(true);
  });
});

describe('参考线（§18～§22）', () => {
  const cell = { left: 100, top: 200, right: 1100, bottom: 800 };

  it('每格四边 + 中心十字，共 6 条', () => {
    const g = guidesOf([cell]);
    expect(g.vertical).toEqual([100, 600, 1100]);
    expect(g.horizontal).toEqual([200, 500, 800]);
  });

  it('中心线四舍五入到整数，不出半像素', () => {
    const g = guidesOf([{ left: 0, top: 0, right: 1001, bottom: 1001 }]);
    expect(g.vertical).toContain(501);            // 500.5 → 501
    expect(g.vertical.every(Number.isInteger)) .toBe(true);
    expect(g.horizontal.every(Number.isInteger)).toBe(true);
  });

  it('坐标完全相同的只留一条（相邻格共边、跨格重合）', () => {
    const a = { left: 0, top: 0, right: 100, bottom: 100 };
    const b = { left: 100, top: 0, right: 200, bottom: 100 };   // 与 a 共用 x=100
    const g = guidesOf([a, b]);
    expect(g.vertical).toEqual([0, 50, 100, 150, 200]);
    expect(g.horizontal).toEqual([0, 50, 100]);   // 两格同高，横线完全重合
  });

  it('与文档里已有的参考线也去重', () => {
    const g = guidesOf([cell], { vertical: [600], horizontal: [200, 800] });
    expect(g.vertical).toEqual([100, 1100]);
    expect(g.horizontal).toEqual([500]);
  });
});

describe('参数校验（§28）', () => {
  const ok = { width: '1000', height: '800', count: '6', color: '#999999' };

  it('合法参数通过', () => {
    expect(validateGridCfg(ok)).toBeNull();
    expect(validateGridCfg({ ...ok, color: '999999' })).toBeNull();   // 不带 # 也认
  });

  it('没打开文档先拦下', () => {
    expect(validateGridCfg(ok, { hasDoc: false }).field).toBe('doc');
  });

  it('宽高数量必须是大于 0 的整数', () => {
    for (const bad of ['0', '-5', '12.5', '', 'abc', ' ']) {
      expect(validateGridCfg({ ...ok, width: bad }).field).toBe('width');
      expect(validateGridCfg({ ...ok, height: bad }).field).toBe('height');
      expect(validateGridCfg({ ...ok, count: bad }).field).toBe('count');
    }
  });

  it('数量有上限，超了明确报出来', () => {
    expect(validateGridCfg({ ...ok, count: String(MAX_COUNT) })).toBeNull();
    expect(validateGridCfg({ ...ok, count: String(MAX_COUNT + 1) }).field).toBe('count');
  });

  it('颜色必须是 6 位 hex', () => {
    for (const bad of ['#fff', 'red', '#12345g', '']) {
      expect(validateGridCfg({ ...ok, color: bad }).field).toBe('color');
    }
  });

  it('报错信息给的是「请输入大于 0 的整数」这类可照做的话', () => {
    expect(validateGridCfg({ ...ok, width: '0' }).message).toContain('大于 0 的整数');
  });
});

describe('排列示意（§27）', () => {
  it('末行短一截 —— 靠左起排、不居中', () => {
    expect(previewRows(5, 3)).toEqual(['■ ■ ■', '■ ■']);
    expect(previewRows(7, 4)).toEqual(['■ ■ ■ ■', '■ ■ ■']);
    expect(previewRows(6, 3)).toEqual(['■ ■ ■', '■ ■ ■']);
  });

  it('数量太多就不画了，交给文字描述', () => {
    expect(previewRows(200, 14)).toEqual([]);
    expect(previewRows(0, 3)).toEqual([]);
  });
});

describe('完整方案 buildGrid', () => {
  const p = { width: 1000, height: 600, count: 5 };

  it('串起间距 / 行列 / 画布 / 坐标', () => {
    const r = buildGrid(p, { width: 800, height: 800 });
    expect(r.gap).toBe(100);                      // (1000+600)/16
    expect({ cols: r.cols, rows: r.rows }).toEqual({ cols: 3, rows: 2 });
    expect(r.block).toEqual({ w: 3200, h: 1300 });
    expect(r.canvas).toEqual({ width: 3400, height: 1500, expanded: true });
    expect(r.origin).toEqual({ left: 100, top: 100 });   // 安全边距 = 间距（§14）
    expect(r.cells).toHaveLength(5);
  });

  it('同行 Y 一致、同列 X 一致（§9 §10）', () => {
    const r = buildGrid({ width: 1000, height: 600, count: 5 }, { width: 8000, height: 8000 });
    const [c1, c2, c3, c4, c5] = r.cells;
    expect([c1.top, c2.top, c3.top]).toEqual([c1.top, c1.top, c1.top]);
    expect([c4.top, c5.top]).toEqual([c4.top, c4.top]);
    expect(c4.left).toBe(c1.left);                // 第二行第 1 个 = 第一行第 1 个正下方
    expect(c5.left).toBe(c2.left);
    expect(c4.top).toBe(c1.top + 600 + r.gap);
  });

  it('末行不足时从最左一列起排，绝不整体居中（§8 §11）', () => {
    const r = buildGrid({ width: 500, height: 500, count: 10 }, { width: 6000, height: 6000 });
    const last = r.cells.slice(r.cols * (r.rows - 1));
    expect(last[0].left).toBe(r.cells[0].left);
    expect(r.origin.left).toBe(r.cells[0].left);
  });

  it('编号从左到右、从上到下（§24）', () => {
    const r = buildGrid({ width: 100, height: 100, count: 6 }, { width: 4000, height: 4000 });
    expect(r.cells.map((c) => c.name)).toEqual([
      '定位格 01', '定位格 02', '定位格 03', '定位格 04', '定位格 05', '定位格 06',
    ]);
    expect(r.cells[1].left).toBeGreaterThan(r.cells[0].left);   // 02 在 01 右边
    expect(r.cells[3].top).toBeGreaterThan(r.cells[0].top);     // 04 在 01 下面
  });

  it('每个格子的尺寸都等于用户填的宽高', () => {
    const r = buildGrid({ width: 321, height: 177, count: 13 }, { width: 500, height: 500 });
    for (const c of r.cells) {
      expect(c.right - c.left).toBe(321);
      expect(c.bottom - c.top).toBe(177);
    }
  });

  it('所有坐标都是整数', () => {
    const r = buildGrid({ width: 1001, height: 777, count: 7 }, { width: 1234, height: 987 });
    for (const c of r.cells) {
      for (const k of ['left', 'top', 'right', 'bottom']) expect(Number.isInteger(c[k])).toBe(true);
    }
    expect(Number.isInteger(r.canvas.width)).toBe(true);
    expect(Number.isInteger(r.canvas.height)).toBe(true);
  });

  it('画布够大就不改，整套摆在中央', () => {
    const r = buildGrid({ width: 100, height: 100, count: 1 }, { width: 1000, height: 800 });
    expect(r.canvas.expanded).toBe(false);
    expect(r.cells[0]).toMatchObject({ left: 450, top: 350, right: 550, bottom: 450 });
    expect(r.fits).toBe(true);
  });

  it('扩画布后一定装得下，四周恰好留一个间距', () => {
    const r = buildGrid({ width: 900, height: 900, count: 9 }, { width: 100, height: 100 });
    expect(r.fits).toBe(true);
    expect(r.origin.left).toBe(r.gap);
    expect(r.origin.top).toBe(r.gap);
    expect(r.canvas.width - (r.origin.left + r.block.w)).toBe(r.gap);
    expect(r.canvas.height - (r.origin.top + r.block.h)).toBe(r.gap);
  });

  it('关掉自动扩画布：画布原样不动，并如实报出装不下', () => {
    const r = buildGrid({ width: 900, height: 900, count: 9 }, { width: 500, height: 500 }, { expandCanvas: false });
    expect(r.canvas).toEqual({ width: 500, height: 500, expanded: false });
    expect(r.fits).toBe(false);
  });
});
