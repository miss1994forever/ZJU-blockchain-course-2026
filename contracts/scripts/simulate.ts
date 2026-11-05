import hre from "hardhat";
import { readDeployment, asUser } from "./shared.js";
import { writeFile } from "node:fs/promises";
const { ethers } = await hre.network.create();
const config = await readDeployment();
const users = await ethers.getSigners();
if (users.length < 20)
  throw new Error("Start local node with at least 20 funded accounts");
const tokens = await Promise.all(
  config.tokens.map((t: { address: string }) =>
    ethers.getContractAt("TestToken", t.address),
  ),
);
const dexes = await Promise.all(
  config.exchanges.map((d: { address: string }) =>
    ethers.getContractAt("MiniDEX", d.address),
  ),
);
let seed = 20261105;
const random = (n: number) => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed % n;
};
const records: object[] = [];
const counts = { swap: 0, add: 0, remove: 0 };
// Every one of the 20 addresses participates, across both independently deployed DEXes.
for (const user of users.slice(0, 20)) {
  for (const token of tokens) {
    await (await asUser(token, user).faucet()).wait();
    for (const dex of dexes)
      await (
        await asUser(token, user).approve(dex.target, ethers.MaxUint256)
      ).wait();
  }
}
for (let round = 0; round < 4; round++) {
  for (const user of users.slice(0, 20)) {
    const di = random(2);
    const dex = asUser(dexes[di], user);
    const amount = ethers.parseEther(String(5 + random(26)));
    if (round === 0 || random(3) === 0) {
      const id = (await dex.positionCount()) + 1n;
      const tx = await dex.addLiquidity(
        1,
        amount,
        amount,
        0,
        0,
        ethers.MaxUint256,
      );
      await tx.wait();
      counts.add++;
      records.push({
        kind: "add",
        user: user.address,
        dex: di,
        tokenId: String(id),
        tx: tx.hash,
      });
      // Keep some NFTs live for inspection and withdraw others after swaps in later rounds.
    } else {
      const token = tokens[random(2)];
      const quote = await dex.getAmountOut(1, token.target, amount);
      const tx = await dex.swap(
        1,
        token.target,
        amount,
        (quote * 99n) / 100n,
        ethers.MaxUint256,
      );
      await tx.wait();
      counts.swap++;
      records.push({
        kind: "swap",
        user: user.address,
        dex: di,
        amount: String(amount),
        tx: tx.hash,
      });
    }
  }
}
for (let di = 0; di < dexes.length; di++) {
  const dex = dexes[di];
  const count = Number(await dex.positionCount());
  for (let id = 3; id <= count; id += 3) {
    let owner: string;
    try {
      owner = await dex.ownerOf(id);
    } catch {
      continue;
    } // Burned positions from an earlier run remain in history.
    const signer = users.find((u) => u.address === owner);
    if (!signer) continue;
    const tx = await asUser(dex, signer).removeLiquidity(
      id,
      0,
      0,
      ethers.MaxUint256,
    );
    await tx.wait();
    counts.remove++;
    records.push({
      kind: "remove",
      user: owner,
      dex: di,
      tokenId: id,
      tx: tx.hash,
    });
  }
}
const pools = [];
for (const dex of dexes) {
  const p = await dex.pools(1);
  const expected = new Map<string, bigint>();
  const poolCount = Number(await dex.poolCount());
  for (let id = 1; id <= poolCount; id++) {
    const pool = await dex.pools(id);
    expected.set(
      pool.tokenA,
      (expected.get(pool.tokenA) ?? 0n) + pool.reserveA,
    );
    expected.set(
      pool.tokenB,
      (expected.get(pool.tokenB) ?? 0n) + pool.reserveB,
    );
  }
  // A token balance belongs to the whole DEX, including user-created extra pools.
  for (const [address, reserve] of expected) {
    const token = await ethers.getContractAt("TestToken", address);
    if ((await token.balanceOf(dex.target)) !== reserve)
      throw new Error("Reserve/accounting mismatch");
  }
  if (p.reserveA <= 0n || p.reserveB <= 0n || p.totalShares <= 0n)
    throw new Error("Invalid pool state");
  pools.push({
    dex: String(dex.target),
    reserveA: String(p.reserveA),
    reserveB: String(p.reserveB),
    totalShares: String(p.totalShares),
  });
}
const report = {
  generatedAt: new Date().toISOString(),
  seed: 20261105,
  users: users.slice(0, 20).map((u) => u.address),
  counts,
  pools,
  records,
};
await writeFile(
  "../docs/simulation-report.json",
  JSON.stringify(report, null, 2),
);
await writeFile(
  "../frontend/public/simulation-report.json",
  JSON.stringify(report, null, 2),
);
console.log(
  `Simulation complete: 20 users; ${JSON.stringify(counts)}. Reserve balances verified.`,
);
