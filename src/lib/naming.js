import { normalize } from './normalize.js';

/**
 * 把路径各段规范化后用 '_' 拼接；某段规范化为空时用 'seg{index}' 占位（index 从 1 起）。
 * @param {string[]} segments
 * @returns {string}
 */
export function buildBaseName(segments) {
  const parts = segments.map((seg, i) => {
    const n = normalize(seg);
    return n || `seg${i + 1}`;
  });
  return parts.join('_') || 'seg1';
}

/**
 * 在 usedSet 下生成唯一名：冲突则追加 _2、_3…，并把结果登记进 usedSet。
 *
 * 比对按【小写】进行，返回的名字保留原大小写 —— Windows 的文件名不分大小写，
 * `WG_1` 与 `wg_1` 落到磁盘上是同一个文件，只按原样比对会让后一张静默覆盖前一张。
 * @param {string} base
 * @param {Set<string>} usedSet 登记的是小写键
 * @returns {string}
 */
export function makeUniqueName(base, usedSet) {
  const key = String(base).toLowerCase();
  if (!usedSet.has(key)) {
    usedSet.add(key);
    return base;
  }
  let i = 2;
  while (usedSet.has(`${key}_${i}`)) i++;
  usedSet.add(`${key}_${i}`);
  return `${base}_${i}`;
}
