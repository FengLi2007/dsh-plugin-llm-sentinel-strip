# dsh-plugin-llm-sentinel-strip

> 把 DeepSeek 的内部令牌（DSML 工具调用标记、`|<ds_safety>…</ds_safety>|>` 这类审查标记）
> 从思考流里剥掉，并在「漏到整轮什么都没产出」时自动补一条「继续」。
>
> 一个 [dsh](https://github.com/deepseek-ai/deepseek-harness)（DeepSeek Harness）插件，
> 挂在 `llm/stream` waterfall 上，改的是**写进 session log 之前**的分片，所以历史天然干净喵。

---

## 解决什么问题

DeepSeek-V4.1 的原生工具调用协议是 **DSML**：

```
<｜｜DSML｜｜ calls>
<｜｜DSML｜ invoke name="pwsh">
<｜｜DSML｜ parameter name="command" string="true">Select-String -Path user\src\*.c</｜｜DSML｜｜ parameter>
</｜｜DSML｜ invoke>
</｜ calls>
```

（`｜` 是全角竖线 U+FF5C，模型有时写一根、有时连着写三根。）

官方的 `dsh-llm-deepseek` 适配器认得这套方言，把它转成真正的 tool call。
**非原生的 provider 路由（例如阿里云百炼的 anthropic-messages 兼容端点）不认**，
于是这段标记原样留在 reasoning 里，harness 没有执行任何工具，模型等不到结果，
就把同一段重写一遍 —— 用户看到的就是**「卡在思考链里无限循环输出」**。

实测对比（同一套系统提示词与工具定义，2026-10-31）：

| 指标 | `deepseek-official/deepseek-flash` | `aliyun/deepseek-v4.1-flash` |
|---|---|---|
| 助手消息 | 331 | 96 |
| DSML 标记 | **0** | **4551** |
| 工具调用 | 375 次，0 丢失 | 107 次，**8 个步骤整轮丢失** |
| 单步最长思考 | 26K 字符 | **117,407 字符 / 同句重复 167 次** |

> 最狠的一步：37,655 字符的思考里 298 个 DSML 标记、0 个真实 tool call ——
> 这一轮什么也没产出，用户只看到屏幕在刷同样的闭合标签。

**根本解法是别把 DeepSeek 模型放在不认 DSML 的路由上**（官方路由同样是 1M 上下文）。
本插件是给「必须留在那条路由上」的场景兜底的喵。

---

## 它做两件事

### ① 剥离

`llm/stream` 钩子，`text` 和 `reasoning` **两条通道都清**：

| 形态 | 处理 |
|---|---|
| `<｜｜DSML｜｜ calls> … </｜｜DSML｜｜ calls>`（含 `invoke` / `tool_calls` 等，可嵌套） | 按标签深度配对，整块摘掉 |
| `<｜｜DSML｜｜ parameter …>`、落单的 `</｜｜DSML｜ invoke>`、光头 `<｜｜DSML｜｜>` | 只删标签本身，周围的字保留 |
| 少了尖括号的 DSML 残片（模型把开头截掉，只剩 `DSML … invoke>`） | 只删残片本身 |
| 其它被竖线包裹的特殊 token（如 tokenizer 的 `begin_of_sentence` 标记） | 按形状兜底删掉 |
| `\|compact]]></custom-content></budget:token_budget>` 上下文预算标记 | 连同两个闭合标签一起删 |
| `\|<ds_safety>…</ds_safety>\|>` / `\|tool_request\|>` 这类安全标记 | 整段摘掉 |
| 开标签被写坏的畸形块（只剩 `[用户未成年]…</ds_safety>\|>`） | 按内容特征兜底摘掉 |

竖线写法实测见到三种（`｜`、`｜｜`、`|`），根数不固定，插件按「任意根」匹配 ——
这也是市面上几个同类插件失效的地方：有的只认单竖线，有的一律要求双竖线。

### ② 续跑

只在**这一轮确实什么都没产出**时补一条「继续」，避免你盯着卡死的界面手动敲字：

- 条件：`turn/end` 是 `completed` **且** 这一轮剥到过令牌 **且** 没有任何 tool call 与非空白正文；
- 不续：`aborted` / `interrupted`、非 `completed` 的任何结束方式；
- 上限：连续 3 次后停下等人（你一旦自己说话，计数清零、待发的续跑取消）；
- 投递走 `agent.followup()`，消息来源标记为 `plugin:llm-sentinel-strip`，不会和你的输入混淆。

---

## 安装

1. 把本仓库放进你的 profile 插件目录：

   ```
   ~/.dsh/profiles/<profile>/plugins/llm-sentinel-strip/
   ```

2. 在同目录的 `cordis.patch.yml` 末尾加一条 insert（示例见
   [`examples/cordis.patch.snippet.yml`](examples/cordis.patch.snippet.yml)）：

   ```yaml
   - insert:
       - id: llm-sentinel-strip
         name: './plugins/llm-sentinel-strip/index.js'
   ```

3. 重启 dsh（插件在 boot 时加载）。

回退：把上面那段 insert 注释掉即可，路由配置一个字都不用动。

---

## 配置

| 环境变量 | 默认值 | 含义 |
|---|---|---|
| `DSH_SENTINEL_STRIP_PROVIDERS` | `aliyun` | 要处理的 provider 路由，逗号分隔；`*` 表示全部 |

默认只处理 `aliyun`：官方路由实测从没漏过令牌，没必要动它。
如果你也走别的兼容网关，设成 `aliyun,siliconflow` 或 `*`：

```powershell
$env:DSH_SENTINEL_STRIP_PROVIDERS = '*'
```

续跑文案固定为「继续」，连续上限 3 次，写在 `index.js` 的 `CONTINUE_TEXT` / `MAX_CONSECUTIVE`。

---

## 为什么挂在 `llm/stream` 上

因为 agent loop 是**拿到分片之后**才写 session log 的：

```js
// @deepseek-ai/dsh-llm
return this.ctx.waterfall(this, 'llm/stream', options, () => this.adapterStream(options, prepared))
```

所以在这里改过的分片才会成为历史。改 UI 只影响显示，改回放只影响下一次请求，
模型照样能读到自己上一轮漏出来的标记。

另一个必须注意的点：**`delta` 和 `block-end` 两边都要改**。
`BlockAssembler` 收到 `block-end` 时会用 `chunk.block` 覆盖掉逐片累加的结果
（`dsh-llm/lib/index.js` 的 `case "block-end"`），只改 delta 等于白改。

流式实现上还有两个细节：

- 一个令牌可能横跨好几个 delta，所以末尾要扣住最多 160 个字符等它拼完 ——
  普通尖括号与竖线最多被延迟一个分片，不会丢；
- 流被取消、走不到 `block-end` 时，把扣住的尾巴补发出去，不丢字。

---

## 测试

```bash
node smoke.mjs
```

19 条本地断言，不连模型、不开 dsh、不读任何会话文件：

- 普通文本（含 markdown 表格竖线、`<stdio.h>` 这类普通尖括号）原样通过；
- DSML 整块 / 落单标签 / 多根竖线 / ASCII 竖线全被剥干净；
- 少了尖括号的残片、其它特殊 token、`|compact]]>` 也被剥干净；
- 安全标记与畸形块被剥干净；
- **逐字符分片**与整段处理结果完全一致；
- `block-end` 里的完整块也被清洗；
- 非目标路由不碰内容；
- 流被取消时尾巴补发；
- 续跑判据的六种分支。

真实数据验证（17 个会话 / 1203 个文本与思考块，2026-10-31）：33 个块被改，
剥掉 **314,663 字符**；清洗后 DSML、竖线类特殊 token、`|compact]]>`、安全标记
残留全部为 **0**。单会话抽样：74 条助手消息里 DSML 标记 **999 → 0**，
最大一块 37,655 → 21,925，5 字符分片流与整段结果逐字节一致。

---

## 兼容性

- 适配 dsh `0.2.1-rc.2` / `0.2.1-rc.3`（`llm/stream` waterfall、`session/event`、
  `ctx.agents.get(id).followup()`）。
- 只用 `ctx.on` / `ctx.effect` / `ctx.agents` / `StreamChunk` 的公开字段，不 import dsh 内部模块。
- 单文件、零依赖、无网络、无文件读写。

dsh 升级后如果 waterfall 或事件名变了，需要跟着调整。

---

## 许可

[MIT](LICENSE)