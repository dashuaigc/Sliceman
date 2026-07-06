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
 * @param {string} base
 * @param {Set<string>} usedSet
 * @returns {string}
 */
export function makeUniqueName(base, usedSet) {
  if (!usedSet.has(base)) {
    usedSet.add(base);
    return base;
  }
  let i = 2;
  while (usedSet.has(`${base}_${i}`)) i++;
  const unique = `${base}_${i}`;
  usedSet.add(unique);
  return unique;
}
