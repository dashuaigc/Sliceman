// 按名称查找图层的纯逻辑：把「扁平图层清单 + 一组查找条件」变成结果行。
// PS 侧的枚举与选中在 src/ps/layer-finder.js（依赖 Photoshop 运行时，另行真机验证）。
//
// 四种匹配方式（包含 / 完全匹配 / 前缀 / 后缀）都只做字面比较，不收通配符也不收正则：
// 图层命名场景够用，而且不必把用户输入丢给 UXP 的正则引擎——旧引擎对 lookbehind 之类
// 的支持不可靠（同类规避见 rename-core.js）。真要加，扩 MODES 与 matchName 即可。
//
// 输入节点（layer-finder 产出，面板顺序：首个=最上）：
//   { id, name, kind:'layer'|'group', visible, isBackground, parents:number[], path:string[] }
//   visible 是「面板上真的看得见」：祖先组隐藏时子层也算隐藏（在 layer-finder 里算好）
//   parents 自外向内的祖先 id；path 对应的祖先名称

const MODES = new Set(['contains', 'exact', 'prefix', 'suffix']);

/**
 * 单个名称与关键词的匹配。
 * @returns {{start:number,end:number}|null} 命中返回原名称里的命中区间（用于高亮），未命中 null
 */
export function matchName(name, text, mode = 'contains', caseSensitive = false) {
  const s = typeof name === 'string' ? name : '';
  const t = typeof text === 'string' ? text : '';
  if (!t) return null;
  const a = caseSensitive ? s : s.toLowerCase();
  const b = caseSensitive ? t : t.toLowerCase();
  // 区间一律按原名称长度夹紧：个别字符大小写转换后长度会变（如 'İ'），夹一下避免越界
  const clamp = (start, end) => ({
    start: Math.max(0, Math.min(s.length, start)),
    end: Math.max(0, Math.min(s.length, end)),
  });
  if (mode === 'exact') return a === b ? clamp(0, s.length) : null;
  if (mode === 'prefix') return a.startsWith(b) ? clamp(0, b.length) : null;
  if (mode === 'suffix') return a.endsWith(b) ? clamp(s.length - b.length, s.length) : null;
  const i = a.indexOf(b);
  return i < 0 ? null : clamp(i, i + b.length);
}

/**
 * 范围限定：
 *   祖先落在 scope 里 → 在「选中的组内」，命中；
 *   自身落在 scope 里且不是组 → 用户直接选中了这一层，命中。
 * 被选中的组自身不算命中——选组是为了圈范围，不是为了改组名。
 */
function inScope(node, scope) {
  for (const p of node.parents || []) if (scope.has(p)) return true;
  return node.kind !== 'group' && scope.has(node.id);
}

/**
 * 按条件筛出匹配的图层（保持输入顺序 = 面板从上到下）。
 * @param {Array<object>} nodes readAllLayers() 的产出
 * @param {{text:string, mode?:'contains'|'exact'|'prefix'|'suffix', caseSensitive?:boolean,
 *          kind?:'all'|'layer'|'group', includeHidden?:boolean, includeBackground?:boolean,
 *          scopeIds?:Iterable<number>|null}} q
 * @returns {Array<{id:number,name:string,kind:string,visible:boolean,path:string[],hit:{start:number,end:number}}>}
 *   关键词为空时返回空数组（界面据此提示「输入查找内容」，不当成「匹配全部」）
 */
export function matchLayers(nodes, q) {
  const cfg = q || {};
  const text = typeof cfg.text === 'string' ? cfg.text : '';
  if (!text) return [];
  const mode = MODES.has(cfg.mode) ? cfg.mode : 'contains';
  const kind = cfg.kind === 'layer' || cfg.kind === 'group' ? cfg.kind : 'all';
  const includeHidden = cfg.includeHidden !== false;          // 默认连隐藏层一起找
  const includeBackground = !!cfg.includeBackground;          // 背景层默认不碰（改名会被 PS 转成普通图层）
  const scope = cfg.scopeIds
    ? (cfg.scopeIds instanceof Set ? cfg.scopeIds : new Set(cfg.scopeIds))
    : null;
  const out = [];
  for (const n of nodes || []) {
    if (!n || typeof n.name !== 'string') continue;
    if (kind !== 'all' && n.kind !== kind) continue;
    if (!includeHidden && !n.visible) continue;
    if (!includeBackground && n.isBackground) continue;
    if (scope && !inScope(n, scope)) continue;
    const hit = matchName(n.name, text, mode, !!cfg.caseSensitive);
    if (!hit) continue;
    out.push({
      id: n.id,
      name: n.name,
      kind: n.kind,
      visible: !!n.visible,
      locked: !!n.locked,          // 只用于在列表里标注：锁定层改名可能失败
      isBackground: !!n.isBackground,   // 同上：给背景层改名会被 PS 转成普通图层
      path: n.path || [],
      hit,
    });
  }
  return out;
}

/** 祖先名称链 → 展示用字符串（顶层为空串） */
export function describePath(path) {
  return Array.isArray(path) ? path.join(' / ') : '';
}
