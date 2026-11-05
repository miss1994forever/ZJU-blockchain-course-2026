import hre from "hardhat";
import { asUser } from "./shared.js";
const { ethers } = await hre.network.create();
const users = await ethers.getSigners();
const gamma = await ethers.deployContract("TestToken", [
  "Campus Gamma",
  "GAMMA",
]);
await gamma.waitForDeployment();
await (await asUser(gamma, users[2]).faucet()).wait();
console.log(
  `Additional 18-decimal token: ${gamma.target}. Account 3 received 10,000 GAMMA. Create an ALPHA/GAMMA pool from the UI.`,
);
