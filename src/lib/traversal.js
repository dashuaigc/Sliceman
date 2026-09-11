/**
 * 遍历图层树产出导出任务。
 *
 * 颜色规则：红 = 不切（组则整棵子树都不切）；蓝 = 合并成一张 ——
 *   - 蓝色【组】：整组合并，不再下探（组内红色后代由 exporter 排除）；
 *   - 蓝色【图层】：**同一层级下**（同一个父容器里）标蓝的图层全部合并成一张，
 *     不看它们在图层面板上挨没挨着，中间隔着别的层也照合。孤零零一个蓝色图层
 *     就是它自己一张。这一轮本来就不导出的（红色，或隐藏且没开「包含隐藏图层」）
 *     不进合并。
 *
 * @param {object} root 根节点（文档伪根，kind:'group'）
 * @param {{includeHidden:boolean}} opts
 * @returns {Array<{type:'layer'|'merged', node:object, members?:object[], pathSegments:string[]}>}
 *          members 只有「同层蓝色图层合并」才有，列出要一起合并的那几层；
 *          node 取这几层里**最下面**那一层 —— 文件名用它（PS 里副本都摞在原件上面，
 *          最下面那个通常就是没带「拷贝 2」的原名）。合并任务就排在这一层原来的位置上。
 */
export function walk(root, opts) {
  const tasks = [];

  // 这一轮压根不导出的节点：红色，或隐藏且没开「包含隐藏图层」
  const dropped = (node) => node.label === 'red' || (!node.visible && !opts.includeHidden);

  const visit = (node, prefix) => {
    if (dropped(node)) return;

    if (node.kind === 'group') {
      if (node.label === 'blue') {
        tasks.push({ type: 'merged', node, pathSegments: [...prefix, node.name] });
        return;
      }
      visitChildren(node.children, [...prefix, node.name]);
      return;
    }
    tasks.push({ type: 'layer', node, pathSegments: [...prefix, node.name] });
  };

  // 走一层容器里的子节点：这一层的蓝色图层先挑出来，合成一个任务
  const visitChildren = (children, prefix) => {
    const kids = (children || []).filter((c) => !dropped(c));
    const blues = kids.filter((c) => c.kind === 'layer' && c.label === 'blue');
    // 只有一层蓝的没什么可合的，当普通图层走（行为与不标蓝完全一致）
    const members = blues.length > 1 ? new Set(blues) : new Set();
    const naming = blues[blues.length - 1];             // 最下面那层出文件名
    for (const child of kids) {
      if (!members.has(child)) { visit(child, prefix); continue; }
      // 合并任务排在最下面那层原来的位置，其余成员只是被它带走
      if (child === naming) {
        tasks.push({ type: 'merged', node: naming, members: blues, pathSegments: [...prefix, naming.name] });
      }
    }
  };

  visitChildren(root.children, []);
  return tasks;
}

/**
 * 从 walk 产出的完整任务里，过滤出"落在选中子树内"的任务，用于「导出选中」。
 * 选中项自身或其任一祖先被选中的节点都算命中；这样：
 *   - 选中普通组 → 组内各叶子任务保留（颜色规则已由 walk 应用）；
 *   - 选中蓝色组 → 其单个 merged 任务保留（该任务 node 即该组）；
 *   - 选中单个图层 → 该图层任务保留；
 *   - 选中同层蓝色图层里的**任意一层** → 整个 merged 任务保留（合并是一张图，不拆开只导一半）；
 *   - 选中的红色组/图层 → walk 本就没产出任务，自然为空（静默跳过）。
 *
 * 命名路径同时被**裁到以选中项为起点**：walk 给的 pathSegments 是从文档根算起的，
 * 但「导出选中」时用户心里的起点就是他点的那一项 —— 只选组里的某一层、没选组，
 * 导出的名字就该只是这一层的名字，不该冒出各级组名（要项目名前缀由调用方另加）。
 * 选中的是组时，组名仍在路径里（它本来就被选中了）：选 nav 得到 nav_home，
 * 只选 nav 里的 home 得到 home。
 * @param {Array<{node:{id:*}, pathSegments:string[]}>} tasks walk() 的结果
 * @param {object} root 与 walk 同一棵树（含各节点 id）
 * @param {Iterable<*>} selectedIds 顶层选中项的 id 集合
 * @returns {Array} tasks 的子集（保持原顺序，pathSegments 已裁成相对选中项）
 */
export function filterTasksBySelection(tasks, root, selectedIds) {
  const sel = selectedIds instanceof Set ? selectedIds : new Set(selectedIds);
  // node.id → 它所属那个「选中项」的深度。深度与 pathSegments 的下标一一对应：
  // 根的直接子节点深度 0，其任务 pathSegments 长度为 1，所以 slice(深度) 正好裁掉
  // 选中项以上的各级组名。
  const rootDepth = new Map();
  const dfs = (node, depth, selDepth) => {
    // 已经在某个选中项的子树里就沿用它的深度，否则看自己是不是被选中的那一个
    const d = selDepth !== null ? selDepth : (sel.has(node.id) ? depth : null);
    if (d !== null) rootDepth.set(node.id, d);
    for (const c of node.children || []) dfs(c, depth + 1, d);
  };
  for (const c of root.children || []) dfs(c, 0, null);
  // 蓝色合并任务按它的**每一个**成员去命中：选中其中任意一层就保留整张合并图。
  // 成员都是同一个容器下的兄弟层，深度一致，取哪个算裁剪起点都一样。
  const idsOf = (t) => (t.members ? t.members.map((m) => m.id) : [t.node.id]);
  const out = [];
  for (const t of tasks) {
    let depth = null;
    for (const id of idsOf(t)) {
      if (!rootDepth.has(id)) continue;
      const d = rootDepth.get(id);
      depth = depth === null ? d : Math.min(depth, d);
    }
    if (depth === null) continue;
    out.push({ ...t, pathSegments: t.pathSegments.slice(depth) });
  }
  return out;
}
