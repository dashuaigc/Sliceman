// 批量重命名纯逻辑：四种模式（替换 / 重新命名 / 加前缀 / 加后缀）+ 连续编号变量 n。
// 预览与写回共用同一份 buildRenameRows，保证「预览所见 = 实际所得」。
//
// 编号由显式开关 cfg.counter 控制（面板上的「启用编号 n」），不从模板猜测：
//   开关开  → 模板中所有"独立 n"展开为连续数字（起始 start、步长 step）
//   开关关  → n 是普通字母，原样保留
// "独立 n"指前后都不是英文字母/数字的小写 n：Button / Icon 里的 n 不算，
// icon_n / n_icon / UI_Button_n_Normal 里的 n 算（这些词里的字母 n 必须保持字面）。
// 顺带兼容中文输入法打出的全角 ｎ。
//
// 变量定位用手工扫描，不用 lookbehind 正则——UXP 旧引擎对 (?<!...) 支持不可靠。

const FULLWIDTH_N = 'ｎ';

function isWordChar(c) {
  return (c >= '0' && c <= '9') || (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c === FULLWIDTH_N;
}

/** 模板中所有"独立 n"的下标（前后都不是英文字母/数字；半角 n 与全角 ｎ 都认） */
function findNVars(t) {
  const at = [];
  for (let i = 0; i < t.length; i++) {
    if (t[i] !== 'n' && t[i] !== FULLWIDTH_N) continue;
    const prev = i > 0 ? t[i - 1] : '';
    const next = i < t.length - 1 ? t[i + 1] : '';
    if (!isWordChar(prev) && !isWordChar(next)) at.push(i);
  }
  return at;
}

/** 模板中是否含有编号变量 n（用于界面提示；编号是否生效由 cfg.counter 开关决定） */
export function hasCounter(template) {
  return typeof template === 'string' && findNVars(template).length > 0;
}

/** 把模板中的变量 n 替换为编号；digits>0 时补零到固定位数（超宽不截断，如 2 位下的 100） */
export function expandCounter(template, value, digits = 0) {
  const at = findNVars(template);
  if (!at.length) return template;
  const num = String(value);
  const padded = digits > 0 && num.length < digits ? '0'.repeat(digits - num.length) + num : num;
  let out = '', last = 0;
  for (const i of at) { out += template.slice(last, i) + padded; last = i + 1; }
  return out + template.slice(last);
}

/**
 * 生成批量重命名结果行（names 已按命名方向排序：names[0] 先编号）。
 * @param {string[]} names 原名称
 * @param {{mode:'replace'|'new'|'prefix'|'suffix', find?:string, template:string,
 *          counter?:boolean, start?:number, step?:number, digits?:number}} cfg
 * @returns {Array<{from:string,to:string,unmatched:boolean,dup:boolean}>}
 *   unmatched：替换模式下名称里没有查找内容（该层不改名、不占用编号）
 *   dup：      新名称在本批次内重复（仅提示，不阻止执行）
 */
export function buildRenameRows(names, cfg) {
  const start = Number.isFinite(cfg.start) ? cfg.start : 1;
  const step = Number.isFinite(cfg.step) && cfg.step !== 0 ? cfg.step : 1;
  const digits = Number.isFinite(cfg.digits) ? cfg.digits : 0;
  const useCounter = !!cfg.counter;               // 显式开关，不从模板猜
  let value = start;
  // 开关开才展开 n；开关关时 n 是普通字母，模板原样使用
  const expand = (tpl) => (useCounter ? expandCounter(tpl, value, digits) : tpl);
  const rows = names.map((name) => {
    let to = name;
    let unmatched = false;
    if (cfg.mode === 'replace') {
      const find = cfg.find ?? '';
      // 名称中所有出现处都替换（同名多处取同一编号）；没找到则保持原名
      if (!find || !name.includes(find)) unmatched = true;
      else to = name.split(find).join(expand(cfg.template));
    } else if (cfg.mode === 'new') {
      to = expand(cfg.template);
    } else if (cfg.mode === 'prefix') {
      to = expand(cfg.template) + name;
    } else if (cfg.mode === 'suffix') {
      to = name + expand(cfg.template);
    }
    if (useCounter && !unmatched) value += step;   // 未匹配的层不消耗编号，结果无跳号
    return { from: name, to, unmatched, dup: false };
  });
  const counts = {};
  for (const r of rows) counts[r.to] = (counts[r.to] || 0) + 1;
  for (const r of rows) r.dup = counts[r.to] > 1;
  return rows;
}
