import { describe, it, expect } from 'vitest';
import { buildBaseName, makeUniqueName } from '../src/lib/naming.js';

describe('buildBaseName', () => {
  it('各段 normalize 后用下划线拼接', () => {
    expect(buildBaseName(['首页', '导航', '图标'])).toBe('sy_dh_tb');
  });
  it('空段用占位名 + 序号', () => {
    expect(buildBaseName(['home', '！@#', 'icon'])).toBe('home_seg2_icon');
  });
  it('过滤掉整体为空的输入返回占位', () => {
    expect(buildBaseName(['！'])).toBe('seg1');
  });
});

describe('makeUniqueName', () => {
  it('未冲突时原样返回并登记', () => {
    const used = new Set();
    expect(makeUniqueName('tb', used)).toBe('tb');
    expect(used.has('tb')).toBe(true);
  });
  it('冲突时追加 _2 _3', () => {
    const used = new Set(['tb']);
    expect(makeUniqueName('tb', used)).toBe('tb_2');
    expect(makeUniqueName('tb', used)).toBe('tb_3');
  });
});
