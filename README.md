# Alma Plugin — DeepSeek Balance

在 Alma 输入框下方的状态栏显示 DeepSeek 账户余额与今日已用，点击查看明细（充值 / 赠金分项、峰谷时段、下次切换时刻）。

```
¥66.31 · 今日 ¥0.54
```

仓库结构与官方插件市场 [`yetone/alma-plugins`](https://github.com/yetone/alma-plugins) 保持一致，因此既可以自己安装，也可以直接把整个插件目录 + `registry.json` 条目作为 PR 提上去。

## 目录结构

```
.
├── plugins/deepseek-balance/     # 插件本体（manifest.json + main.ts + README.md）
├── registry.json                 # 市场索引条目
├── scripts/lint-versions.mjs     # 与官方 CI 相同的版本一致性校验
├── LICENSE
└── package.json
```

## 安装

方式一，直接拷目录：

```bash
cp -r plugins/deepseek-balance ~/.config/alma/plugins/
```

Windows 上是 `%USERPROFILE%\.config\alma\plugins\`。然后 设置 → 插件 → 刷新（或重启 Alma）。

方式二，从 GitHub 装（Alma 会下载 zipball 并取 `plugins/deepseek-balance` 子目录）：

```
https://github.com/gasdyueer/alma-plugin-deepseek-balance/tree/main/plugins/deepseek-balance
```

## API Key

插件按以下顺序解析，**通常不用配置任何东西**：

1. 设置项 `deepseekBalance.apiKey`（手动覆盖）
2. 插件加密存储 `secrets.deepseekApiKey`（弹窗里「设置 API Key」写入）
3. 设置项 `deepseekBalance.apiKeyFile` 指向的纯文本文件（可选，**默认留空**）
4. Alma 里已配置的 DeepSeek 提供商（自动复用其 Key）

只要 Alma 里存在 DeepSeek 提供商，装完就能直接显示余额。若该提供商填了自定义 `baseURL`（走中转），插件会跳过 —— 中转商的 Key 查不了官方余额接口。

密钥不会被写进本仓库：仓库里没有 key、没有本机路径、没有账本数据。`.gitignore` 已排除 `.env`、`secrets.json`、`storage.json`、`.dpsk*` 等。

## 校验

```bash
node scripts/lint-versions.mjs        # 检查 manifest / registry / package.json 版本是否一致
node scripts/lint-versions.mjs --fix  # 用 manifest 覆盖 registry 里的版本号
```

与官方 CI 的 `.github/workflows/lint.yml` 用的是同一份脚本，本地绿了 PR 就不会被版本号卡住。

## 提交到官方插件市场

1. Fork [`yetone/alma-plugins`](https://github.com/yetone/alma-plugins)
2. 把 `plugins/deepseek-balance/` 整个目录拷进 fork 的 `plugins/` 下
3. 把 `registry.json` 里那条 plugin 条目合并进 fork 的 `registry.json`
4. `node scripts/lint-versions.mjs` 本地过一遍
5. 开 PR

市场索引地址是客户端硬编码的 `https://raw.githubusercontent.com/yetone/alma-plugins/main/registry.json`，合并 main 后用户刷新插件列表就能搜到。

## 维护提醒

- `plugins/deepseek-balance/main.ts` 里的 `HOLIDAY_VALLEY` 只列了 2026 年法定节假日，每年国务院公布次年安排后需要补日期，否则次年节假日的谷时判断会退回「按工作日」处理。
- 弹窗基于 `showQuickPick`，不是自绘面板：`contributes.components` 里的自定义 component 在当前 Alma 版本没有渲染入口。

## License

MIT
