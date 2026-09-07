// PS API 封装：把当前文档的图层树读成扁平清单（喂给 src/lib/search-core.js 做匹配），
// 以及「把查找到的图层选到图层面板里」。
//
// ⚠️ 依赖 Photoshop 运行时，无法在 Node 下单测；需在 UDT 里真机验证。
//
// 为什么读 DOM 而不是 batchPlay 扫 _index：
//   这里只要 id / 名称 / 是不是组 / 可见性 / 层级，全都是 UXP DOM 的同步属性，本项目
//   多处已在用（panel.js 的 collectDescendantIds、layer-tree.js 的递归）。走 batchPlay
//   按 _index 一趟拿完确实更快，但要额外处理 layerSection 分隔层、有无背景层导致的索引
//   偏移等版本相关的坑，而这里的读取又不像 layer-tree.js 那样每层都得再打一次
//   batchPlay（色标）——没有必须换路的理由，先要可靠。
//   真遇到超大文档慢，再在此文件内加一条 multiGet 快路并保留本实现兜底。

const { app, action, core } = require('photoshop');

const dontDisplay = { dialogOptions: 'dontDisplay' };

/**
 * 读当前文档的全部图层/组 → 扁平清单，顺序即图层面板从上到下（首个=最上）。
 *
 * visible 是「面板上真的看得见」：祖先组隐藏时，其子层一并按隐藏计——用户勾掉
 * 「包含隐藏图层」时期望排除的是看不见的层，而不只是自身被点掉眼睛的层。
 *
 * @returns {Array<{id:number,name:string,kind:'layer'|'group',visible:boolean,
 *                  isBackground:boolean,locked:boolean,parents:number[],path:string[]}>}
 */
export function readAllLayers() {
  const doc = app.activeDocument;
  if (!doc) return [];
  const out = [];
  const visit = (container, parents, path, parentVisible) => {
    for (const l of container.layers || []) {
      let node;
      try {
        const isGroup = l.kind === 'group';
        const visible = parentVisible && !!l.visible;
        node = {
          id: l.id,
          name: String(l.name ?? ''),
          kind: isGroup ? 'group' : 'layer',
          visible,
          isBackground: !!l.isBackgroundLayer,
          locked: !!l.locked,
          parents,
          path,
        };
        out.push(node);
        if (isGroup) visit(l, [...parents, l.id], [...path, node.name], visible);
      } catch {
        // 个别图层读属性失败（极少见）不影响其余：跳过它，也跳过它的子层
      }
    }
  };
  visit(doc, [], [], true);
  return out;
}

// 只选中这一层（select 不带修饰符 = 替换当前选区）/ 追加选中。
// makeVisible:false —— 命中的隐藏层被选中后仍保持隐藏，不擅自点亮
const selectOne = (id) => ({
  _obj: 'select', _target: [{ _ref: 'layer', _id: id }], makeVisible: false, _options: dontDisplay,
});
const addToSel = (id) => ({
  _obj: 'select', _target: [{ _ref: 'layer', _id: id }], makeVisible: false,
  selectionModifier: { _enum: 'selectionModifierType', _value: 'addToSelection' },
  _options: dontDisplay,
});

/**
 * 把给定 id 的图层设为图层面板的当前选中（第一个替换选区，其余追加）。
 * 只改选中状态，不改文档内容，因此不进历史记录。
 * @param {Iterable<number>} ids
 * @returns {Promise<number>} 实际下发的图层数
 */
export async function selectLayersById(ids) {
  if (!app.activeDocument) throw new Error('请先打开一个 PSD 文档');
  const list = Array.from(new Set(ids || []));
  if (!list.length) return 0;
  const descs = list.map((id, i) => (i === 0 ? selectOne(id) : addToSel(id)));
  await core.executeAsModal(async () => {
    // 一次塞几百条描述符在大文档上容易卡，分块播；块与块之间选区继续累加
    const CHUNK = 200;
    for (let i = 0; i < descs.length; i += CHUNK) {
      await action.batchPlay(descs.slice(i, i + CHUNK), {});
    }
  }, { commandName: '选中查找到的图层' });
  return list.length;
}
