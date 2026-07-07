// Symbols 切图的纯逻辑：从图层树找出各 symbol，以及按定位格基准计算导出框。
// 与 PS 无关，可在 Node 下单测。

const MARKER = '定位格';

/**
 * 从图层树找出所有 symbol。
 * 规则：名称包含「定位格」的**图层**即标记；它所在的**父容器**就是一个 symbol：
 *   - 在某个组内 → symbol 范围 = 该组；
 *   - 直接在画布根 → symbol 范围 = 整张画布（根伪节点），当作一个图标。
 * 同一容器内出现多个定位格 → 归为同一个 symbol（其 dinweigeIds 收集全部）。
 * @param {object} root 文档伪根节点（kind:'group'）
 * @returns {Array<{type:'symbol', node:object, dinweigeIds:Array, pathSegments:string[]}>}
 */
export function findSymbols(root) {
  const scopeMap = new Map();               // 范围节点 → {node, pathSegments, dinweigeIds}
  const visit = (node, path) => {           // path = 到 node 自身的组名路径
    for (const child of node.children || []) {
      if (child.kind === 'layer' && child.name.includes(MARKER)) {
        let entry = scopeMap.get(node);
        if (!entry) { entry = { node, pathSegments: path, dinweigeIds: [] }; scopeMap.set(node, entry); }
        entry.dinweigeIds.push(child.id);
      }
      if (child.kind === 'group') visit(child, [...path, child.name]);
    }
  };
  visit(root, []);
  return Array.from(scopeMap.values()).map((e) => ({
    type: 'symbol',
    node: e.node,
    dinweigeIds: e.dinweigeIds,
    pathSegments: e.pathSegments,
  }));
}

/**
 * 以定位格为基准算出导出矩形：四边各向外扩「最大超出量 E」。
 * E = 四个方向超出量（不足记 0）的最大值；对称外扩使定位格中心 = 输出中心。
 * @param {{left,top,right,bottom}} G 定位格边界
 * @param {{left,top,right,bottom}|null} C 图标内容边界（合并后、不含定位格）；无内容传 null
 * @returns {{left,top,right,bottom}} 导出矩形
 */
export function computeSymbolFrame(G, C) {
  if (!C) return { left: G.left, top: G.top, right: G.right, bottom: G.bottom };
  const overTop = Math.max(0, G.top - C.top);
  const overBottom = Math.max(0, C.bottom - G.bottom);
  const overLeft = Math.max(0, G.left - C.left);
  const overRight = Math.max(0, C.right - G.right);
  const E = Math.max(overTop, overBottom, overLeft, overRight);
  return {
    left: G.left - E,
    top: G.top - E,
    right: G.right + E,
    bottom: G.bottom + E,
  };
}
