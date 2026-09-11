import { describe, it, expect } from 'vitest';
import { normalize, normalizePrefix } from '../src/lib/normalize.js';

describe('normalize', () => {
  // 真机报的 bug：图层 WG_effect_8 导出成了 wgeffect8.png —— 下划线被删、大小写被压平。
  // 现在的规则：英文/数字/下划线原样保留，中文转拼音首字母，其余字符删除。
  it('英文与大小写原样保留（不再转小写）', () => {
    expect(normalize('Home')).toBe('Home');
    expect(normalize('WGEffect')).toBe('WGEffect');
  });
  it('下划线原样保留（图层名本来就是合法文件名）', () => {
    expect(normalize('WG_effect_8')).toBe('WG_effect_8');
    expect(normalize('_leading_and_trailing_')).toBe('_leading_and_trailing_');
  });
  it('数字保留', () => {
    expect(normalize('icon2')).toBe('icon2');
  });
  it('中文取拼音首字母（小写）', () => {
    expect(normalize('图标')).toBe('tb');
  });
  it('中英数字混合：英文保持原样，中文转拼音', () => {
    expect(normalize('Icon图标 2')).toBe('Icontb2');
    expect(normalize('图标_关闭')).toBe('tb_gb');          // 下划线不再被吃掉
  });
  it('删除空格与除下划线之外的符号', () => {
    expect(normalize('a b-c_d.e')).toBe('abc_de');
  });
  it('全部非法字符 → 空串', () => {
    expect(normalize('！@#')).toBe('');
  });
  it('不把汉字漏进文件名（生僻字拼音查不到时也一样）', () => {
    // 逐字检查结果里只可能出现 [A-Za-z0-9_]
    for (const s of ['图标', '𠮷野家', '漢字テスト', '首页导航']) {
      expect(normalize(s)).toMatch(/^[A-Za-z0-9_]*$/);
    }
  });
});

describe('normalizePrefix', () => {
  it('保留下划线等符号', () => {
    expect(normalizePrefix('abc_00211_')).toBe('abc_00211_');
  });
  it('中文转拼音首字母并保留符号', () => {
    expect(normalizePrefix('图标_')).toBe('tb_');
  });
  it('转小写、删除空格', () => {
    expect(normalizePrefix('Ab C')).toBe('abc');
  });
  it('纯空格 → 空串', () => {
    expect(normalizePrefix('   ')).toBe('');
  });
});
