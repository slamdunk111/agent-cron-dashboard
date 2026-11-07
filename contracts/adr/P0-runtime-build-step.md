# ADR P0-3: 发布包以 esbuild 产物为 dsh 入口

- 状态：已采纳（P0，2026-11-07）
- 决策面：`scripts/build-bundles.mjs`、各包 `package.json` 的 `main`/`exports`

## 动机

模板与 host-plugin.md 的入口都是纯 JS；dsh 0.2.2-rc.1 的加载器对入口做 `import()`，不带运行时 TypeScript 支持——直接把 `src/index.ts` 写进 `main` 会装载失败。另一方面 monorepo 里用 TS 直写、vitest 原生跑 TS 的体验更好。

## 变更面

1. 开发态：源码 TS（`src/`、`client/`），vitest 与 tsc 直接读 TS。
2. 发布/装载态：`node scripts/build-bundles.mjs` 生成 `build/packages/<name>/`——复制 `package.json`（改写 `main`→`./index.js`、`exports`→构建产物、`private: true`）、`cordis.patch.yml`、`locale/`、`icon.svg`，并把 host 入口与 client 入口打成 ESM（`@deepseek-ai/cordis`、`@deepseek-ai/schemastery`、`@deepseek-ai/dsh-storage-domain`、`zod` 保持 external）。
3. **具名导出保真**：esbuild 把自身生成的 `export {...}` 写在文件尾，`footer` 追加的 `export * from` 会被排在其后而失效（实测 SyntaxError: unexpected export）。因此每个入口产出两个文件：`index-impl.js`（实现体）与 `index.js`（仅一行 `export * from "./index-impl.js"`），dsh 读到的 `apply`/`name`/`Config` 等具名导出由此保证。
3. `install_bundle` 的 `target` 指向 `build/packages/<name>` 目录；P8 发布时改打 npm 包。

## 受影响 plan

- 全部 plan 的装载步骤（§5 验收门 2）：先 build，再 install。
