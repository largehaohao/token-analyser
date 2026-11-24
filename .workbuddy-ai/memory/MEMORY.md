# Token Analyser · 项目长期笔记

## UI 约定

- `apps/web` 是 Vite + React 19 + 手写 CSS；`apps/web/src/styles.css` 的 `:root` 是**唯一**运行时调色板来源，`scripts/verify-ui-tokens.mjs` 会校验 16 项与 `DESIGN.md` frontmatter 的一致性（只读第一个 `:root` 块，别在它之前插入新 `:root`）。
- 2026-11-10 起已完整接入 shadcn/ui（Tailwind v4 + Radix + CVA + lucide-react，配置见 `apps/web/components.json`，组件在 `src/components/ui/`）。默认选择是**保留浅色 STRATA 主题**：`src/shadcn.css` 用 `@theme inline` 把 shadcn 语义色别名到现有令牌，且**不引入 Tailwind preflight**；legacy CSS 无 layer，优先级高于 Tailwind utilities。
- 引入新 shadcn 组件时沿用 `src/ui.tsx` / `src/components/ui/legacy-badge.tsx` 的兼容层写法：保留旧 class、aria、data-testid，用中和 class 抵掉 shadcn 自带的布局几何，避免视觉漂移。
- 不要替换成 Radix 实现的原生语义：原生 `<select>`（`selectOption()` / `<option>`）、`<details>/<summary>`、`aria-pressed` 分段按钮（`role="group"`）、`role="meter"`、原生 checkbox、图表 tooltip —— e2e 与 `UX-CONTRACT.md` 强依赖。

## 环境与验证

- 本地：`pnpm dev` → UI `127.0.0.1:7788`、engine `127.0.0.1:7789`。常用校验：`pnpm --filter web exec tsc --noEmit`、`pnpm --filter web build`、`pnpm test`、`node scripts/verify-ui-tokens.mjs`。
- e2e 需要清空代理：`env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy NO_PROXY=127.0.0.1,localhost ...`；Playwright 清空旧 `test-results` 会触发 bulk-delete 保护，用 `--output=/tmp/<fresh>`。
- 本机没有 Playwright 浏览器下载，跑 e2e 需临时 config 把 `launchOptions.executablePath` 指向系统 Chrome（`/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`），跑完删除临时 config。
- e2e 存在既有/环境性失败：dashboard 1600/1440px turn-table 溢出、`ux-contract` 1280/390px WCAG、3 个 `native-sessions` 源控件用例（spec 里 combobox 内找 button 的陈旧断言）、`hardware-power` 演示数据时间抖动、`review-regressions` 输出速度直方图轴标签。判断回归要与 HEAD 干净 worktree 基线对比，别只看绝对失败数。
