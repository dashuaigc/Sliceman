import { pinyin } from 'pinyin-pro';

/**
 * 把单段名称规范化：中文→拼音首字母，英文/数字保留，
 * 全部小写，删除空格与所有非 [a-z0-9] 字符。
 * @param {string} input
 * @returns {string}
 */
export function normalize(input) {
  if (!input) return '';
  let out = '';
  for (const ch of input) {
    if (/[一-鿿]/.test(ch)) {
      const first = pinyin(ch, { pattern: 'first', toneType: 'none' });
      out += first;
    } else {
      out += ch;
    }
  }
  return out.toLowerCase().replace(/[^a-z0-9]/g, '');
}
