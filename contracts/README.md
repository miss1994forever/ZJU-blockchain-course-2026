# Campus AMM contracts

完整说明见 [项目 README](../README.md) 和 [实现分析](../docs/implementation.md)。

```bash
npm ci
npm test
npm run typecheck
npm run node
# 另一终端，位于本目录：
npm run deploy
npm run simulate
npm run arbitrage
```

`npm run extra-token` 可部署额外的 GAMMA 代币并给第三个开发账户发币，用于前端创建新币对。

编译器 solc 0.8.20 已固定为 npm 依赖；使用本地 solc-js。所有脚本都以本目录为工作目录，根目录 npm scripts 会自动切换。
