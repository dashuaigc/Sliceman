import { describe, it, expect } from 'vitest';
import { buildPreview } from '../src/ps/renamer.js';

describe('buildPreview', () => {
  it('前缀原样保留（不做拼音/规范化），原名不变，直接拼接', () => {
    const rows = buildPreview(['home', '按钮', 'Group 1'], '图标');
    expect(rows).toEqual([
      { from: 'home', to: '图标home', dup: false },
      { from: '按钮', to: '图标按钮', dup: false },
      { from: 'Group 1', to: '图标Group 1', dup: false },
    ]);
  });
  it('前缀原样保留下划线、空格等所有符号', () => {
    expect(buildPreview(['home'], 'abc_00 211_')).toEqual([
      { from: 'home', to: 'abc_00 211_home', dup: false },
    ]);
  });
  it('新名相同的行标注 dup=true（spec §5 同名提示）', () => {
    const rows = buildPreview(['图', '图'], 'a');   // 两行都变 a图
    expect(rows.every(r => r.dup)).toBe(true);
  });
  it('前缀为空串 → 返回 null（调用方中止）', () => {
    expect(buildPreview(['a'], '')).toBeNull();
  });
});
