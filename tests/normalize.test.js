import { describe, it, expect } from 'vitest';
import { normalize } from '../src/lib/normalize.js';

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
