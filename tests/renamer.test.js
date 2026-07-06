import { describe, it, expect } from 'vitest';
import { buildPreview } from '../src/ps/renamer.js';

describe('buildPreview', () => {
  it('只规范化前缀，原名保持不变，直接拼接', () => {
    const rows = buildPreview(['home', '按钮', 'Group 1'], '图标');
    expect(rows).toEqual([
      { from: 'home', to: 'tbhome', dup: false },
      { from: '按钮', to: 'tb按钮', dup: false },
      { from: 'Group 1', to: 'tbGroup 1', dup: false },
    ]);
  });
  it('前缀保留下划线等符号（不再被删除）', () => {
    expect(buildPreview(['home'], 'abc_00211_')).toEqual([
      { from: 'home', to: 'abc_00211_home', dup: false },
    ]);
  });
  it('新名相同的行标注 dup=true（spec §5 同名提示）', () => {
    const rows = buildPreview(['图', '图'], 'a');   // 两行都变 a图
    expect(rows.every(r => r.dup)).toBe(true);
  });
  it('前缀为空或纯空格 → 返回 null（调用方中止）', () => {
    expect(buildPreview(['a'], '')).toBeNull();
    expect(buildPreview(['a'], '   ')).toBeNull();
  });
});
