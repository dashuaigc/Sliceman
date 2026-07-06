import { describe, it, expect } from 'vitest';
import { normalize, normalizePrefix } from '../src/lib/normalize.js';

describe('normalize', () => {
  it('英文原样转小写', () => {
    expect(normalize('Home')).toBe('home');
  });
  it('数字保留', () => {
    expect(normalize('icon2')).toBe('icon2');
  });
  it('中文取拼音首字母', () => {
    expect(normalize('图标')).toBe('tb');
  });
  it('中英数字混合', () => {
    expect(normalize('Icon图标 2')).toBe('icontb2');
  });
  it('删除空格与符号', () => {
    expect(normalize('a b-c_d.e')).toBe('abcde');
  });
  it('全部非法字符 → 空串', () => {
    expect(normalize('！@#')).toBe('');
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
