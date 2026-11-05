import { useCallback, useEffect, useRef, useState } from "react";
import {
  BrowserProvider,
  Contract,
  JsonRpcProvider,
  MaxUint256,
  formatEther,
  parseEther,
  type Eip1193Provider,
  type Signer,
} from "ethers";
import deployment from "./generated/deployment.json";
import dexAbi from "./generated/MiniDEX.json";
import tokenAbi from "./generated/TestToken.json";
import arbAbi from "./generated/AtomicArbitrage.json";
import "./App.css";

declare global {
  interface Window {
    ethereum?: Eip1193Provider;
  }
}
type Pool = {
  id: number;
  tokenA: string;
  tokenB: string;
  reserveA: bigint;
  reserveB: bigint;
  totalShares: bigint;
};
type Position = {
  id: number;
  poolId: number;
  shares: bigint;
  depositedA: bigint;
  depositedB: bigint;
  createdTimestamp: bigint;
  provider: string;
  owner: string;
  outA: bigint;
  outB: bigint;
};
type Route = {
  buy: number;
  sell: number;
  token: string;
  amount: bigint;
  profit: bigint;
};
type ArbReport = {
  generatedAt: string;
  tx: string;
  token: string;
  amountIn: string;
  profit: string;
  before: { priceBperA: number; reserveA: string; reserveB: string }[];
  after: { priceBperA: number; reserveA: string; reserveB: string }[];
};
type SimReport = {
  users: string[];
  counts: { swap: number; add: number; remove: number };
  generatedAt: string;
};
const rpc = new JsonRpcProvider(deployment.rpcUrl, undefined, {
  cacheTimeout: 0,
});
const dexAt = (i: number, runner: Signer | JsonRpcProvider = rpc) =>
  new Contract(deployment.exchanges[i].address, dexAbi, runner);
const tokenAt = (address: string, runner: Signer | JsonRpcProvider = rpc) =>
  new Contract(address, tokenAbi, runner);
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const symbol = (address: string) =>
  deployment.tokens.find((t) => same(t.address, address))?.symbol ??
  `${address.slice(0, 6)}…${address.slice(-4)}`;
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const fmt = (v: bigint, digits = 4) =>
  Number(formatEther(v)).toLocaleString("en-US", {
    maximumFractionDigits: digits,
  });
const deadline = () => BigInt(Math.floor(Date.now() / 1000) + 1200);
const readable = (e: unknown) => {
  const x = e as { reason?: string; shortMessage?: string; message?: string };
  return x.reason || x.shortMessage || x.message || String(e);
};

