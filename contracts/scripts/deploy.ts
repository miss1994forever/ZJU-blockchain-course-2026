import hre from "hardhat";
import { mkdir, writeFile } from "node:fs/promises";
const { ethers } = await hre.network.create();
const [owner] = await ethers.getSigners();
const a = await ethers.deployContract("TestToken", ["Campus Alpha", "ALPHA"]);
const b = await ethers.deployContract("TestToken", ["Campus Beta", "BETA"]);
const one = await ethers.deployContract("MiniDEX");
const two = await ethers.deployContract("MiniDEX");
const arb = await ethers.deployContract("AtomicArbitrage");
await Promise.all([a, b, one, two, arb].map((c) => c.waitForDeployment()));
for (const t of [a, b]) await (await t.faucet()).wait();
for (const dex of [one, two]) {
  await (await dex.createPool(a.target, b.target)).wait();
  for (const t of [a, b])
    await (await t.approve(dex.target, ethers.MaxUint256)).wait();
  await (
    await dex.addLiquidity(
      1,
      ethers.parseEther("2000"),
      ethers.parseEther("2000"),
      0,
      0,
      ethers.MaxUint256,
    )
  ).wait();
}
const network = await ethers.provider.getNetwork();
const config = {
  chainId: Number(network.chainId),
  rpcUrl: "http://127.0.0.1:8545",
  deployedAt: new Date().toISOString(),
  deployer: owner.address,
  tokens: [
    { address: String(a.target), symbol: "ALPHA", decimals: 18 },
    { address: String(b.target), symbol: "BETA", decimals: 18 },
  ],
  exchanges: [
    { name: "West Lake", address: String(one.target) },
    { name: "Qiantang", address: String(two.target) },
  ],
  arbitrage: String(arb.target),
};
await mkdir("../frontend/src/generated", { recursive: true });
await mkdir("../deployments", { recursive: true });
await writeFile(
  "../deployments/localhost.json",
  JSON.stringify(config, null, 2),
);
await writeFile(
  "../frontend/src/generated/deployment.json",
  JSON.stringify(config, null, 2),
);
for (const name of ["MiniDEX", "TestToken", "AtomicArbitrage"]) {
  const artifact = await hre.artifacts.readArtifact(name);
  await writeFile(
    `../frontend/src/generated/${name}.json`,
    JSON.stringify(artifact.abi),
  );
}
console.log(JSON.stringify(config, null, 2));
