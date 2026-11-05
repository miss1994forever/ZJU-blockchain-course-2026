# Campus AMM frontend

React + TypeScript + Vite + Ethers。完整步骤见 [项目 README](../README.md)。

先启动本地链并部署合约，以自动生成 `src/generated/` 中的 ABI 与地址，然后运行：

```bash
npm ci
npm run dev
# 生产构建
npm run build
```

默认地址 http://localhost:3000 。本地教学账户模式使用本地节点解锁的账户，不保存私钥；钱包模式检查 Chain ID 和当前账户。
