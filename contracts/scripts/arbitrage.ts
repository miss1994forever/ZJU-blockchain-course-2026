import hre from "hardhat";
import { readDeployment, asUser } from "./shared.js";
import { writeFile } from "node:fs/promises";
const { ethers } = await hre.network.create();
const config = await readDeployment();
const dexes = await Promise.all(
  config.exchanges.map((d: { address: string }) =>
    ethers.getContractAt("MiniDEX", d.address),
  ),
);
const arb = await ethers.getContractAt("AtomicArbitrage", config.arbitrage);
const [trader] = await ethers.getSigners();
const first = await dexes[0].pools(1);
const tokenA = await ethers.getContractAt("TestToken", first.tokenA);
const tokenB = await ethers.getContractAt("TestToken", first.tokenB);
for (const t of [tokenA, tokenB]) {
  await (await t.faucet()).wait();
  await (await t.approve(arb.target, ethers.MaxUint256)).wait();
  for (const d of dexes)
    await (await t.approve(d.target, ethers.MaxUint256)).wait();
}
// Simulated trader creates a visible price gap. Arbitrage search itself is automatic.
await (
  await dexes[1].swap(
    1,
    tokenB.target,
    ethers.parseEther("600"),
    0,
    ethers.MaxUint256,
  )
).wait();
async function snapshot() {
  return Promise.all(
    dexes.map(async (d) => {
      const p = await d.pools(1);
      return {
        address: String(d.target),
        tokenA: p.tokenA,
        tokenB: p.tokenB,
        reserveA: String(p.reserveA),
        reserveB: String(p.reserveB),
        priceBperA:
          Number(ethers.formatEther(p.reserveB)) /
          Number(ethers.formatEther(p.reserveA)),
      };
    }),
  );
}
let best = {
  profit: 0n,
  amount: 0n,
  buy: 0,
  sell: 1,
  token: String(tokenA.target),
};
for (const [buy, sell] of [
  [0, 1],
  [1, 0],
])
  for (const token of [tokenA, tokenB]) {
    for (let amount = 1; amount <= 300; amount++) {
      const input = ethers.parseEther(String(amount));
      const intermediate = token.target === tokenA.target ? tokenB : tokenA;
      const mid = await dexes[buy].getAmountOut(1, token.target, input);
      const out = await dexes[sell].getAmountOut(1, intermediate.target, mid);
      if (out - input > best.profit)
        best = {
          profit: out - input,
          amount: input,
          buy,
          sell,
          token: String(token.target),
        };
    }
  }
if (best.profit <= 0n) throw new Error("No profitable route found");
const before = await snapshot();
const base = await ethers.getContractAt("TestToken", best.token);
const balance = await base.balanceOf(trader.address);
const tx = await arb.execute(
  dexes[best.buy].target,
  1,
  dexes[best.sell].target,
  1,
  best.token,
  best.amount,
  (best.profit * 99n) / 100n,
  ethers.MaxUint256,
);
const receipt = await tx.wait();
const profit = (await base.balanceOf(trader.address)) - balance;
if (profit <= 0n) throw new Error("Expected positive profit");
const report = {
  generatedAt: new Date().toISOString(),
  trader: trader.address,
  tx: tx.hash,
  blockNumber: receipt!.blockNumber,
  gasUsed: String(receipt!.gasUsed),
  buy: best.buy,
  sell: best.sell,
  token: best.token,
  amountIn: String(best.amount),
  profit: String(profit),
  profitExcludesNativeGas: true,
  before,
  after: await snapshot(),
};
await writeFile(
  "../docs/arbitrage-report.json",
  JSON.stringify(report, null, 2),
);
await writeFile(
  "../frontend/public/arbitrage-report.json",
  JSON.stringify(report, null, 2),
);
console.log(
  `Atomic arbitrage profit: ${ethers.formatEther(profit)} ${await base.symbol()} (before native gas). Transaction: ${tx.hash}`,
);
