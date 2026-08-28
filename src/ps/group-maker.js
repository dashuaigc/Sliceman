// PS API 封装：批量新建独立组 —— 给每个选中的图层/组各套一层新的父级组。
//
// ⚠️ 依赖 Photoshop 运行时，无法在 Node 下单测；需在 UDT 里真机验证。
// 纯逻辑（命名方式/编号）在 src/lib/group-core.js，有单测。
//
// 核心难点：PS 原生「图层编组」(Ctrl+G / make layerSection) 会把当前所有选中图层
//   塞进同一个组。解法与 smart-object.js 同款：模态内逐个「只选中这一层 → 编组」，
//   一个对象一个组，绝不合并。
//
// 为什么顺序/父级/组内结构天然不变：make layerSection 是原地操作，新组建在该对象
//   原来的父级、原来的槽位上，对象本身只是被移进新组，内容/名称/样式/蒙版/混合模式
//   /不透明度/智能对象属性都不动。选中的若是组，则整组被原样套进去，内部层级不变。
//
// 单步撤销：优先官方 doc.suspendHistory（与 renamer.js 同款，回调内全部改动合并为
//   一条历史，Ctrl+Z 一次全撤销）。旧版 PS 无此 API 时退回 executeAsModal，历史会有多条。
//   ⚠️ 不复用 smart-object.js 的快照折叠：那套手法只在转 SO 流程真机验证过，
//   用在别的流程上出现过历史倒回文档打开状态、改动全丢的情况。

const { app, action, core } = require('photoshop');

function findLayerById(container, id) {
  for (const l of container.layers ?? []) {
    if (l.id === id) return l;
    if (l.layers) { const f = findLayerById(l, id); if (f) return f; }
  }
  return null;
}

const dontDisplay = { dialogOptions: 'dontDisplay' };

// 只选中这一层（select 不带修饰符 = 替换当前选区；makeVisible 不强制点亮隐藏层）
const selectOne = (id) => ({
  _obj: 'select', _target: [{ _ref: 'layer', _id: id }], makeVisible: false, _options: dontDisplay,
});

// 把当前选中的（=这一个）对象原地套进新建的图层组，并直接命名
const makeGroup = (name) => ({
  _obj: 'make',
  _target: [{ _ref: 'layerSection' }],
  from: { _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' },
  using: { _obj: 'layerSection', name },
  _options: dontDisplay,
});

const setName = (id, name) => ({
  _obj: 'set', _target: [{ _ref: 'layer', _id: id }], to: { _obj: 'layer', name }, _options: dontDisplay,
});

/**
 * 逐个给对象套父级组。
 * @param {Array<{id:number,name:string}>} pairs 对象 id 与其新父级组名称，按图层面板从上到下
 * @param {{selectAfter?:boolean, onProgress?:(done:number,total:number)=>void}} opts
 *        selectAfter 执行后是否选中新建的所有组
 * @returns {Promise<{created:number, failed:number, groupIds:number[]}>}
 */
export async function createGroups(pairs, opts = {}) {
  const onProgress = opts.onProgress || (() => {});
  const doc = app.activeDocument;
  if (!doc) throw new Error('请先打开一个 PSD 文档');
  if (!pairs?.length) return { created: 0, failed: 0, groupIds: [] };

  const groupIds = [];
  let created = 0, failed = 0;

  const doGroups = async () => {
    created = 0; failed = 0; groupIds.length = 0;
    for (const p of pairs) {
      // 对象可能已不存在（中途被删）：算失败，不中断整批
      if (!findLayerById(doc, p.id)) { failed++; onProgress(created + failed, pairs.length); continue; }
      try {
        await action.batchPlay([selectOne(p.id), makeGroup(p.name)], {});
        // 编组后新组即为当前选中层，读回 id：既供「执行后选中」用，也用来校正名称
        const nowSel = Array.from(doc.activeLayers || []);
        const g = nowSel.find((l) => l.kind === 'group') || nowSel[0];
        if (g) {
          groupIds.push(g.id);
          // 兜底：某些 PS 版本忽略 make 描述符里的 using.name，这里补一次改名
          if (g.name !== p.name) {
            try { await action.batchPlay([setName(g.id, p.name)], {}); } catch { /* 名字不对不算失败 */ }
          }
        }
        created++;
      } catch {
        failed++;   // 单个失败（如背景图层不可编组）只计数，其余继续
      }
      onProgress(created + failed, pairs.length);
    }

    // 执行后选中新建的所有组：第一个替换选区，其余追加
    if (opts.selectAfter && groupIds.length) {
      try {
        await action.batchPlay(groupIds.map((id, i) => (i === 0 ? selectOne(id) : {
          _obj: 'select', _target: [{ _ref: 'layer', _id: id }], makeVisible: false,
          selectionModifier: { _enum: 'selectionModifierType', _value: 'addToSelection' },
          _options: dontDisplay,
        })), {});
      } catch { /* 选中失败不影响已建好的组 */ }
    }
  };

  // 优先官方 suspendHistory：回调内全部改动合并为一条「批量新建独立组」历史
  if (typeof doc.suspendHistory === 'function') {
    try {
      await doc.suspendHistory(doGroups, '批量新建独立组');
      return { created, failed, groupIds };
    } catch (e) {
      // suspendHistory 本身不可用（一个组都没建过）→ 换传统模态重试；
      // 已建过组却抛错则如实上抛，避免二次执行建出重复的组
      if (created > 0 || failed > 0) throw e;
    }
  }
  await core.executeAsModal(doGroups, { commandName: '批量新建独立组' });
  return { created, failed, groupIds };
}
