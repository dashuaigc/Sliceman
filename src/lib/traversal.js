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
