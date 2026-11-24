# DeepSeek Balance — Alma 插件

在输入框下方状态栏显示 DeepSeek 账户余额与今日已用，点击弹出明细面板。

## 效果

状态栏（右侧，紧跟 Token Counter）：

```
¥66.31 · 今日 ¥0.54
```

点击后弹出明细：

- 总余额（充值 / 赠金分项）
- 今日已用（北京时间 00:00 起算，按余额差记账）
- 较上次查询的变动
- 当前是峰时还是谷时，以及还有多久切换
- 刷新余额 / 设置 API Key / 打开用量页

## 安装

```bash
cp -r deepseek-balance ~/.config/alma/plugins/
```

然后在 设置 → 插件 点刷新（或重启 Alma）。

## API Key 从哪来

按以下顺序解析：

1. 插件设置 `deepseekBalance.apiKey`（手动覆盖，优先级最高）
2. 插件自己的加密存储 `secrets.deepseekApiKey`（在弹窗里「设置 API Key」填入）
3. **`deepseekBalance.apiKeyFile` 指向的密钥文件**（可选，默认留空即不启用）
4. Alma 里已配置的 DeepSeek 提供商（读本地 23001 端口的 `/api/providers`）

绝大多数人不需要配置任何东西：只要 Alma 里已经建好了 DeepSeek 提供商，插件会直接复用它的 Key。

第 3 条是给「不想让 key 进应用配置、想单独放一个文件管理」的人准备的。填上文件路径后，插件每次启动读它，轮换时改文件即可。默认值为空，因此公开分发时不预设任何本机路径。

文件读取会清洗 BOM、首尾引号和换行，再用 `^sk-[A-Za-z0-9_-]{10,}$` 校验格式，不合格就忽略并回退到下一级来源。

第 4 条是兜底。如果那个提供商填了自定义 `baseURL`（走中转），插件会跳过 —— 中转商的 Key 查不了官方余额，硬查只会得到 401。

### 关于泄密

- key 不会出现在日志里。日志只记录"从哪个文件读到了"和余额金额。
- 界面和 tooltip 里只露尾号 4 位（`sk-••••dcf2`），跟 DeepSeek 平台自己的显示习惯一致。
- `storage.json` 只存余额数字，不存 key。
- 手动填的 key 走 Electron `safeStorage` 加密后写进 `secrets.json`，不是明文。

## 今日已用怎么算的

用**今日基线**，不用逐次累加：

```
今日已用 = 今日 00:00 的余额基线 − 当前余额
```

这样跨进程重启、几小时不刷新都不会丢账。

- 跨天时，昨天的收盘余额自动成为今天的期初基线。
- 余额上涨视为充值，基线同步抬高，今日已用不会倒退。
- 插件第一次运行时不知道 00:00 时的余额，会以当下为基线（从 0 开始算），此时需要校准一次。

### 校准

点状态栏 → 「校准今日已用」→ 填 DeepSeek 平台上这个 key 今天已消费的金额。

校准后 `dayOpen = 当前余额 + 你填的金额`，之后每次刷新都自动跟着余额走。一天手动校准一次就够，之后跨天是全自动的。

## 设计取舍

这些细节参考了常见余额挂件的做法，每条都有具体原因：

**不臆造 0。** 接口没给 `granted_balance` / `topped_up_balance` 时显示 `—`，不是 `0`。0 在记账里意味着"余额真的见底"，那是完全不同的语义。

**失败不覆盖旧值。** 网络断了就保留上一次成功的余额，只在 tooltip 里标一行"最近一次刷新失败"。突然显示 `¥ —` 比显示一个稍旧的数字更让人慌。

**重试但不打爆。** 网络错误和 5xx 重试一次（间隔 600ms），4xx 立刻放弃。401/403 直接翻译成"API Key 无效"，不重试。

**用余额差记账。** 余额跌了算消耗，涨了当作充值、只抬基线。不依赖官方用量接口，也不需要知道具体模型单价。

**节流。** 手动触发（点刷新、改 Key）不节流；事件触发（收到消息、切线程）45 秒内最多一次。

**峰谷判断和切换时刻同源。** 用同一个 `isPeakTime()` 同时决定"现在是不是峰时"和"下一个切换点是几点"，两者永远不会互相矛盾。

**只重绘不发请求。** 有个 30 秒 ticker 只更新 tooltip 里的倒计时，不碰网络；内容没变时不触发 UI 更新。

## 配置项

| 键 | 默认 | 说明 |
|---|---|---|
| `deepseekBalance.refreshMinutes` | 5 | 自动刷新间隔（分钟） |
| `deepseekBalance.showToday` | true | 状态栏是否显示今日已用 |
| `deepseekBalance.showPeak` | true | 明细里是否显示峰谷时段 |
| `deepseekBalance.lowBalance` | 5 | 低于该值状态栏加 ⚠ |
| `deepseekBalance.providerId` | `deepseek` | 优先从哪个 Alma 提供商读 Key |
| `deepseekBalance.apiKeyFile` | 空 | 可选：密钥文件路径，留空则跳过该来源 |
| `deepseekBalance.apiKey` | 空 | 手动覆盖（不推荐，用弹窗填） |

## 峰谷时段规则

工作日（周一至周五，不含法定节假日）：

- 峰时 **09:00–12:00**、**14:00–18:00** —— 标准价
- 其余时段为谷时 —— 标准价 5 折
- 周末、法定节假日全天谷时

北京时间。`main.ts` 里的 `HOLIDAY_VALLEY` 只列了 2026 年的放假日，**每年国务院公布次年安排后需要补下一年的日期**。

## 文件位置

- 插件代码：`~/.config/alma/plugins/deepseek-balance/`
- 今日账本：`<用户数据目录>/alma/plugin-storage/deepseek-balance/storage.json`
  - Windows：`%APPDATA%`，macOS：`~/Library/Application Support`，Linux：`~/.config`
- 手动 Key（加密）：同上目录下的 `secrets.json`
- 日志：`<用户数据目录>/alma/logs/native.log`，搜索 `[Plugin:deepseek-balance]`

## 已知限制

- 弹窗用的是 Alma 的 `showQuickPick`，不是自绘 HTML 面板。它跨主题、跨平台都稳，而 `contributes.components` 里的自定义 component 在当前版本没有渲染入口。
- "今日已用"按余额差算：若两次查询之间先充值后消费，可能有少量偏差；跨 0 点的那次查询会把午夜前的消耗算进新的一天。
- 只统计本机通过 Alma 的 DeepSeek 提供商发出的调用次数。其他渠道的消耗计入余额差，但不计入调用次数。
- 同一个 DeepSeek 账号下若有多个 key，余额接口返回的是**账号总额**，无法按 key 拆分。平台上的 per-key 明细只能靠人工校准进来。
