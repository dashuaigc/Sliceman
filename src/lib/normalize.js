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

/**
 * 前缀专用规范化：中文→拼音首字母、转小写，但**保留下划线等符号**，仅删除空格。
 * 用于批量重命名的前缀，允许用户用 _ - . 等符号拼接。
 * @param {string} input
 * @returns {string}
 */
export function normalizePrefix(input) {
  if (!input) return '';
  let out = '';
  for (const ch of input) {
    if (/[一-鿿]/.test(ch)) {
      out += pinyin(ch, { pattern: 'first', toneType: 'none' });
    } else {
      out += ch;
    }
  }
  return out.toLowerCase().replace(/\s+/g, '');   // 只去空格，保留符号
}
