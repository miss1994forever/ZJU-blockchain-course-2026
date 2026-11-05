import { expect } from "chai";
import hre from "hardhat";
import { asUser } from "../scripts/shared.js";
const { ethers, networkHelpers } = await hre.network.create();
const E = ethers.parseEther;
const MAX = ethers.MaxUint256;

async function fixture() {
  const [owner, alice, bob] = await ethers.getSigners();
  const x = await ethers.deployContract("TestToken", ["A", "A"]);
  const y = await ethers.deployContract("TestToken", ["B", "B"]);
  const [a, b] =
    String(x.target).toLowerCase() < String(y.target).toLowerCase()
      ? [x, y]
      : [y, x];
  const dex = await ethers.deployContract("MiniDEX");
  const other = await ethers.deployContract("MiniDEX");
  const arb = await ethers.deployContract("AtomicArbitrage");
  for (const user of [owner, alice, bob]) {
    for (const t of [a, b]) {
      await asUser(t, user).faucet();
      for (const d of [dex, other, arb])
        await asUser(t, user).approve(d.target, MAX);
    }
  }
  for (const d of [dex, other]) {
    await d.createPool(a.target, b.target);
    await d.addLiquidity(1, E("1000"), E("1000"), 0, 0, MAX);
  }
  return { owner, alice, bob, a, b, dex, other, arb };
}

