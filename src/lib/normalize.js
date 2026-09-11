import { pinyin } from 'pinyin-pro';

/**
 * 把单段名称规范化成文件名：
 *   · 英文字母 / 数字 / 下划线 —— **原样保留**（大小写不动、下划线不动）
 *   · 中文 —— 转成拼音首字母（小写）
 *   · 其它（空格、`-`、`（）`、假名…）—— 删除
 *
 * 也就是说 `WG_effect_8` 导出就叫 `WG_effect_8`，不会被压成 `wgeffect8`。
 * 用户按自己规范起的图层名本来就是合法文件名，插件没有理由改写它
 *（早期版本一律转小写并删掉下划线，真机上导出的名字与图层名对不上）。
 * @param {string} input
 * @returns {string}
 */
export function normalize(input) {
  if (!input) return '';
  let out = '';
  for (const ch of String(input)) {
    if (/[A-Za-z0-9_]/.test(ch)) out += ch;
    // 字典里没有的生僻字，pinyin-pro 会把原字返回 —— 再滤一遍，别让汉字漏进文件名
    else if (/[一-鿿]/.test(ch)) {
      out += pinyin(ch, { pattern: 'first', toneType: 'none' }).toLowerCase().replace(/[^a-z0-9]/g, '');
    }
  }
  return out;
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