function App() {
  const [exchange, setExchange] = useState(0);
  const [pools, setPools] = useState<Pool[]>([]);
  const [poolId, setPoolId] = useState(1);
  const [positions, setPositions] = useState<Position[]>([]);
  const [address, setAddress] = useState("");
  const [mode, setMode] = useState<"local" | "wallet">("local");
  const [accounts, setAccounts] = useState<string[]>([]);
  const [balances, setBalances] = useState<Record<string, bigint>>({});
  const [tab, setTab] = useState("swap");
  const [input, setInput] = useState("10");
  const [reverse, setReverse] = useState(false);
  const [quote, setQuote] = useState<bigint | null>(null);
  const [amountA, setAmountA] = useState("100");
  const [amountB, setAmountB] = useState("100");
  const [slippage, setSlippage] = useState("1");
  const [customA, setCustomA] = useState(deployment.tokens[0].address);
  const [customB, setCustomB] = useState(deployment.tokens[1].address);
  const [tokenDecimals, setTokenDecimals] = useState<Record<string, number>>(
    {},
  );
  const [status, setStatus] = useState("正在连接本地链…");
  const [online, setOnline] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [txs, setTxs] = useState<{ label: string; hash: string }[]>([]);
  const [route, setRoute] = useState<Route | null>(null);
  const [arbReport, setArbReport] = useState<ArbReport | null>(null);
  const [simulation, setSimulation] = useState<SimReport | null>(null);
  const [prices, setPrices] = useState<number[]>([]);
  const generation = useRef(0);
  const pool = pools.find((p) => p.id === poolId);
  // Teaching tokens use 18 decimals; unknown tokens are checked before enabling actions.
  const supported =
    !!pool && [pool.tokenA, pool.tokenB].every((t) => tokenDecimals[t] === 18);
  const inputToken = pool ? (reverse ? pool.tokenB : pool.tokenA) : "";
  const outputToken = pool ? (reverse ? pool.tokenA : pool.tokenB) : "";
  const tolerance = () => {
    const n = Number(slippage);
    if (!Number.isFinite(n) || n < 0.1 || n > 10)
      throw new Error("滑点应在 0.1%–10% 之间");
    return BigInt(Math.round(n * 100));
  };
  const minimum = (value: bigint) => (value * (10000n - tolerance())) / 10000n;

  const refresh = useCallback(async () => {
    const g = ++generation.current;
    try {
      const code = await rpc.getCode(deployment.exchanges[exchange].address);
      if (code === "0x")
        throw new Error("未找到合约，请运行 npm run deploy 后刷新页面");
      const dex = dexAt(exchange);
      const count = Number(await dex.poolCount());
      const next = await Promise.all(
        Array.from({ length: count }, async (_, i) => {
          const p = await dex.pools(i + 1);
          return {
            id: i + 1,
            tokenA: p.tokenA,
            tokenB: p.tokenB,
            reserveA: p.reserveA,
            reserveB: p.reserveB,
            totalShares: p.totalShares,
          } as Pool;
        }),
      );
      const decimals: Record<string, number> = {};
      await Promise.all(
        [...new Set(next.flatMap((p) => [p.tokenA, p.tokenB]))].map(
          async (t) => {
            try {
              decimals[t] = Number(await tokenAt(t).decimals());
            } catch {
              decimals[t] = -1;
            }
          },
        ),
      );
      const n = Number(await dex.positionCount());
      const nextPositions = (
        await Promise.all(
          Array.from({ length: n }, async (_, i) => {
            let owner: string;
            try {
              owner = await dex.ownerOf(i + 1);
            } catch {
              return null;
            }
            const [p, out] = await Promise.all([
              dex.positions(i + 1),
              dex.previewRemove(i + 1),
            ]);
            return {
              id: i + 1,
              poolId: Number(p.poolId),
              shares: p.shares,
              depositedA: p.depositedA,
              depositedB: p.depositedB,
              createdTimestamp: p.createdTimestamp,
              provider: p.provider,
              owner,
              outA: out[0],
              outB: out[1],
            } as Position;
          }),
        )
      ).filter((p): p is Position => p !== null);
      const localAccounts = (await rpc.send("eth_accounts", [])) as string[];
      const nextBalances: Record<string, bigint> = {};
      if (address)
        await Promise.all(
          [
            ...new Set([
              ...deployment.tokens.map((t) => t.address),
              ...next.flatMap((p) => [p.tokenA, p.tokenB]),
            ]),
          ].map(async (t) => {
            nextBalances[t] = await tokenAt(t).balanceOf(address);
          }),
        );
      const nextPrices = await Promise.all(
        deployment.exchanges.map(async (_, i) => {
          const p = await dexAt(i).pools(1);
          return p.reserveA > 0n
            ? Number(formatEther(p.reserveB)) / Number(formatEther(p.reserveA))
            : 0;
        }),
      );
      if (g !== generation.current) return;
      setPools(next);
      setPositions(nextPositions);
      setTokenDecimals(decimals);
      setAccounts(localAccounts);
      setBalances(nextBalances);
      setPrices(nextPrices);
      setOnline(true);
      setStatus(`已连接 · 区块 ${await rpc.getBlockNumber()}`);
    } catch (e) {
      if (g === generation.current) {
        setOnline(false);
        setStatus(readable(e));
      }
    }
  }, [exchange, address]);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 12000);
    return () => {
      clearInterval(timer);
      generation.current++;
    };
  }, [refresh]);
  useEffect(() => {
    setRoute(null);
    setQuote(null);
  }, [exchange, poolId, address]);
  useEffect(() => {
    let active = true;
    setQuote(null);
    if (pool && inputToken && supported) {
      try {
        const amount = parseEther(input);
        if (amount > 0n)
          void dexAt(exchange)
            .getAmountOut(pool.id, inputToken, amount)
            .then((q) => {
              if (active) setQuote(q);
            })
            .catch(() => {});
      } catch {}
    }
    return () => {
      active = false;
    };
  }, [exchange, pool, inputToken, input, supported]);
  const loadReports = useCallback(async () => {
    for (const path of ["arbitrage", "simulation"] as const) {
      try {
        const res = await fetch(`/${path}-report.json`, { cache: "no-store" });
        if (res.ok) {
          const value = await res.json();
          if (path === "arbitrage") {
            setArbReport((current) =>
              current &&
              Date.parse(current.generatedAt) > Date.parse(value.generatedAt)
                ? current
                : value,
            );
          } else {
            setSimulation(value);
          }
        }
      } catch {
        /* Reports are optional until scripts run. */
      }
    }
  }, []);
  useEffect(() => {
    void loadReports();
  }, [loadReports]);

  async function signer() {
    if (!address) throw new Error("请先选择本地教学账户或连接钱包");
    if (mode === "local") return rpc.getSigner(address);
    if (!window.ethereum) throw new Error("未检测到钱包扩展");
    const provider = new BrowserProvider(window.ethereum);
    if (Number((await provider.getNetwork()).chainId) !== deployment.chainId)
      throw new Error("钱包网络不匹配，请重新连接本地网络");
    const s = await provider.getSigner();
    if (!same(await s.getAddress(), address))
      throw new Error("钱包账户已切换，请重新连接");
    return s;
  }
  async function run(label: string, action: () => Promise<void>) {
    setBusy(label);
    setError("");
    try {
      await action();
      await refresh();
    } catch (e) {
      setError(readable(e));
    } finally {
      setBusy("");
    }
  }
  async function send(
    label: string,
    promise: Promise<{ hash: string; wait: () => Promise<unknown> }>,
  ) {
    const tx = await promise;
    setTxs((t) => [{ label, hash: tx.hash }, ...t].slice(0, 12));
    await tx.wait();
  }
  async function approve(
    token: string,
    spender: string,
    amount: bigint,
    s: Signer,
  ) {
    const c = tokenAt(token, s);
    if ((await c.allowance(await s.getAddress(), spender)) < amount)
      await send(`授权 ${symbol(token)}`, c.approve(spender, amount));
  }
  async function connect() {
    await run("连接钱包", async () => {
      if (!window.ethereum)
        throw new Error("未检测到钱包扩展；也可以选择本地教学账户");
      const chain = `0x${deployment.chainId.toString(16)}`;
      try {
        await window.ethereum.request({
          method: "wallet_switchEthereumChain",
          params: [{ chainId: chain }],
        });
      } catch (e) {
        if ((e as { code: number }).code !== 4902) throw e;
        await window.ethereum.request({
          method: "wallet_addEthereumChain",
          params: [
            {
              chainId: chain,
              chainName: "Campus AMM Local",
              rpcUrls: [deployment.rpcUrl],
              nativeCurrency: {
                name: "Test Ether",
                symbol: "ETH",
                decimals: 18,
              },
            },
          ],
        });
        await window.ethereum.request({
          method: "wallet_switchEthereumChain",
          params: [{ chainId: chain }],
        });
      }
      const p = new BrowserProvider(window.ethereum);
      await p.send("eth_requestAccounts", []);
      setAddress(await (await p.getSigner()).getAddress());
      setMode("wallet");
    });
  }
  async function swap() {
    await run("兑换中", async () => {
      if (!pool || !supported) throw new Error("请选择支持的交易池");
      const s = await signer();
      const amount = parseEther(input);
      const d = dexAt(exchange, s);
      const out = await d.getAmountOut(pool.id, inputToken, amount);
      await approve(inputToken, String(d.target), amount, s);
      await send(
        "代币兑换",
        d.swap(pool.id, inputToken, amount, minimum(out), deadline()),
      );
    });
  }
  function liquidityAmounts() {
    if (!pool) throw new Error("请选择交易池");
    let a = parseEther(amountA),
      b = parseEther(amountB);
    if (pool.totalShares > 0n) {
      const optimal = (a * pool.reserveB) / pool.reserveA;
      if (optimal <= b) b = optimal;
      else a = (b * pool.reserveA) / pool.reserveB;
    }
    if (a <= 0n || b <= 0n) throw new Error("请输入大于零的流动性金额");
    return [a, b];
  }
  async function add() {
    await run("添加流动性", async () => {
      if (!pool || !supported)
        throw new Error("前端当前支持 18 位小数的普通 ERC20");
      const s = await signer();
      const d = dexAt(exchange, s);
      const [a, b] = liquidityAmounts();
      await approve(pool.tokenA, String(d.target), a, s);
      await approve(pool.tokenB, String(d.target), b, s);
      await send(
        "添加流动性 / 铸造 NFT",
        d.addLiquidity(pool.id, a, b, minimum(a), minimum(b), deadline()),
      );
    });
  }
  async function remove(position: Position) {
    await run(`赎回 NFT #${position.id}`, async () => {
      const s = await signer();
      const d = dexAt(exchange, s);
      const out = await d.previewRemove(position.id);
      await send(
        `销毁 NFT #${position.id} / 赎回`,
        d.removeLiquidity(
          position.id,
          minimum(out[0]),
          minimum(out[1]),
          deadline(),
        ),
      );
    });
  }
  async function detect() {
    await run("搜索套利机会", async () => {
      let best: Route | null = null;
      const p = await dexAt(0).pools(1);
      for (const [buy, sell] of [
        [0, 1],
        [1, 0],
      ])
        for (const token of [p.tokenA, p.tokenB])
          for (const size of [1, 5, 10, 25, 50, 100, 200]) {
            const amount = parseEther(String(size));
            const mid = await dexAt(buy).getAmountOut(1, token, amount);
            const out = await dexAt(sell).getAmountOut(
              1,
              same(token, p.tokenA) ? p.tokenB : p.tokenA,
              mid,
            );
            const profit = out - amount;
            if (profit > 0n && (!best || profit > best.profit))
              best = { buy, sell, token, amount, profit };
          }
      setRoute(best);
      if (!best)
        throw new Error(
          "当前搜索金额内没有正收益机会。可先在一个交易所交易，形成价差后重试。",
        );
    });
  }
  async function arbitrage() {
    await run("执行原子套利", async () => {
      if (!route) throw new Error("请先搜索套利机会");
      const s = await signer();
      const a = new Contract(deployment.arbitrage, arbAbi, s);
      await approve(route.token, deployment.arbitrage, route.amount, s);
      const snapshots = async () =>
        Promise.all(
          [0, 1].map(async (i) => {
            const p = await dexAt(i).pools(1);
            return {
              reserveA: String(p.reserveA),
              reserveB: String(p.reserveB),
              priceBperA:
                Number(formatEther(p.reserveB)) /
                Number(formatEther(p.reserveA)),
            };
          }),
        );
      const before = await snapshots();
      const balance = await tokenAt(route.token).balanceOf(address);
      const tx = await a.execute(
        deployment.exchanges[route.buy].address,
        1,
        deployment.exchanges[route.sell].address,
        1,
        route.token,
        route.amount,
        minimum(route.profit),
        deadline(),
      );
      await send("原子套利", Promise.resolve(tx));
      setArbReport({
        generatedAt: new Date().toISOString(),
        tx: tx.hash,
        token: route.token,
        amountIn: String(route.amount),
        profit: String(
          (await tokenAt(route.token).balanceOf(address)) - balance,
        ),
        before,
        after: await snapshots(),
      });
      setRoute(null);
    });
  }
  let usedLiquidity = "输入两种代币的最大投入量，系统按池比例取用";
  try {
    if (pool && supported) {
      const [a, b] = liquidityAmounts();
      usedLiquidity = `预计使用 ${fmt(a)} ${symbol(pool.tokenA)} + ${fmt(b)} ${symbol(pool.tokenB)}`;
    }
  } catch {}
  const own = positions.filter((p) => same(p.owner, address));
  const disabled = !!busy || !online || !address;

  return (
    <div className="shell">
      <header>
        <a className="brand" href="#">
          <span className="brand-icon">≈</span>
          <span>
            Campus AMM<span className="brand-sub">链上交易实验室</span>
          </span>
        </a>
        <div className="network">
          <i className={online ? "online" : ""} />
          {online ? "Local · " + deployment.chainId : "本地链未连接"}
        </div>
        <button onClick={connect} disabled={!!busy}>
          连接钱包 ↗
        </button>
      </header>
      <main>
        <div className="intro">
          <div>
            <p className="eyebrow">ZJU BLOCKCHAIN · DAPP LAB</p>
            <h1>
              让每一笔交易
              <br />
              <span>在链上发生。</span>
            </h1>
            <p className="intro-copy">
              交换代币，提供流动性，观察两个市场之间的价格变化。
            </p>
          </div>
          <div className="account-panel">
            <label htmlFor="account">本地教学账户</label>
            <select
              id="account"
              value={mode === "local" ? address : ""}
              onChange={(e) => {
                setMode("local");
                setAddress(e.target.value);
              }}
              disabled={!!busy}
            >
              <option value="">选择账户开始操作</option>
              {accounts.map((a, i) => (
                <option value={a} key={a}>
                  账户 {i + 1} · {short(a)}
                </option>
              ))}
            </select>
            <small>
              仅用于本机解锁的测试账户，不需要私钥。钱包模式：
              {mode === "wallet" ? short(address) : "未连接"}
            </small>
            <div className="balance-row">
              {deployment.tokens.map((t) => (
                <span key={t.address}>
                  <b>{fmt(balances[t.address] ?? 0n, 2)}</b> {t.symbol}
                </span>
              ))}
            </div>
            <button
              className="text-button"
              disabled={disabled}
              onClick={() =>
                run("领取测试币", async () => {
                  const s = await signer();
                  for (const t of deployment.tokens)
                    await send(
                      `领取 ${t.symbol}`,
                      tokenAt(t.address, s).faucet(),
                    );
                })
              }
            >
              领取 ALPHA + BETA 测试币 ↗
            </button>
          </div>
        </div>
        <div className="status-bar">
          <span role="status">{busy || status}</span>
          <button
            className="text-button"
            onClick={() => {
              void refresh();
              void loadReports();
            }}
            disabled={!!busy}
          >
            刷新数据 ↻
          </button>
        </div>
        {error && (
          <div className="error" role="alert">
            {error}
            <button aria-label="关闭错误" onClick={() => setError("")}>
              ×
            </button>
          </div>
        )}
        <div className="workspace">
          <aside className="market-panel">
            <p className="eyebrow">交易市场</p>
            <div className="exchanges">
              {deployment.exchanges.map((d, i) => (
                <button
                  className={exchange === i ? "selected" : ""}
                  key={d.address}
                  disabled={!!busy}
                  onClick={() => {
                    setExchange(i);
                    setPoolId(1);
                  }}
                >
                  {d.name}
                  <span>DEX {i + 1}</span>
                </button>
              ))}
            </div>
            <label htmlFor="pool">交易池</label>
            <select
              id="pool"
              value={poolId}
              disabled={!!busy}
              onChange={(e) => {
                setPoolId(Number(e.target.value));
                setReverse(false);
              }}
            >
              {pools.map((p) => (
                <option key={p.id} value={p.id}>
                  #{p.id} {symbol(p.tokenA)} / {symbol(p.tokenB)}
                </option>
              ))}
            </select>
            <div className="pool-stats">
              <div>
                <span>交易手续费</span>
                <b>0.30%</b>
              </div>
              <div>
                <span>分配方式</span>
                <b>按份额计入池储备</b>
              </div>
              <div>
                <span>活跃流动性凭证</span>
                <b>
                  {positions.filter((p) => p.poolId === poolId).length} NFTs
                </b>
              </div>
            </div>
            <details>
              <summary>合约与账户信息</summary>
              <p>
                交易所：<code>{deployment.exchanges[exchange].address}</code>
              </p>
              <p>
                套利：<code>{deployment.arbitrage}</code>
              </p>
              <p>
                账户：<code>{address || "尚未选择"}</code>
              </p>
            </details>
          </aside>
          <section className="trade-panel">
            <nav className="tabs" aria-label="交易操作">
              {[
                ["swap", "兑换"],
                ["liquidity", "流动性"],
                ["create", "创建池"],
              ].map(([key, label]) => (
                <button
                  key={key}
                  className={tab === key ? "active" : ""}
                  onClick={() => setTab(key)}
                >
                  {label}
                </button>
              ))}
            </nav>
            {tab === "swap" && (
              <>
                <h2>代币兑换</h2>
                <div className="amount-box">
                  <label htmlFor="swap-input">
                    支付 · {symbol(inputToken)}
                  </label>
                  <div>
                    <input
                      id="swap-input"
                      inputMode="decimal"
                      value={input}
                      onChange={(e) => setInput(e.target.value)}
                    />
                    <b>{symbol(inputToken)}</b>
                  </div>
                  <small>余额 {fmt(balances[inputToken] ?? 0n)}</small>
                </div>
                <button
                  className="reverse"
                  aria-label="切换兑换方向"
                  disabled={!!busy}
                  onClick={() => setReverse((v) => !v)}
                >
                  ↓↑
                </button>
                <div className="amount-box output">
                  <span>预计收到</span>
                  <div>
                    <strong>{quote !== null ? fmt(quote, 6) : "—"}</strong>
                    <b>{symbol(outputToken)}</b>
                  </div>
                  <small>报价已包含 0.30% 手续费</small>
                </div>
                <div className="slippage">
                  <label htmlFor="slippage">滑点容忍度</label>
                  <div>
                    <input
                      id="slippage"
                      type="number"
                      min="0.1"
                      max="10"
                      step="0.1"
                      value={slippage}
                      onChange={(e) => setSlippage(e.target.value)}
                    />{" "}
                    %
                  </div>
                </div>
                <button
                  className="primary"
                  disabled={disabled || !quote || !supported}
                  onClick={swap}
                >
                  {!address ? "先选择账户或连接钱包" : "确认兑换"}
                </button>
              </>
            )}
            {tab === "liquidity" && (
              <>
                <h2>提供流动性</h2>
                <p className="muted">
                  每次添加都铸造一个 ERC721
                  NFT。销毁凭证时按份额取回当前储备，包含期间累积的手续费。
                </p>
                <label className="field">
                  {pool ? symbol(pool.tokenA) : "Token A"} 最大投入
                  <input
                    inputMode="decimal"
                    value={amountA}
                    onChange={(e) => setAmountA(e.target.value)}
                  />
                </label>
                <label className="field">
                  {pool ? symbol(pool.tokenB) : "Token B"} 最大投入
                  <input
                    inputMode="decimal"
                    value={amountB}
                    onChange={(e) => setAmountB(e.target.value)}
                  />
                </label>
                <p className="hint">{usedLiquidity}</p>
                <button
                  className="primary"
                  disabled={disabled || !supported}
                  onClick={add}
                >
                  添加流动性并领取 NFT
                </button>
                <p className="hint">
                  滑点 {slippage}
                  %，可在「兑换」中调整。赎回包含价格变化，不能将赎回额减去投入额直接当作手续费收入。
                </p>
              </>
            )}
            {tab === "create" && (
              <>
                <h2>创建交易池</h2>
                <p className="muted">
                  输入两种 ERC20 合约地址。创建后添加首笔流动性，即可开始兑换。
                </p>
                <label className="field">
                  代币地址一
                  <input
                    value={customA}
                    onChange={(e) => setCustomA(e.target.value)}
                  />
                </label>
                <label className="field">
                  代币地址二
                  <input
                    value={customB}
                    onChange={(e) => setCustomB(e.target.value)}
                  />
                </label>
                <p className="hint">
                  同一交易所内，同一代币对只能创建一个池。合约按地址排序；本前端支持
                  18 位小数的普通 ERC20。
                </p>
                <button
                  className="primary"
                  disabled={disabled}
                  onClick={() =>
                    run("创建交易池", async () => {
                      const s = await signer();
                      const d = dexAt(exchange, s);
                      for (const token of [customA, customB]) {
                        if (Number(await tokenAt(token).decimals()) !== 18)
                          throw new Error(
                            "本前端目前只支持 18 位小数的普通 ERC20",
                          );
                      }
                      await send("创建池", d.createPool(customA, customB));
                      setPoolId(Number(await d.poolCount()));
                      setTab("liquidity");
                    })
                  }
                >
                  创建池
                </button>
              </>
            )}
            {pool && !supported && (
              <p className="hint">当前池代币小数位不受前端支持，操作已禁用。</p>
            )}
          </section>
          <section className="reserve-panel">
            <p className="eyebrow">池中储备 · LIVE</p>
            <h2>流动性水位</h2>
            <div className="reservoirs">
              {pool &&
                [
                  [pool.tokenA, pool.reserveA],
                  [pool.tokenB, pool.reserveB],
                ].map(([token, amount], i) => (
                  <div className="reservoir" key={String(token)}>
                    <div
                      className={`water water-${i}`}
                      style={{
                        height: `${Math.max(8, Math.min(90, 50 + Math.log2(Math.max(Number(formatEther(amount as bigint)), 0.001) / 2000) * 12))}%`,
                      }}
                    />
                    <div className="water-label">
                      <b>{fmt(amount as bigint, 2)}</b>
                      <span>{symbol(String(token))}</span>
                    </div>
                  </div>
                ))}
            </div>
            <p className="hint">
              水位以初始 2,000 枚为参照；数值来自合约储备。
            </p>
            <div className="price">
              {pool && pool.reserveA > 0n ? (
                <>
                  1 {symbol(pool.tokenA)}
                  <strong>
                    {(
                      Number(formatEther(pool.reserveB)) /
                      Number(formatEther(pool.reserveA))
                    ).toFixed(6)}{" "}
                    {symbol(pool.tokenB)}
                  </strong>
                </>
              ) : (
                "添加流动性后显示价格"
              )}
            </div>
            <small>
              恒定乘积 x × y = k<br />
              手续费使交易后的 k 逐步增长。
            </small>
          </section>
        </div>
        <section className="positions-section">
          <div className="section-heading">
            <div>
              <p className="eyebrow">LIQUIDITY POSITIONS</p>
              <h2>
                我的流动性凭证 <span>{own.length}</span>
              </h2>
            </div>
            <span className="muted">
              {deployment.exchanges[exchange].name} · 当前账户
            </span>
          </div>
          {own.length === 0 ? (
            <p className="empty">
              选择账户并添加流动性后，在这里查看 NFT 和可赎回资产。
            </p>
          ) : (
            <div className="position-grid">
              {own.map((p) => {
                const po = pools.find((x) => x.id === p.poolId);
                return (
                  <article className="position" key={p.id}>
                    <div className="position-top">
                      <b>MDLP #{p.id}</b>
                      <span>池 #{p.poolId}</span>
                    </div>
                    <p>
                      {po ? `${symbol(po.tokenA)} / ${symbol(po.tokenB)}` : "—"}
                    </p>
                    <div className="position-values">
                      可赎回
                      <strong>
                        {fmt(p.outA)} {po && symbol(po.tokenA)}
                        <br />
                        {fmt(p.outB)} {po && symbol(po.tokenB)}
                      </strong>
                    </div>
                    <small>
                      初始投入 {fmt(p.depositedA)} / {fmt(p.depositedB)}
                      <br />
                      份额 {fmt(p.shares)}
                      <br />
                      {new Date(
                        Number(p.createdTimestamp) * 1000,
                      ).toLocaleString("zh-CN")}
                    </small>
                    <button disabled={disabled} onClick={() => remove(p)}>
                      销毁 NFT 并赎回 ↗
                    </button>
                  </article>
                );
              })}
            </div>
          )}
          <details className="sources">
            <summary>
              查看该交易所的流动性来源（{positions.length} 个活跃 NFT）
            </summary>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>NFT / 池</th>
                    <th>最初提供者</th>
                    <th>当前持有人</th>
                    <th>初始投入 A / B</th>
                    <th>份额</th>
                    <th>添加时间</th>
                  </tr>
                </thead>
                <tbody>
                  {positions.map((p) => (
                    <tr key={p.id}>
                      <td>
                        #{p.id} / #{p.poolId}
                      </td>
                      <td title={p.provider}>{short(p.provider)}</td>
                      <td title={p.owner}>{short(p.owner)}</td>
                      <td>
                        {fmt(p.depositedA, 2)} / {fmt(p.depositedB, 2)}
                      </td>
                      <td>{fmt(p.shares, 2)}</td>
                      <td>
                        {new Date(
                          Number(p.createdTimestamp) * 1000,
                        ).toLocaleString("zh-CN")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </section>
        <section className="arbitrage-section">
          <div className="section-heading">
            <div>
              <p className="eyebrow">TWO MARKETS · ONE TRANSACTION</p>
              <h2>跨市场原子套利</h2>
            </div>
            <span className="pill">Bonus 实验</span>
          </div>
          <div className="arb-layout">
            <div>
              <p className="muted">
                比较两所 #1
                池的报价，寻找扣除两次交易手续费后的正收益路线。两次兑换在一笔交易中完成；利润不足时全部回滚。
              </p>
              <div className="market-prices">
                {prices.map((v, i) => (
                  <div key={i}>
                    <span>{deployment.exchanges[i].name}</span>
                    <strong>{v.toFixed(6)}</strong>
                    <small>Token B / Token A · 地址排序</small>
                  </div>
                ))}
              </div>
              <div className="button-row">
                <button disabled={!!busy || !online} onClick={detect}>
                  搜索套利机会
                </button>
                <button
                  disabled={disabled}
                  onClick={() =>
                    run("制造市场价差", async () => {
                      const s = await signer();
                      const d = dexAt(1, s);
                      const p = await d.pools(1);
                      const amount = parseEther("400");
                      await approve(p.tokenB, String(d.target), amount, s);
                      const q = await d.getAmountOut(1, p.tokenB, amount);
                      await send(
                        "Qiantang 单边交易",
                        d.swap(1, p.tokenB, amount, minimum(q), deadline()),
                      );
                      setRoute(null);
                    })
                  }
                >
                  在 Qiantang 交易 400 B
                </button>
              </div>
              {route && (
                <div className="route">
                  <b>
                    {deployment.exchanges[route.buy].name} →{" "}
                    {deployment.exchanges[route.sell].name}
                  </b>
                  <p>
                    本金 {fmt(route.amount)} {symbol(route.token)} · 预计利润{" "}
                    {fmt(route.profit, 6)} {symbol(route.token)}
                  </p>
                  <button
                    className="primary"
                    disabled={disabled}
                    onClick={arbitrage}
                  >
                    一笔交易执行套利
                  </button>
                </div>
              )}
              <small>
                使用账户自有测试币作为本金。收益扣除交易手续费，未扣除以 ETH
                支付的 Gas。搜索采用离散金额，不保证全局最优。
              </small>
            </div>
            <div className="arb-result">
              <h3>最近一次套利结果</h3>
              {arbReport ? (
                <>
                  <p className="profit">
                    +{fmt(BigInt(arbReport.profit), 6)}{" "}
                    <span>{symbol(arbReport.token)}</span>
                  </p>
                  <p>
                    投入 {fmt(BigInt(arbReport.amountIn))}{" "}
                    {symbol(arbReport.token)}
                  </p>
                  <div className="table-scroll">
                    <table>
                      <thead>
                        <tr>
                          <th>市场 / B 每 A</th>
                          <th>套利前</th>
                          <th>套利后</th>
                        </tr>
                      </thead>
                      <tbody>
                        {arbReport.before.map((p, i) => (
                          <tr key={i}>
                            <td>{deployment.exchanges[i].name}</td>
                            <td>{p.priceBperA.toFixed(5)}</td>
                            <td>{arbReport.after[i].priceBperA.toFixed(5)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <table>
                      <thead>
                        <tr>
                          <th>市场</th>
                          <th>储备 A 前 → 后</th>
                          <th>储备 B 前 → 后</th>
                        </tr>
                      </thead>
                      <tbody>
                        {arbReport.before.map((p, i) => (
                          <tr key={i}>
                            <td>{deployment.exchanges[i].name}</td>
                            <td>
                              {fmt(BigInt(p.reserveA), 2)} →{" "}
                              {fmt(BigInt(arbReport.after[i].reserveA), 2)}
                            </td>
                            <td>
                              {fmt(BigInt(p.reserveB), 2)} →{" "}
                              {fmt(BigInt(arbReport.after[i].reserveB), 2)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <code className="hash">{arbReport.tx}</code>
                  <small>
                    历史运行快照；重新部署本地链后请重新运行套利生成记录。
                  </small>
                </>
              ) : (
                <p className="empty">
                  执行套利，或运行 npm run arbitrage 后刷新数据。
                </p>
              )}
            </div>
          </div>
        </section>
        <section className="bottom-grid">
          <div className="simulation">
            <p className="eyebrow">MULTI-USER SIMULATION</p>
            <h2>多用户运行记录</h2>
            {simulation ? (
              <>
                <div className="sim-counts">
                  <div>
                    <strong>{simulation.users.length}</strong>
                    <span>参与地址</span>
                  </div>
                  {Object.entries(simulation.counts).map(([key, value]) => (
                    <div key={key}>
                      <strong>{value}</strong>
                      <span>
                        {
                          {
                            swap: "兑换",
                            add: "添加流动性",
                            remove: "撤回流动性",
                          }[key]
                        }
                      </span>
                    </div>
                  ))}
                </div>
                <small>
                  脚本快照 ·{" "}
                  {new Date(simulation.generatedAt).toLocaleString("zh-CN")}
                </small>
              </>
            ) : (
              <p className="empty">
                运行 npm run simulate 后，刷新查看 20 个账户的模拟结果。
              </p>
            )}
            <p>
              <a
                href="/simulation-report.json"
                target="_blank"
                rel="noreferrer"
              >
                查看完整模拟报告 ↗
              </a>
            </p>
          </div>
          <div>
            <p className="eyebrow">TRANSACTION LOG</p>
            <h2>本次页面交易</h2>
            {txs.length ? (
              <ul className="tx-list">
                {txs.map((t) => (
                  <li key={t.hash}>
                    <span>{t.label}</span>
                    <code title={t.hash}>{short(t.hash)}</code>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="empty">
                发送交易后显示交易哈希。成功状态以链上确认后的余额和储备为准。
              </p>
            )}
          </div>
        </section>
        <footer>
          Campus AMM · 区块链课程作业
          <span>本地测试网络 · 所有资产均为测试币</span>
        </footer>
      </main>
    </div>
  );
}
export default App;
