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
  it('英文/数字/下划线的图层名原样进文件名（真机 bug：曾被压成 wbt1_wgeffect8）', () => {
    // 文档 WBT_1.psb 里的图层 WG_effect_8 → 导出名必须还认得出是哪一层
    expect(buildBaseName(['WBT_1', 'WG_effect_8'])).toBe('WBT_1_WG_effect_8');
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
  it('比对不分大小写，但返回名保留原大小写（Windows 下同名会互相覆盖）', () => {
    const used = new Set();
    expect(makeUniqueName('WG_1', used)).toBe('WG_1');
    expect(makeUniqueName('wg_1', used)).toBe('wg_1_2');     // 大小写不同也算撞名
    expect(makeUniqueName('Wg_1', used)).toBe('Wg_1_3');
  });
});
