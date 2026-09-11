import { describe, it, expect } from 'vitest';
import {
  DIRS, dirVector, dirFromVector, dirAxes, flipDir, flipAxis,
  parseDistance, planMove, nudgeValue, formatDist, describeDelta,
} from '../src/lib/move-core.js';

describe('parseDistance 输入解析', () => {
  it('空值视为 0（该轴不移动）', () => {
    expect(parseDistance('')).toBe(0);
    expect(parseDistance('   ')).toBe(0);
    expect(parseDistance(null)).toBe(0);
    expect(parseDistance(undefined)).toBe(0);
  });

  it('整数、小数、负数都能解析', () => {
    expect(parseDistance('10')).toBe(10);
    expect(parseDistance('10.5')).toBe(10.5);
    expect(parseDistance('.5')).toBe(0.5);
    expect(parseDistance('-20')).toBe(-20);
    expect(parseDistance('+7')).toBe(7);
  });

  it('超大数值照样接受，不设上限', () => {
    expect(parseDistance('100000')).toBe(100000);
  });

  it('非数字返回 null（调用方据此置错误态、不执行）', () => {
    expect(parseDistance('abc')).toBeNull();
    expect(parseDistance('10px')).toBeNull();
    expect(parseDistance('1.2.3')).toBeNull();
    expect(parseDistance('--5')).toBeNull();
  });
});

describe('八个方向', () => {
  it('正好八个，四正向 + 四斜向', () => {
    expect(DIRS).toHaveLength(8);
    expect(new Set(DIRS).size).toBe(8);
  });

  it('方向 → 单位向量：右/下为正', () => {
    expect(dirVector('right')).toEqual({ sx: 1, sy: 0 });
    expect(dirVector('up')).toEqual({ sx: 0, sy: -1 });
    expect(dirVector('downLeft')).toEqual({ sx: -1, sy: 1 });
    expect(dirVector('upRight')).toEqual({ sx: 1, sy: -1 });
  });

  it('认不出的方向给零向量（调用方据此不下发）', () => {
    expect(dirVector('nope')).toEqual({ sx: 0, sy: 0 });
    expect(dirVector(undefined)).toEqual({ sx: 0, sy: 0 });
  });

  it('单位向量 → 方向名，八个方向来回换算都对得上', () => {
    for (const d of DIRS) {
      const { sx, sy } = dirVector(d);
      expect(dirFromVector(sx, sy)).toBe(d);
    }
  });

  it('(0,0) 不在八个方向里，返回 null', () => {
    expect(dirFromVector(0, 0)).toBeNull();
  });

  it('正向只要一个值，斜向两个都要', () => {
    expect(dirAxes('left')).toEqual({ x: true, y: false });
    expect(dirAxes('right')).toEqual({ x: true, y: false });
    expect(dirAxes('up')).toEqual({ x: false, y: true });
    expect(dirAxes('down')).toEqual({ x: false, y: true });
    for (const d of ['upLeft', 'upRight', 'downLeft', 'downRight']) {
      expect(dirAxes(d)).toEqual({ x: true, y: true });
    }
  });

  it('flipDir 是整个反向，八个方向两两成对', () => {
    expect(flipDir('left')).toBe('right');
    expect(flipDir('up')).toBe('down');
    expect(flipDir('upLeft')).toBe('downRight');
    expect(flipDir('downLeft')).toBe('upRight');
    for (const d of DIRS) expect(flipDir(flipDir(d))).toBe(d);
  });

  it('flipAxis 只翻一个轴；用不到那个轴的方向原样返回', () => {
    expect(flipAxis('upLeft', 'x')).toBe('upRight');
    expect(flipAxis('upLeft', 'y')).toBe('downLeft');
    expect(flipAxis('right', 'x')).toBe('left');
    expect(flipAxis('up', 'x')).toBe('up');        // ↑ 没有水平分量，翻不动
    expect(flipAxis('left', 'y')).toBe('left');
  });
});

