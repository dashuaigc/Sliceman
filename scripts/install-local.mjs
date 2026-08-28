// 把 dist/plugin 以「已安装插件」的身份装进 PS，而不是 UDT 侧载。
//
// 为什么必须真安装：manifest 里的 icons 是由 CC 安装流程注册、PS 从已装插件信息里读的；
// UDT 侧载不走这条路，面板标签只会拿到占位符 —— manifest 写得再对也不显示图标。
// （UDT 工作区配置 plugins_workspace.json 指向 dist/plugin/manifest.json 就是侧载状态）
//
// 这里做的事和 .ccx 双击安装落地结果一致，参照本机已装插件的结构照抄：
//   1) 插件目录  %APPDATA%\Adobe\UXP\Plugins\External\<id>_<version>\
//   2) 注册表项  %APPDATA%\Adobe\UXP\PluginsInfo\v1\PS.json 的 plugins 数组
//
// 用法：
//   node scripts/install-local.mjs            装 / 覆盖升级
//   node scripts/install-local.mjs --remove   卸载（目录 + 注册项都清掉）
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = 'dist/plugin';
const remove = process.argv.includes('--remove');

const appData = process.env.APPDATA;
if (!appData) { console.error('读不到 %APPDATA%，这个脚本只在 Windows 上用'); process.exit(1); }
const UXP = join(appData, 'Adobe', 'UXP');
const EXTERNAL = join(UXP, 'Plugins', 'External');
const INFO = join(UXP, 'PluginsInfo', 'v1', 'PS.json');

// PS 运行中改这两处：文件可能被占用，且 PS 退出时会重写 PS.json 把改动冲掉
// （SLICEMAN_SKIP_PS_CHECK 只给本脚本自测用——配合临时 APPDATA 跑通装/卸流程，别在真机上设）
const running = process.env.SLICEMAN_SKIP_PS_CHECK
  ? '' : execFileSync('tasklist', ['/FI', 'IMAGENAME eq Photoshop.exe', '/NH'], { encoding: 'latin1' });
if (/Photoshop\.exe/i.test(running)) {
  console.error('Photoshop 正在运行 —— 请先完全退出 PS 再跑本脚本');
  console.error('（PS 退出时会重写 PS.json，边跑边改会被冲掉）');
  process.exit(1);
}

if (!existsSync(`${SRC}/manifest.json`)) {
  console.error(`缺少 ${SRC}/manifest.json —— 先跑 npm run build`);
  process.exit(1);
}
const manifest = JSON.parse(readFileSync(`${SRC}/manifest.json`, 'utf8'));
const { id, version, name } = manifest;
const folder = `${id}_${version}`;
const target = join(EXTERNAL, folder);

// --- 注册表读写：只动自己那条，其它插件原样保留 ---
// 解析失败绝不能当空处理——那会把别人已装插件的注册项一起抹掉，宁可中止
function readInfo() {
  if (!existsSync(INFO)) return { plugins: [] };
  const text = readFileSync(INFO, 'utf8');
  let info;
  try { info = JSON.parse(text); } catch (e) {
    console.error(`${INFO} 解析失败，已中止（继续写会抹掉其它已装插件的注册项）：\n  ${e.message}`);
    process.exit(1);
  }
  if (!Array.isArray(info.plugins)) {
    console.error(`${INFO} 里没有 plugins 数组，格式不认识，已中止`);
    process.exit(1);
  }
  return info;
}
function writeInfo(info) {
  if (existsSync(INFO)) writeFileSync(`${INFO}.bak`, readFileSync(INFO));   // 先备份，出事能还原
  mkdirSync(join(UXP, 'PluginsInfo', 'v1'), { recursive: true });
  writeFileSync(INFO, JSON.stringify(info));
}

const info = readInfo();
const others = (info.plugins || []).filter((p) => p.pluginId !== id);

if (remove) {
  // 同 id 的旧版本目录可能有多个，一并清掉
  let n = 0;
  for (const f of existsSync(EXTERNAL) ? readdirSafe(EXTERNAL) : []) {
    if (f === folder || f.startsWith(`${id}_`)) { rmSync(join(EXTERNAL, f), { recursive: true, force: true }); n++; }
  }
  writeInfo({ ...info, plugins: others });
  console.log(`已卸载 ${id}：删除 ${n} 个插件目录，注册表剩 ${others.length} 条`);
  console.log('重启 PS 生效');
} else {
  // 覆盖安装：先清同 id 的所有旧版本目录，避免同 id 多份并存
  for (const f of existsSync(EXTERNAL) ? readdirSafe(EXTERNAL) : []) {
    if (f.startsWith(`${id}_`)) rmSync(join(EXTERNAL, f), { recursive: true, force: true });
  }
  mkdirSync(target, { recursive: true });
  cpSync(SRC, target, { recursive: true });

  writeInfo({
    ...info,
    plugins: [...others, {
      hostMinVersion: manifest.host?.minVersion || '23.3.0',
      name,
      path: `$localPlugins\\External\\${folder}`,     // $localPlugins = %APPDATA%\Adobe\UXP\Plugins
      pluginId: id,
      status: 'enabled',
      type: 'uxp',
      versionString: version,
    }],
  });

  console.log(`已安装 ${name} ${version} → ${target}`);
  console.log('接下来：');
  console.log('  1) UDT 里把 Sliceman 那条 Remove（同 id 侧载 + 已装两份会冲突）');
  console.log('  2) 启动 PS → 窗口 / 增效工具 里打开 Sliceman，面板标签图标即生效');
  console.log('卸载：node scripts/install-local.mjs --remove');
}

function readdirSafe(dir) {
  try { return readdirSync(dir); } catch { return []; }
}
