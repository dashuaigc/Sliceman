import { describe, it, expect } from 'vitest';
import {
  dnum, parseTransform, parseRect, screenToDoc, viewCenterFromDescriptors, originAtCenter,
  isPlausibleCenter,
} from '../src/lib/view-core.js';

describe('dnum', () => {
  it('认裸数字、{_value}、{value} 和数字字符串', () => {
    expect(dnum(12)).toBe(12);
    expect(dnum({ _value: 3.5, _unit: 'pixelsUnit' })).toBe(3.5);
    expect(dnum({ value: 7 })).toBe(7);
    expect(dnum('42')).toBe(42);
  });
  it('认不出来给 NaN', () => {
    expect(dnum(null)).toBeNaN();
    expect(dnum({})).toBeNaN();
    expect(dnum('')).toBeNaN();
    expect(dnum(undefined)).toBeNaN();
  });
});

describe('parseTransform', () => {
  it('六元素裸数字数组', () => {
    expect(parseTransform([2, 0, 0, 2, 10, 20])).toEqual([2, 0, 0, 2, 10, 20]);
  });
  it('元素是 {_value} 也认', () => {
    const raw = [2, 0, 0, 2, 10, 20].map((v) => ({ _value: v }));
    expect(parseTransform(raw)).toEqual([2, 0, 0, 2, 10, 20]);
  });
  it('外面包一层 viewTransform 会剥掉', () => {
    expect(parseTransform({ viewTransform: [1, 0, 0, 1, 0, 0] })).toEqual([1, 0, 0, 1, 0, 0]);
  });
  it('具名键 xx/xy/yx/yy/tx/ty', () => {
    expect(parseTransform({ xx: 3, xy: 0, yx: 0, yy: 3, tx: 5, ty: 6 }))
      .toEqual([3, 0, 0, 3, 5, 6]);
  });
  it('具名键 a/b/c/d/tx/ty', () => {
    expect(parseTransform({ a: 1, b: 2, c: 3, d: 4, tx: 5, ty: 6 })).toEqual([1, 2, 3, 4, 5, 6]);
  });
  it('长度不足或解析不出来给 null', () => {
    expect(parseTransform([1, 0, 0])).toBeNull();
    expect(parseTransform([1, 0, 0, 1, 0, 'x'])).toBeNull();
    expect(parseTransform({ foo: 1 })).toBeNull();
    expect(parseTransform(null)).toBeNull();
  });
});

describe('parseRect', () => {
  it('left/top/right/bottom', () => {
    expect(parseRect({ left: 0, top: 0, right: 100, bottom: 50 }))
      .toEqual({ left: 0, top: 0, right: 100, bottom: 50 });
  });
  it('带单位的 {_value} 也认', () => {
    const u = (v) => ({ _unit: 'pixelsUnit', _value: v });
    expect(parseRect({ left: u(10), top: u(20), right: u(110), bottom: u(70) }))
      .toEqual({ left: 10, top: 20, right: 110, bottom: 70 });
  });
  it('left/top + width/height 能补出右下', () => {
    expect(parseRect({ left: 5, top: 5, width: 20, height: 10 }))
      .toEqual({ left: 5, top: 5, right: 25, bottom: 15 });
  });
  it('外面包一层 documentArea 会剥掉', () => {
    expect(parseRect({ documentArea: { left: 0, top: 0, right: 4, bottom: 4 } }))
      .toEqual({ left: 0, top: 0, right: 4, bottom: 4 });
  });
  it('空矩形 / 反向矩形当作解析失败', () => {
    expect(parseRect({ left: 10, top: 10, right: 10, bottom: 20 })).toBeNull();
    expect(parseRect({ left: 10, top: 10, right: 5, bottom: 20 })).toBeNull();
  });
  it('缺字段给 null', () => {
    expect(parseRect({ left: 1, top: 2 })).toBeNull();
    expect(parseRect(null)).toBeNull();
    expect(parseRect(3)).toBeNull();
  });
});

