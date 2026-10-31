# dsh-plugin-llm-sentinel-strip

> 把 DashScope（阿里云百炼）`anthropic-messages` 路由漏进思考流的模型内部令牌剥掉，
> 阻止 DeepSeek Harness 的思考链退化成无限复读。

一个 [dsh](https://github.com/deepseek-ai/deepseek-harness)（DeepSeek Harness）插件，
挂在 `llm/stream` waterfall 上，改的是**写进 session log 之前**的分片，所以历史天然干净喵。

---

## 解决什么问题

把 dsh 的模型路由切到百炼（`https://dashscope.aliyuncs.com/apps/anthropic`）之后，
思考流里会混进这样的东西：

```
</calls> |<ds_safety>[用户未成年]否
[分类]其他
[判定]用户询问智能车代码中滑行减速标定模式的设计与实现，属于嵌入式控制与软件工程的技术讨论，不涉及政治敏感内容。
[规则]无</ds_safety>|>Since the previous message was malformed, let me re-read the page block properly.
```

这些标记一旦被记录进历史，模型下一拍会把末尾的 `|>` 当成「上一段没闭合」的分隔符，
于是把同一段工具调用重写一遍，再重写一遍 —— 思考越滚越长，用户看到的就是
**「卡在思考链里循环输出」**。

实测（同一套系统提示词与工具定义）：

| 路由 | 助手消息 | 含 `ds_safety` | 最长单步思考 | 同句重复 |
|---|---|---|---|---|
| `deepseek-official/deepseek-flash` | 331 | **0** | 26K 字符 | 1~2 次 |
| `aliyun/deepseek-v4.1-flash` | 96 | **22**（共 1033 个标签） | **117,407 字符** | **167 次** |

泄漏的不只是 `ds_safety` —— 同一个流里还有 `|tool_request|>{...}` 和
`|compact]]></custom-content></budget:token_budget>`，说明是**整套内部令牌没被服务端剥掉**，
而不是某一次审查注入了什么。

> 注意：这个现象是**条件触发**的。短请求直连该端点复现不出来（实测两次探测都是 0），
> 第一次出现在切换路由后的第 21 条消息、模型在思考里写坏一次工具调用之后。
> 所以不要用「发一条短消息没复现」来否定它。

---

## 安装

1. 把本仓库放进你的 profile 插件目录：

   ```
   ~/.dsh/profiles/<profile>/plugins/llm-sentinel-strip/
   ```

2. 在同目录的 `cordis.patch.yml` 末尾加一条 insert（完整示例见
   [`examples/cordis.patch.snippet.yml`](examples/cordis.patch.snippet.yml)）：

   ```yaml
   - insert:
       - id: llm-sentinel-strip
         name: './plugins/llm-sentinel-strip/index.js'
   ```

3. 重启 dsh（插件在 boot 时加载）。

回退：把上面那段 insert 注释掉即可，路由配置一个字都不用动。

> `name` 是相对 `cordis.patch.yml` 所在目录的路径；用绝对 `file://` URL 也可以。

---

## 配置

| 环境变量 | 默认值 | 含义 |
|---|---|---|
| `DSH_SENTINEL_STRIP_PROVIDERS` | `aliyun` | 要清洗的 provider 路由，逗号分隔；`*` 表示全部 |

默认只清 `aliyun`：官方路由实测从没漏过令牌，没必要动它的内容。
如果你也走别的兼容网关，可以设成 `aliyun,qwen3.7-plus` 或者 `*`。

```powershell
$env:DSH_SENTINEL_STRIP_PROVIDERS = '*'
```

---

## 剥什么、不剥什么

剥四种形态，按出现位置先后来处理，保证不会把正常正文当令牌吞掉：

| 形态 | 例子 | 处理 |
|---|---|---|
| 配对块 | `\|<ds_safety>…</ds_safety>\|>` | 配对成功才整段删 |
| 畸形块 | `[用户未成年]否 … </ds_safety>\|>`（开标签被模型写坏） | 按内容特征兜底整段删 |
| 自闭合标记 | `\|tool_request\|>` | 只删标记本身 |
| 落单结束符 | `</ds_safety>\|>` | 只删结束符 |

**不处理**：

- `|compact]]></custom-content></budget:token_budget>` 这类不带 `|<tag>` 结构的泄漏
  （实测只有 2 处，且不像 `|>` 那样诱发复读）；
- 工具参数（`tool-call-delta`）里出现的令牌 —— 那是 JSON，盲删会破坏工具调用；
- `|tool_request|>` 后面的幽灵 JSON，当普通正文留着。

---

## 为什么挂在 `llm/stream` 上

因为 agent loop 是**拿到分片之后**才写 session log 的：

```js
// @deepseek-ai/dsh-llm
return this.ctx.waterfall(this, 'llm/stream', options, () => this.adapterStream(options, prepared))
```

所以在这里改过的分片才会成为历史。改 UI 只影响显示，改回放只影响下一次请求，
模型照样能读到自己上一轮漏出来的标记，照样复读。

另一个必须注意的点：**`delta` 和 `block-end` 两边都要改**。
`BlockAssembler` 收到 `block-end` 时会用 `chunk.block` 覆盖掉逐片累加的结果
（`dsh-llm/lib/index.js` 里的 `case "block-end"`），只改 delta 等于白改。

流式实现上还有两个细节：

- 一个令牌可能横跨三四个 delta，所以末尾要扣住最多 40 个字符，等它拼完 ——
  正文里的普通竖线（markdown 表格、命令行管道）最多被延迟一个分片，不会丢；
- 流被取消、走不到 `block-end` 时，把扣住的尾巴补发出去，不丢字。

---

## 测试

```bash
node smoke.mjs
```

10 条本地断言，不连模型、不开 dsh、不读任何会话文件：

- 普通文本（含 markdown 表格竖线）原样通过；
- 四种令牌形态各自被剥干净；
- **逐字符分片**与整段处理结果完全一致；
- `block-end` 里的完整块也被清洗；
- 非 `aliyun` 路由不碰内容；
- 流被取消时尾巴补发。

用真实数据验证过：72 个思考块里 23 个被改，`ds_safety` 从 **1033 → 0**，
剥掉 50,814 字符，剩余 `</tag>|>` 为 0，最大一块 117,407 字符的整段清洗与
7 字符分片流结果完全一致。

---

## 兼容性

- 适配 dsh `0.2.1-rc.3`（`@deepseek-ai/dsh-llm` 的 `llm/stream` waterfall、
  `StreamChunk` 协议）。
- 只用 `ctx.on()` 和 `StreamChunk` 的公开字段，不 import 任何 dsh 内部模块。
- 单文件、零依赖、无网络、无文件读写 —— 只做字符串变换。

dsh 升级后如果 waterfall 改名或 `StreamChunk` 字段变了，需要跟着调整。

---

## 许可

[MIT](LICENSE)