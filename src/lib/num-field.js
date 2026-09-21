// 数值输入框的两件小事：把算式算出结果，以及 ↑/↓ 加减一格。
// 纯函数，可在 Node 下单测（tests/num-field.test.js）。
//
// 为什么自己写解析器，不用 eval / new Function：
//   一是 UXP 插件沙箱里的动态求值不可靠（各宿主策略不一，随版本变）；
//   二是把用户输入直接丢进求值器本来就不该做。这里只认「数字 + - * / ( )」，
//   凡是解析不了的一律返回 null —— 调用方据此【原样保留用户输入】，
//   交给各功能页自己的校验去报错，而不是擅自改成 0 或 NaN。
//
// 中文输入法是这里的头号麻烦：全角数字「１０００」、全角括号「（）」、
// 顿号式的「。」当小数点、以及 × ÷ 这两个真乘除号，用户都会打出来。
// 一律先归一成半角再解析 —— 报「请输入数字」远不如直接算对。

/** 全角 / 相似字符 → 半角。值为空串表示直接丢掉（空格、千分位逗号） */
const CHAR_MAP = {
  '＋': '+', '－': '-', '−': '-', '–': '-', '—': '-',
  '＊': '*', '×': '*',
  '／': '/', '÷': '/',
  '（': '(', '）': ')',
  '．': '.', '。': '.',
  '，': '', ',': '', ' ': '', '\t': '', '　': '',
  '０': '0', '１': '1', '２': '2', '３': '3', '４': '4',
  '５': '5', '６': '6', '７': '7', '８': '8', '９': '9',
};

/** 归一：全角转半角、乘除号转 * /、空格与千分位逗号去掉 */
export function normalizeNumText(raw) {
  const s = String(raw ?? '').trim();
  let out = '';
  for (const ch of s) out += (Object.prototype.hasOwnProperty.call(CHAR_MAP, ch) ? CHAR_MAP[ch] : ch);
  return out;
}

/** 词法：数字 | + - * / ( )。出现别的字符整串作废（返回 null） */
function tokenize(s) {
  const out = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '+' || c === '-' || c === '*' || c === '/' || c === '(' || c === ')') {
      out.push(c);
      i += 1;
      continue;
    }
    const m = /^(?:\d+(?:\.\d*)?|\.\d+)/.exec(s.slice(i));
    if (!m) return null;
    out.push(parseFloat(m[0]));
    i += m[0].length;
  }
  return out.length ? out : null;
}

// 递归下降：expr := term (('+'|'-') term)*
//            term := unary (('*'|'/') unary)*
//            unary := ('+'|'-') unary | atom
//            atom := number | '(' expr ')'
// 任何一步对不上就返回 null，一路冒到 evalExpr。

function parseExpr(p) {
  let v = parseTerm(p);
  if (v === null) return null;
  for (;;) {
    const op = p.t[p.i];
    if (op !== '+' && op !== '-') return v;
    p.i += 1;
    const r = parseTerm(p);
    if (r === null) return null;
    v = op === '+' ? v + r : v - r;
  }
}

function parseTerm(p) {
  let v = parseUnary(p);
  if (v === null) return null;
  for (;;) {
    const op = p.t[p.i];
    if (op !== '*' && op !== '/') return v;
    p.i += 1;
    const r = parseUnary(p);
    if (r === null) return null;
    // 除以 0 不产出 Infinity：那会被格式化成一串没意义的东西写回输入框
    if (op === '/' && r === 0) return null;
    v = op === '*' ? v * r : v / r;
  }
}

function parseUnary(p) {
  const tk = p.t[p.i];
  if (tk === '+' || tk === '-') {
    p.i += 1;
    const v = parseUnary(p);
    if (v === null) return null;
    return tk === '-' ? -v : v;
  }
  return parseAtom(p);
}

function parseAtom(p) {
  const tk = p.t[p.i];
  if (typeof tk === 'number') { p.i += 1; return tk; }
  if (tk === '(') {
    p.i += 1;
    const v = parseExpr(p);
    if (v === null || p.t[p.i] !== ')') return null;
    p.i += 1;
    return v;
  }
  return null;
}

/**
 * 算一段输入。纯数字也走这里（返回它自己），所以调用方不用先判断「是不是算式」。
 * @param {*} raw 用户在输入框里敲的东西
 * @returns {number|null} 解析不了 / 结果不是有限数 → null（调用方应原样保留输入）
 */
export function evalExpr(raw) {
  const s = normalizeNumText(raw);
  if (s === '') return null;
  const t = tokenize(s);
  if (!t) return null;
  const p = { t, i: 0 };
  const v = parseExpr(p);
  if (v === null || p.i !== t.length) return null;   // 有没吃完的 token = 写法不合法
  return Number.isFinite(v) ? v : null;
}

/**
 * 按小数位格式化，并去掉末尾多余的 0（100.0 → 100、10.50 → 10.5）。
 * @param {number} n
 * @param {number} [decimals] 保留几位小数，0 = 取整
 */
export function formatNum(n, decimals = 0) {
  if (!Number.isFinite(n)) return '';
  const d = Math.max(0, Math.min(6, Math.round(Number(decimals) || 0)));
  let s = n.toFixed(d);
  // 只在确实有小数点时裁剪 —— 整数上跑这条正则会把 "100" 削成 "1"
  if (d > 0 && s.indexOf('.') >= 0) s = s.replace(/\.?0+$/, '');
  return s === '-0' ? '0' : s;
}

/**
 * ↑/↓ 加减一格。按住 Shift 走大步（与快速平移页原有的手感一致）。
 * @param {number} cur 当前值
 * @param {boolean} up true=↑
 * @param {boolean} shift 是否按住 Shift
 * @param {number} [step] 小步长
 * @param {number} [bigStep] Shift 时的大步长
 */
export function stepValue(cur, up, shift, step = 1, bigStep = 10) {
  const base = Number(cur) || 0;
  return base + (up ? 1 : -1) * (shift ? bigStep : step);
}
