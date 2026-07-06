// PS API 封装：读当前活动文档的图层树 → 纯数据结构（供 traversal 消费）。
// 需在 UXP Developer Tool 里对着真实 PSD 手动验证（本环境无 Photoshop）。
const { app, action } = require('photoshop');

/**
 * 读取图层的颜色标记（label color）并归一化为 'red' | 'blue' | null。
 *
 * 说明：UXP DOM 的 layer.color 在部分版本返回颜色串，但不保证；这里统一走
 * batchPlay 读 'color' 属性，返回形如 { color: { _enum:'color', _value:'red' } }。
 * 若你的 PS 版本返回字段不同，用 UDT 控制台打印 res 后调整取值路径。
 * @param {number} layerId
 * @returns {Promise<'red'|'blue'|null>}
 */
async function readLabelColor(layerId) {
  const [res] = await action.batchPlay([{
    _obj: 'get',
    _target: [
      { _property: 'color' },
      { _ref: 'layer', _id: layerId },
    ],
  }], {});
  const v = res?.color?._value;   // 例如 'red' / 'blue' / 'none'
  if (v === 'red' || v === 'blue') return v;
  return null;
}

/**
 * 把单个 PS 图层/组转成纯数据节点（递归）。
 * @param {object} layer UXP Layer
 * @returns {Promise<{name,kind,label,visible,children}>}
 */
async function nodeFromLayer(layer) {
  const isGroup = layer.kind === 'group';
  const label = await readLabelColor(layer.id);
  const node = {
    id: layer.id,                 // 保留活动图层 id，供 exporter 在临时文档中定位
    name: layer.name,
    kind: isGroup ? 'group' : 'layer',
    label,
    visible: layer.visible,
    children: [],
  };
  if (isGroup && layer.layers) {
    for (const child of layer.layers) {
      node.children.push(await nodeFromLayer(child));
    }
  }
  return node;
}

/**
 * 读当前活动文档 → 纯数据伪根节点。伪根 name 为文档名，其自身不进 pathSegments。
 * @returns {Promise<{name,kind,label,visible,children}>}
 */
export async function readDocumentTree() {
  const doc = app.activeDocument;
  if (!doc) throw new Error('没有打开的文档');
  const root = { name: doc.name, kind: 'group', label: null, visible: true, children: [] };
  for (const layer of doc.layers) {
    root.children.push(await nodeFromLayer(layer));
  }
  return root;
}
