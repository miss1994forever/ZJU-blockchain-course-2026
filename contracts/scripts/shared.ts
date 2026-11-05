import { readFile } from "node:fs/promises";
import { type BaseContract, type Signer } from "ethers";
export interface Deployment {
  chainId: number;
  rpcUrl: string;
  tokens: { address: string; symbol: string; decimals: number }[];
  exchanges: { address: string; name: string }[];
  arbitrage: string;
}
export async function readDeployment(): Promise<Deployment> {
  return JSON.parse(
    await readFile("../deployments/localhost.json", "utf8"),
  ) as Deployment;
}
// A new runner preserves the deployed contract's ABI and generated method types.
export const asUser = <T extends BaseContract>(
  contract: T,
  signer: Signer,
): T => contract.connect(signer) as T;
