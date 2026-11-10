# 定位格对象间距实施计划

**目标：** 定位格增加可选的对象间距（px），填写时横纵使用同一值，留空保持旧版默认公式。

**设计：** 在数量/颜色下新增一行输入，允许 0 和正整数。新增 `grid.gap` 偏好；缺失或空白按 `(宽+高)/16` 四舍五入且至少 1px。新建文档四周各留一个间距，当前文档保持原有居中、只扩不缩和扩展开关。预览、实际坐标、参考线共用 `buildGrid`。输入框聚焦保留文本，允许用户直接清空并保存自动状态。

**技术：** 现有 UXP HTML/CSS/JS、纯几何模块、Vitest、esbuild。

1. 在 `tests/gridcell-core.test.js` 添加自定义横纵间距、0、空白回退、参数校验及现有画布行为测试；运行确认新行为失败。
2. 在 `tests/panel-smoke.test.js` 添加预览到 Photoshop 描述符的接线、清空/重复失焦/重载、0、无 input 的失焦、非法输入拦截测试；运行确认失败。
3. 修改 `src/lib/gridcell-core.js` 的校验和间距选择；修改 `src/ui/index.html`、`src/ui/styles.css` 和 `src/ui/panel.js` 增加字段、持久化、清空语义、预览和执行参数。
4. 运行针对性测试与完整 `npm test`，运行 `npm run build:dev`。
5. 将开发目录复制成独立命名测试包，附 UDT 加载说明和验收案例，压缩为 ZIP；核对根目录 manifest、入口、图标和源码构建产物。

## 验证结果

- 新增用例先失败后通过；自定义横纵间距、0、空值、清空保存、预览与实际描述符均覆盖。
- `npm test -- --maxWorkers=1 --reporter=dot`：22 文件、768 测试通过。
- `npm run build:dev` 成功。
- 浏览器宿主桩 300/360/480px 布局无新增输入行溢出；清空后失焦、重载保留自动模式。
- 独立只读代码审查无阻塞问题。Photoshop 真机加载留待 UDT 测试。
- 测试包：`dist/Sliceman_UDT_GridSpacing_20261110.zip`。
