/**
 * 生成重命名预览。前缀原样保留（不做拼音/规范化，符号空格都保留），
 * 原名原样拼在其后。拼音/规范化转换只在切图导出时进行。
 * @param {string[]} names 选中图层/组的原始名
 * @param {string} rawPrefix 前缀输入
 * @returns {Array<{from:string,to:string,dup:boolean}> | null}  前缀为空串时返回 null
 */
export function buildPreview(names, rawPrefix) {
  if (!rawPrefix) return null;
  const rows = names.map(n => ({ from: n, to: rawPrefix + n, dup: false }));
  const counts = {};
  for (const r of rows) counts[r.to] = (counts[r.to] || 0) + 1;
  for (const r of rows) r.dup = counts[r.to] > 1;
  return rows;
}

// --- PS 封装（在 UXP Developer Tool 手动验证，无法在此单测） ---

/**
 * 返回当前文档中选中的图层/组。
 * @returns {Promise<Array>}
 */
export async function getSelectedLayers() {
  const { app } = require('photoshop');
  const doc = app.activeDocument;
  return doc ? doc.activeLayers : [];
}

/**
 * 给选中图层/组批量加前缀（原样保留输入，只改名字），一次可撤销历史步骤。
 * @param {Array} layers
 * @param {string} rawPrefix
 * @returns {Promise<number>} 实际修改数量
 */
export async function applyRename(layers, rawPrefix) {
  const { core } = require('photoshop');
  if (!rawPrefix) return 0;
  await core.executeAsModal(async () => {
    for (const layer of layers) layer.name = rawPrefix + layer.name;
  }, { commandName: '批量加前缀' });
  return layers.length;
}