describe('screenToDoc', () => {
  it('单位矩阵原样返回', () => {
    expect(screenToDoc({ x: 7, y: 9 }, [1, 0, 0, 1, 0, 0])).toEqual({ x: 7, y: 9 });
  });
  it('缩放 2 倍 + 平移能正确还原', () => {
    // 屏幕 = 文档*2 + (100, 50)；文档 (30,40) → 屏幕 (160,130)
    expect(screenToDoc({ x: 160, y: 130 }, [2, 0, 0, 2, 100, 50])).toEqual({ x: 30, y: 40 });
  });
  it('含旋转的矩阵也能求逆', () => {
    // 顺时针 90°：屏幕 = (−y, x)
    const m = [0, 1, -1, 0, 0, 0];
    const p = screenToDoc({ x: -40, y: 30 }, m);
    expect(p.x).toBeCloseTo(30);
    expect(p.y).toBeCloseTo(40);
  });
  it('退化矩阵给 null', () => {
    expect(screenToDoc({ x: 1, y: 1 }, [0, 0, 0, 0, 0, 0])).toBeNull();
    expect(screenToDoc({ x: 1, y: 1 }, [2, 4, 1, 2, 0, 0])).toBeNull();   // det = 0
  });
});

describe('viewCenterFromDescriptors', () => {
  it('缩放 200% 时，窗口中心映射回文档坐标', () => {
    // 文档放大 2 倍显示，文档原点画在屏幕 (100, 50)
    const m = [2, 0, 0, 2, 100, 50];
    // 窗口占屏幕 (100,50)-(500,450)，中心 (300,250) → 文档 (100,100)
    const area = { left: 100, top: 50, right: 500, bottom: 450 };
    expect(viewCenterFromDescriptors(m, area)).toEqual({ x: 100, y: 100 });
  });
  it('缩小时同样成立', () => {
    const m = [0.5, 0, 0, 0.5, 0, 0];
    const area = { left: 0, top: 0, right: 400, bottom: 200 };
    expect(viewCenterFromDescriptors(m, area)).toEqual({ x: 400, y: 200 });
  });
  it('任一边解析失败就 null', () => {
    expect(viewCenterFromDescriptors(null, { left: 0, top: 0, right: 1, bottom: 1 })).toBeNull();
    expect(viewCenterFromDescriptors([1, 0, 0, 1, 0, 0], null)).toBeNull();
    expect(viewCenterFromDescriptors([0, 0, 0, 0, 0, 0], { left: 0, top: 0, right: 1, bottom: 1 }))
      .toBeNull();
  });
});

describe('originAtCenter', () => {
  const size = { w: 300, h: 200 };
  const canvas = { width: 1000, height: 800 };

  it('按给定中心点摆放', () => {
    expect(originAtCenter(size, canvas, { x: 500, y: 400 })).toEqual({ left: 350, top: 300 });
  });
  it('中心点为 null 时退回画布中心', () => {
    expect(originAtCenter(size, canvas, null)).toEqual({ left: 350, top: 300 });
  });
  it('中心点在画布外也照摆，不夹回画布内', () => {
    expect(originAtCenter(size, canvas, { x: -100, y: -100 })).toEqual({ left: -250, top: -200 });
  });
  it('结果取整到像素', () => {
    expect(originAtCenter({ w: 101, h: 51 }, canvas, { x: 100.4, y: 200.6 }))
      .toEqual({ left: 50, top: 175 });
  });
  it('中心点字段非数字时也退回画布中心', () => {
    expect(originAtCenter(size, canvas, { x: NaN, y: NaN })).toEqual({ left: 350, top: 300 });
  });
});

describe('isPlausibleCenter', () => {
  const canvas = { width: 1000, height: 800 };
  it('画布内的点可信', () => {
    expect(isPlausibleCenter({ x: 500, y: 400 }, canvas)).toBe(true);
    expect(isPlausibleCenter({ x: 0, y: 0 }, canvas)).toBe(true);
    expect(isPlausibleCenter({ x: 1000, y: 800 }, canvas)).toBe(true);
  });
  it('画布外的点不可信——这正是「表格不见了」的成因', () => {
    expect(isPlausibleCenter({ x: -5000, y: 400 }, canvas)).toBe(false);
    expect(isPlausibleCenter({ x: 500, y: 9999 }, canvas)).toBe(false);
    expect(isPlausibleCenter({ x: 1200, y: 400 }, canvas)).toBe(false);
  });
  it('空值 / 非数字 / 无效画布一律不可信', () => {
    expect(isPlausibleCenter(null, canvas)).toBe(false);
    expect(isPlausibleCenter({ x: NaN, y: 0 }, canvas)).toBe(false);
    expect(isPlausibleCenter({ x: 1, y: 1 }, { width: 0, height: 0 })).toBe(false);
    expect(isPlausibleCenter({ x: 1, y: 1 }, null)).toBe(false);
  });
});