describe("MiniDEX & atomic arbitrage", function () {
  it("canonicalizes token pairs and rejects invalid/duplicate pools", async function () {
    const { dex, a, b, alice } = await networkHelpers.loadFixture(fixture);
    expect((await dex.pools(1)).tokenA).to.equal(a.target);
    await expect(dex.createPool(b.target, a.target)).to.be.revertedWith(
      "Pool exists",
    );
    await expect(dex.createPool(a.target, a.target)).to.be.revertedWith(
      "Invalid tokens",
    );
    await expect(dex.createPool(a.target, alice.address)).to.be.revertedWith(
      "Invalid tokens",
    );
  });
  it("mints NFT metadata and consumes only ratio-matched liquidity", async function () {
    const { dex, a, b, alice } = await networkHelpers.loadFixture(fixture);
    const before = await b.balanceOf(alice.address);
    await asUser(dex, alice).addLiquidity(
      1,
      E("100"),
      E("250"),
      E("99"),
      E("99"),
      MAX,
    );
    expect(await dex.ownerOf(2)).to.equal(alice.address);
    expect(before - (await b.balanceOf(alice.address))).to.equal(E("100"));
    const position = await dex.positions(2);
    expect(position.shares).to.equal(E("100"));
    expect(position.provider).to.equal(alice.address);
    const uri = await dex.tokenURI(2);
    const metadata = JSON.parse(
      Buffer.from(uri.split(",")[1], "base64").toString(),
    );
    expect(metadata.attributes[0].value).to.equal(1);
    expect(await a.balanceOf(dex.target)).to.equal(
      (await dex.pools(1)).reserveA,
    );
  });
  it("charges 0.3%, pays the quote, and increases k", async function () {
    const { dex, a, b, alice } = await networkHelpers.loadFixture(fixture);
    const p = await dex.pools(1);
    const expected =
      (E("10") * 9970n * p.reserveB) / (p.reserveA * 10000n + E("10") * 9970n);
    expect(await dex.getAmountOut(1, a.target, E("10"))).to.equal(expected);
    const before = await b.balanceOf(alice.address);
    await asUser(dex, alice).swap(1, a.target, E("10"), expected, MAX);
    expect((await b.balanceOf(alice.address)) - before).to.equal(expected);
    const after = await dex.pools(1);
    expect(after.reserveA * after.reserveB).to.be.greaterThan(
      p.reserveA * p.reserveB,
    );
  });
  it("redeems a transferred NFT only for its current owner, then burns it", async function () {
    const { dex, a, b, owner, alice, bob } =
      await networkHelpers.loadFixture(fixture);
    await asUser(dex, alice).addLiquidity(1, E("100"), E("100"), 0, 0, MAX);
    await asUser(dex, bob).swap(1, a.target, E("100"), 0, MAX);
    await asUser(dex, bob).swap(1, b.target, E("100"), 0, MAX);
    const [outA, outB] = await dex.previewRemove(2);
    expect(outA * outB).to.be.greaterThan(E("100") ** 2n);
    await asUser(dex, alice).transferFrom(alice.address, bob.address, 2);
    await expect(
      asUser(dex, alice).removeLiquidity(2, 0, 0, MAX),
    ).to.be.revertedWith("Not position owner");
    const before = await a.balanceOf(bob.address);
    await asUser(dex, bob).removeLiquidity(2, outA, outB, MAX);
    expect((await a.balanceOf(bob.address)) - before).to.equal(outA);
    await expect(dex.ownerOf(2)).to.be.revertedWithCustomError(
      dex,
      "ERC721NonexistentToken",
    );
    await expect(asUser(dex, owner).removeLiquidity(2, 0, 0, MAX)).to.revert(
      ethers,
    );
  });
  it("rejects expired calls, impossible slippage and zero-sized liquidity", async function () {
    const { dex, a } = await networkHelpers.loadFixture(fixture);
    await expect(dex.swap(1, a.target, E("1"), 0, 1)).to.be.revertedWith(
      "Expired",
    );
    await expect(dex.swap(1, a.target, E("1"), E("2"), MAX)).to.be.revertedWith(
      "Swap slippage",
    );
    await expect(dex.addLiquidity(1, 0, 0, 0, 0, MAX)).to.be.revertedWith(
      "Zero liquidity",
    );
    await expect(
      dex.addLiquidity(1, E("1"), E("2"), 0, E("2"), MAX),
    ).to.be.revertedWith("Liquidity slippage");
    await expect(dex.removeLiquidity(1, MAX, 0, MAX)).to.be.revertedWith(
      "Liquidity slippage",
    );
  });
  it("keeps multiple pools accounted separately", async function () {
    const { dex, a, b } = await networkHelpers.loadFixture(fixture);
    const c = await ethers.deployContract("TestToken", ["C", "C"]);
    await c.faucet();
    await c.approve(dex.target, MAX);
    await dex.createPool(a.target, c.target);
    await dex.addLiquidity(2, E("100"), E("100"), 0, 0, MAX);
    const original = await dex.pools(1);
    await dex.swap(2, a.target, E("5"), 0, MAX);
    expect((await dex.pools(1)).reserveA).to.equal(original.reserveA);
    expect(await b.balanceOf(dex.target)).to.equal(original.reserveB);
  });
  it("executes profitable two-DEX arbitrage in one transaction", async function () {
    const { dex, other, arb, a, b, alice } =
      await networkHelpers.loadFixture(fixture);
    await other.swap(1, b.target, E("400"), 0, MAX);
    const balance = await b.balanceOf(alice.address);
    const tx = await asUser(arb, alice).execute(
      dex.target,
      1,
      other.target,
      1,
      b.target,
      E("50"),
      E("1"),
      MAX,
    );
    await expect(tx).to.emit(arb, "Arbitrage");
    expect(await b.balanceOf(alice.address)).to.be.greaterThan(
      balance + E("1"),
    );
    expect(await a.balanceOf(arb.target)).to.equal(0);
    expect(await b.balanceOf(arb.target)).to.equal(0);
  });
  it("rolls back BOTH swaps and user balances when profit requirement fails", async function () {
    const { dex, other, arb, a, b, alice } =
      await networkHelpers.loadFixture(fixture);
    const before = [await dex.pools(1), await other.pools(1)];
    const balances = [
      await a.balanceOf(alice.address),
      await b.balanceOf(alice.address),
    ];
    await expect(
      asUser(arb, alice).execute(
        dex.target,
        1,
        other.target,
        1,
        a.target,
        E("50"),
        0,
        MAX,
      ),
    ).to.revert(ethers);
    expect(await dex.pools(1)).to.deep.equal(before[0]);
    expect(await other.pools(1)).to.deep.equal(before[1]);
    expect(await a.balanceOf(alice.address)).to.equal(balances[0]);
    expect(await b.balanceOf(alice.address)).to.equal(balances[1]);
    expect(await a.balanceOf(arb.target)).to.equal(0);
  });
});
