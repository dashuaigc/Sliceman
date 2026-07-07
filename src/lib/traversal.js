/**
 * 遍历图层树产出导出任务。
 * @param {object} root 根节点（文档伪根，kind:'group'）
 * @param {{includeHidden:boolean}} opts
 * @returns {Array<{type:'layer'|'merged', node:object, pathSegments:string[]}>}
 */
export function walk(root, opts) {
  const tasks = [];
  const visit = (node, prefix) => {
    if (node.label === 'red') return;
    if (!node.visible && !opts.includeHidden) return;

    if (node.kind === 'group') {
      if (node.label === 'blue') {
        tasks.push({ type: 'merged', node, pathSegments: [...prefix, node.name] });
        return;
      }
      for (const child of node.children) {
        visit(child, [...prefix, node.name]);
      }
      return;
    }
    tasks.push({ type: 'layer', node, pathSegments: [...prefix, node.name] });
  };
  for (const child of root.children) visit(child, []);
  return tasks;
}

/**
 * 从 walk 产出的完整任务里，过滤出"落在选中子树内"的任务，用于「导出选中」。
 * 选中项自身或其任一祖先被选中的节点都算命中；这样：
 *   - 选中普通组 → 组内各叶子任务保留（颜色规则已由 walk 应用）；
 *   - 选中蓝色组 → 其单个 merged 任务保留（该任务 node 即该组）；
 *   - 选中单个图层 → 该图层任务保留；
 *   - 选中的红色组/图层 → walk 本就没产出任务，自然为空（静默跳过）。
 * @param {Array<{node:{id:*}}>} tasks walk() 的结果
 * @param {object} root 与 walk 同一棵树（含各节点 id）
 * @param {Iterable<*>} selectedIds 顶层选中项的 id 集合
 * @returns {Array} tasks 的子集（保持原顺序）
 */
export function filterTasksBySelection(tasks, root, selectedIds) {
  const sel = selectedIds instanceof Set ? selectedIds : new Set(selectedIds);
  const allowed = new Set();
  const dfs = (node, underSel) => {
    const here = underSel || sel.has(node.id);
    if (here) allowed.add(node.id);
    for (const c of node.children || []) dfs(c, here);
  };
  for (const c of root.children || []) dfs(c, false);
  return tasks.filter((t) => allowed.has(t.node.id));
}
