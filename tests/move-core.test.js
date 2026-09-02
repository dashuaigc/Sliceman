import { describe, it, expect } from 'vitest';
import {
  flipDir, parseDistance, applySign, toDelta, nudgeValue, formatDist, describeDelta,
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

describe('applySign 负数归一', () => {
  it('正数原样保留方向', () => {
    expect(applySign(20, 'right')).toEqual({ dist: 20, dir: 'right' });
    expect(applySign(0, 'up')).toEqual({ dist: 0, dir: 'up' });
  });

  it('负数取绝对值并翻转方向：→ 输入 -20 变成 ← 20', () => {
    expect(applySign(-20, 'right')).toEqual({ dist: 20, dir: 'left' });
    expect(applySign(-20, 'left')).toEqual({ dist: 20, dir: 'right' });
    expect(applySign(-30, 'down')).toEqual({ dist: 30, dir: 'up' });
    expect(applySign(-30, 'up')).toEqual({ dist: 30, dir: 'down' });
  });

  it('flipDir 四个方向互为反向', () => {
    expect(flipDir('left')).toBe('right');
    expect(flipDir('right')).toBe('left');
    expect(flipDir('up')).toBe('down');
    expect(flipDir('down')).toBe('up');
  });
});

describe('toDelta 方向换算', () => {
  const cfg = { xDir: 'right', xDist: 50, yDir: 'up', yDist: 20 };

  it('右/下为正，左/上为负', () => {
    expect(toDelta(cfg)).toEqual({ dx: 50, dy: -20 });
    expect(toDelta({ xDir: 'left', xDist: 50, yDir: 'down', yDist: 20 })).toEqual({ dx: -50, dy: 20 });
  });

  it('某轴为 0 时该轴不动', () => {
    expect(toDelta({ xDir: 'right', xDist: 30, yDir: 'down', yDist: 0 })).toEqual({ dx: 30, dy: 0 });
    expect(toDelta({ xDir: 'left', xDist: 0, yDir: 'up', yDist: 50 })).toEqual({ dx: 0, dy: -50 });
  });

  it('小数位移原样保留', () => {
    expect(toDelta({ xDir: 'right', xDist: 10.5, yDir: 'down', yDist: 0.25 })).toEqual({ dx: 10.5, dy: 0.25 });
  });

  it('缺字段按 0 处理，不产生 NaN', () => {
    expect(toDelta({ xDir: 'right', yDir: 'down' })).toEqual({ dx: 0, dy: 0 });
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

  it('减到负数由 applySign 接手翻方向：5 按 Shift+↓ → 反方向 5', () => {
    const next = nudgeValue(5, false, true);
    expect(next).toBe(-5);
    expect(applySign(next, 'right')).toEqual({ dist: 5, dir: 'left' });
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