describe('planMove 方向 + 距离 → 位移', () => {
  it('正向只走自己那个轴', () => {
    expect(planMove('right', 50, 0)).toMatchObject({ dx: 50, dy: 0, dir: 'right' });
    expect(planMove('up', 0, 20)).toMatchObject({ dx: 0, dy: -20, dir: 'up' });
    expect(planMove('left', 30, 0)).toMatchObject({ dx: -30, dy: 0 });
    expect(planMove('down', 0, 15)).toMatchObject({ dx: 0, dy: 15 });
  });

  it('正向方向下，另一个轴框里的残值一律不生效', () => {
    // 界面上那一行是收起来的，值却还留着——不置 0 的话对象会莫名其妙斜着跑
    expect(planMove('right', 50, 999)).toMatchObject({ dx: 50, dy: 0, yDist: 0 });
    expect(planMove('down', 999, 15)).toMatchObject({ dx: 0, dy: 15, xDist: 0 });
  });

  it('斜向两个轴各走各的', () => {
    expect(planMove('upRight', 40, 25)).toMatchObject({ dx: 40, dy: -25, dir: 'upRight' });
    expect(planMove('downLeft', 40, 25)).toMatchObject({ dx: -40, dy: 25, dir: 'downLeft' });
    expect(planMove('upLeft', 10, 10)).toMatchObject({ dx: -10, dy: -10 });
    expect(planMove('downRight', 10, 10)).toMatchObject({ dx: 10, dy: 10 });
  });

  it('负数翻转对应的那一个轴，并回报翻过之后的方向', () => {
    expect(planMove('right', -20, 0)).toMatchObject({ dx: -20, dir: 'left', xDist: 20 });
    expect(planMove('up', 0, -30)).toMatchObject({ dy: 30, dir: 'down', yDist: 30 });
    // 斜向只翻填了负数的那一个轴：↖ 的水平填 -20 → ↗，垂直分量不动
    expect(planMove('upLeft', -20, 10)).toMatchObject({ dx: 20, dy: -10, dir: 'upRight' });
    expect(planMove('upLeft', 20, -10)).toMatchObject({ dx: -20, dy: 10, dir: 'downLeft' });
    expect(planMove('upLeft', -20, -10)).toMatchObject({ dx: 20, dy: 10, dir: 'downRight' });
  });

  it('距离为 0 不翻方向，也不产生 -0', () => {
    const r = planMove('left', 0, 0);
    expect(r.dir).toBe('left');
    expect(Object.is(r.dx, -0)).toBe(false);
    expect(r.dx).toBe(0);
  });

  it('小数位移原样保留（PS 支持亚像素定位）', () => {
    expect(planMove('downRight', 10.5, 0.25)).toMatchObject({ dx: 10.5, dy: 0.25 });
  });

  it('缺参数、坏方向都按 0 处理，不产生 NaN', () => {
    expect(planMove('right')).toMatchObject({ dx: 0, dy: 0 });
    expect(planMove('nope', 50, 50)).toMatchObject({ dx: 0, dy: 0, dir: 'nope' });
  });
});

describe('nudgeValue 键盘微调', () => {
  it('↑/↓ 加减 1', () => {
    expect(nudgeValue(10, true, false)).toBe(11);
    expect(nudgeValue(10, false, false)).toBe(9);
  });

  it('Shift + ↑/↓ 加减 10', () => {
    expect(nudgeValue(10, true, true)).toBe(20);
    expect(nudgeValue(50, false, true)).toBe(40);
  });

  it('减到负数由 planMove 接手翻方向：5 按 Shift+↓ → 反方向 5', () => {
    const next = nudgeValue(5, false, true);
    expect(next).toBe(-5);
    expect(planMove('right', next, 0)).toMatchObject({ dx: -5, dir: 'left', xDist: 5 });
  });
});

describe('formatDist / describeDelta 显示', () => {
  it('去掉浮点尾巴与尾随 0', () => {
    expect(formatDist(10.000000000000002)).toBe('10');
    expect(formatDist(10.5)).toBe('10.5');
    expect(formatDist(10.567)).toBe('10.57');
    expect(formatDist('abc')).toBe('0');
  });

  it('位移描述按符号给出方向词', () => {
    expect(describeDelta(20, 10)).toBe('右 20px、下 10px');
    expect(describeDelta(-50, -20)).toBe('左 50px、上 20px');
    expect(describeDelta(30, 0)).toBe('右 30px');
    expect(describeDelta(0, -5)).toBe('上 5px');
    expect(describeDelta(0, 0)).toBe('');
  });
});
