"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useParams } from "next/navigation";
import { useAccount, useWriteContract } from "wagmi";
import { parseUnits, zeroAddress } from "viem";
import { CountdownTimer } from "@/components/CountdownTimer";
import { SPOT_POOL_ABI, crossingPrice, ORDER_TYPE, OPERATOR_REGISTRY_ADDRESS, OPERATOR_REGISTRY_ABI, SELECTORS, OPERATOR_ADDRESS } from "@/lib/config";
import { MARKETS } from "@/lib/markets";

interface PledgeAsset {
  symbol: string;
  amount: number;
  usdValue: number;
}

interface Pledge {
  user: string;
  amount: number;
  assets: PledgeAsset[];
  status: string;
  txHash?: string;
}

interface ReceiptItem {
  user: string;
  status: string;
  txHash: string | null;
  errorMessage: string | null;
  executedAt: string | null;
}

interface Syndicate {
  batchId: string;
  status: "OPEN" | "PROCESSING" | "EXECUTED" | "FAILED";
  market: string;
  direction: string;
  creator: string;
  totalPool: number;
  participants: number;
  closesAt: string;
  timeRemainingMs: number;
  expired: boolean;
  pledges: Pledge[];
  receipt?: ReceiptItem[];
}

const EXPLORER = "https://shannon-explorer.somnia.network/tx/";

const cardStyle: React.CSSProperties = {
  background: "rgba(15, 23, 42, 0.6)",
  backdropFilter: "blur(20px)",
  border: "1px solid rgba(51, 65, 85, 0.5)",
  borderRadius: 20, padding: 32,
  boxShadow: "0 25px 60px rgba(0, 0, 0, 0.5), 0 0 40px rgba(6, 182, 212, 0.03)",
};

const inputStyle: React.CSSProperties = {
  width: "100%", padding: "12px 16px",
  background: "rgba(15, 23, 42, 0.5)",
  border: "1px solid rgba(51, 65, 85, 0.5)", borderRadius: 10,
  color: "#e2e8f0", fontSize: 16, outline: "none",
  boxSizing: "border-box" as const,
};

export default function SquadPage() {
  const { id } = useParams<{ id: string }>();
  const { address, isConnected } = useAccount();
  const { writeContractAsync } = useWriteContract();

  const [data, setData] = useState<Syndicate | null>(null);
  const [joinAmount, setJoinAmount] = useState<string>("100");
  const [joinBusy, setJoinBusy] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);
  const [joinSuccess, setJoinSuccess] = useState(false);

  const [selfExecBusy, setSelfExecBusy] = useState(false);
  const [selfExecError, setSelfExecError] = useState<string | null>(null);
  const [selfExecTxHash, setSelfExecTxHash] = useState<string | null>(null);
  const [selfExecDone, setSelfExecDone] = useState(false);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const processingStartedRef = useRef<number | null>(null);
  const [isDelayed, setIsDelayed] = useState(false);

  const [joinSelectedAssets, setJoinSelectedAssets] = useState<string[]>(["STT"]);
  const toggleJoinAsset = (sym: string) => {
    setJoinSelectedAssets((p) => p.includes(sym) ? p.filter((a) => a !== sym) : [...p, sym]);
  };

  const baseSymbol = data ? data.market.split(":")[0] : "";
  const baseDecimals = data ? (MARKETS[data.market]?.baseDecimals ?? 18) : 18;

  const fetchSyndicate = useCallback(async () => {
    try {
      const res = await fetch(`/api/syndicates/${id}`);
      if (!res.ok) return;
      const json: Syndicate = await res.json();
      setData(json);
      return json;
    } catch { return undefined; }
  }, [id]);

  useEffect(() => {
    fetchSyndicate();
    pollRef.current = setInterval(async () => {
      const latest = await fetchSyndicate();
      if (latest && latest.status !== "OPEN" && latest.status !== "PROCESSING") {
        if (pollRef.current) clearInterval(pollRef.current);
      }
    }, 1500);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [fetchSyndicate]);

  useEffect(() => {
    const processing = (data?.status === "OPEN" && data?.expired) || data?.status === "PROCESSING";
    if (processing && !processingStartedRef.current) processingStartedRef.current = Date.now();
    if (!processing) { processingStartedRef.current = null; setIsDelayed(false); return; }
    if (processingStartedRef.current && Date.now() - processingStartedRef.current > 120_000) setIsDelayed(true);
  }, [data]);

  const ensureDelegation = useCallback(async () => {
    if (!address || !data) return;
    const pool = MARKETS[data.market]?.pool;
    if (!pool) return;
    const res = await fetch(`/api/syndicates/check-delegation?pool=${pool}&owner=${address}`);
    const { authorized } = await res.json();
    if (authorized) return;
    await writeContractAsync({
      address: OPERATOR_REGISTRY_ADDRESS, abi: OPERATOR_REGISTRY_ABI,
      functionName: "setOperatorApprovalForPool",
      args: [pool, OPERATOR_ADDRESS, [SELECTORS.placeOrderFor, SELECTORS.cancelOrderFor], true],
    });
  }, [address, data, writeContractAsync]);

  const handleJoin = useCallback(async () => {
    if (!address || !data) return;
    setJoinError(null); setJoinBusy(true);
    try {
      await ensureDelegation();
      const res = await fetch("/api/syndicates/join", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          userAddress: address, batchId: data.batchId, amount: +joinAmount,
          assets: joinSelectedAssets.map((s) => ({ symbol: s, amount: +joinAmount / joinSelectedAssets.length })),
          dustSweep: false,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "join failed");
      setJoinSuccess(true);
    } catch (e: unknown) {
      setJoinError(e instanceof Error ? e.message : "unknown error");
    } finally { setJoinBusy(false); }
  }, [address, data, joinAmount, joinSelectedAssets, ensureDelegation]);

  const handleSelfExecute = useCallback(async () => {
    if (!address || !data) return;
    setSelfExecError(null); setSelfExecBusy(true);
    try {
      const mc = MARKETS[data.market];
      if (!mc) throw new Error("unknown market");
      const myPledge = data.pledges.find((p) => p.user.toLowerCase() === address.toLowerCase());
      const amount = myPledge?.amount ?? data.totalPool;
      if (amount <= 0) throw new Error("no pledge found for your address");
      const quantity = parseUnits(String(amount), mc.baseDecimals);
      const price = crossingPrice(data.direction as "BUY" | "SELL", mc.quoteDecimals);
      const expireNs = BigInt(Date.now() + 60_000) * 1_000_000n;
      const hash = await writeContractAsync({
        address: mc.pool, abi: SPOT_POOL_ABI, functionName: "placeOrderFor",
        args: [address, data.direction === "BUY", 0n, price, quantity, expireNs, ORDER_TYPE.IOC, 0, zeroAddress, 0n],
      });
      setSelfExecTxHash(hash); setSelfExecDone(true);
    } catch (e: unknown) {
      setSelfExecError(e instanceof Error ? e.message : "unknown error");
    } finally { setSelfExecBusy(false); }
  }, [address, data, writeContractAsync]);

  const shareX = () => {
    const url = `${window.location.origin}/squad/${id}`;
    const text = encodeURIComponent(`Join my ${data?.market} ${data?.direction} Syndicate on DreamSquad! ${url}`);
    window.open(`https://twitter.com/intent/tweet?text=${text}`, "_blank");
  };

  if (!data) {
    return (<main style={{ maxWidth: 520, margin: "0 auto", padding: "80px 24px", textAlign: "center" }}>
      <p style={{ color: "#64748b" }}>Loading syndicate...</p>
    </main>);
  }

  const isProcessing = (data.status === "OPEN" && data.expired) || data.status === "PROCESSING";
  const isDone = data.status === "EXECUTED" || data.status === "FAILED";

  if (isDone) {
    const allOk = data.status === "EXECUTED";
    const myFailed = address && data.receipt?.find(
      (r) => r.user.toLowerCase() === address.toLowerCase() && r.status === "FAILED",
    );
    const showSelfExec = !allOk && !selfExecDone && isConnected && myFailed;

    return (
      <main style={{ maxWidth: 520, margin: "0 auto", padding: "48px 24px" }}>
        <div style={cardStyle}>
          <h2 style={{
            fontSize: 24, fontWeight: 800, marginBottom: 6, letterSpacing: "-0.02em",
            background: allOk ? "linear-gradient(135deg, #10b981, #06b6d4)" : "linear-gradient(135deg, #f43f5e, #fb923c)",
            WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent",
          }}>
            {allOk ? "Syndicate Executed" : "Syndicate Failed"}
          </h2>
          <p style={{ fontSize: 13, color: "#64748b", marginBottom: 24 }}>
            {data.direction} {data.market} &mdash; {data.participants} participant{data.participants !== 1 ? "s" : ""}
          </p>

          {allOk && (
            <div style={{ marginBottom: 24 }}>
              {["Intents Collected", "Operator Signed", "DreamDEX Execution Complete"].map((step, i) => (
                <div key={step} style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 10, fontSize: 14 }}>
                  <span style={{
                    width: 24, height: 24, borderRadius: 12, display: "flex", alignItems: "center", justifyContent: "center",
                    background: "rgba(16, 185, 129, 0.15)", color: "#10b981", fontWeight: 700, fontSize: 13,
                  }}>{"\u2713"}</span>
                  <span style={{ color: "#e2e8f0" }}>{step}</span>
                </div>
              ))}
            </div>
          )}

          {data.receipt && data.receipt.length > 0 && (
            <div style={{ marginBottom: 24 }}>
              <h3 style={{ fontSize: 12, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 10, fontWeight: 600 }}>
                Trade Receipts
              </h3>
              {data.receipt.map((r, i) => (
                <div key={i} style={{
                  display: "flex", alignItems: "center", gap: 10, padding: "10px 12px",
                  background: "rgba(30, 41, 59, 0.4)", borderRadius: 10,
                  marginBottom: 6, fontSize: 13,
                }}>
                  <span style={{ fontFamily: "monospace", color: "#94a3b8", flex: 1 }}>{r.user}</span>
                  <span style={{
                    padding: "2px 10px", borderRadius: 6, fontSize: 11, fontWeight: 700,
                    color: r.status === "EXECUTED" ? "#10b981" : "#f43f5e",
                    background: r.status === "EXECUTED" ? "rgba(16,185,129,0.1)" : "rgba(244,63,94,0.1)",
                  }}>
                    {r.status}
                  </span>
                  {r.txHash && (
                    <a href={`${EXPLORER}${r.txHash}`} target="_blank" rel="noopener noreferrer"
                       style={{ color: "#06b6d4", fontSize: 12, textDecoration: "none" }}>
                      tx {"\u2197"}
                    </a>
                  )}
                </div>
              ))}
            </div>
          )}

          {showSelfExec && (
            <div style={{ marginBottom: 20 }}>
              <p style={{ fontSize: 13, color: "#94a3b8", marginBottom: 10 }}>
                Operator execution failed. Place the order directly from your wallet.
              </p>
              <button onClick={handleSelfExecute} disabled={selfExecBusy} style={{
                width: "100%", padding: "14px 0", border: "none", borderRadius: 12, fontWeight: 700, fontSize: 15,
                cursor: selfExecBusy ? "wait" : "pointer",
                background: selfExecBusy ? "rgba(51,65,85,0.5)" : "linear-gradient(135deg, #fb923c, #f43f5e)",
                color: selfExecBusy ? "#64748b" : "#fff",
                boxShadow: selfExecBusy ? "none" : "0 0 25px rgba(244, 63, 94, 0.3)",
                transition: "all 0.25s",
              }}>
                {selfExecBusy ? "Signing..." : "Self-Execute Order"}
              </button>
              {selfExecError && <p style={{ color: "#f43f5e", fontSize: 13, marginTop: 8 }}>{selfExecError}</p>}
              {selfExecTxHash && (
                <a href={`${EXPLORER}${selfExecTxHash}`} target="_blank" rel="noopener noreferrer"
                   style={{ display: "block", marginTop: 10, color: "#06b6d4", fontSize: 13, textAlign: "center", textDecoration: "none" }}>
                  View tx on Explorer {"\u2197"}
                </a>
              )}
            </div>
          )}

          {selfExecDone && (
            <div style={{
              marginBottom: 20, background: "rgba(16, 185, 129, 0.08)", borderRadius: 12, padding: 16,
              border: "1px solid rgba(16, 185, 129, 0.3)",
            }}>
              <p style={{ fontSize: 14, color: "#10b981", fontWeight: 700, margin: 0 }}>Order Submitted</p>
              <p style={{ fontSize: 13, color: "#64748b", marginTop: 4 }}>
                Your IOC market order was placed from your wallet.
              </p>
            </div>
          )}

          <button onClick={shareX} style={{
            width: "100%", padding: "12px 0", background: "rgba(30, 41, 59, 0.5)",
            border: "1px solid rgba(51, 65, 85, 0.5)", borderRadius: 10,
            color: "#94a3b8", fontWeight: 600, fontSize: 14, cursor: "pointer",
          }}>
            Share on X
          </button>
        </div>
      </main>
    );
  }

  if (isProcessing) {
    return (
      <main style={{ maxWidth: 520, margin: "0 auto", padding: "80px 24px" }}>
        <div style={cardStyle}>
          <h2 style={{
            fontSize: 24, fontWeight: 800, marginBottom: 12, letterSpacing: "-0.02em",
            background: "linear-gradient(135deg, #06b6d4, #10b981)",
            WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent",
          }}>
            Executing on DreamDEX...
          </h2>
          <p style={{ fontSize: 14, color: "#64748b", lineHeight: 1.6 }}>
            Backend operator is placing IOC market orders via delegation. This takes 5-15 seconds.
          </p>
          {isDelayed && (
            <div style={{
              marginTop: 16, padding: 14, borderRadius: 12,
              background: "rgba(251, 146, 60, 0.06)", border: "1px solid rgba(251, 146, 60, 0.2)",
            }}>
              <p style={{ fontSize: 13, color: "#fb923c", margin: 0, lineHeight: 1.5 }}>
                Batch processing slightly delayed. Verifying on-chain status...
              </p>
            </div>
          )}
          <div style={{ marginTop: 24, display: "flex", gap: 12 }}>
            {[1, 2, 3].map((i) => (
              <div key={i} style={{
                width: 8, height: 8, borderRadius: 4,
                background: "linear-gradient(135deg, #06b6d4, #10b981)",
                animation: `pulse 1s ${i * 0.3}s infinite`,
              }} />
            ))}
          </div>
          <style>{`@keyframes pulse { 0%,100%{opacity:0.2} 50%{opacity:1} }`}</style>
        </div>
      </main>
    );
  }

  return (
    <main style={{ maxWidth: 520, margin: "0 auto", padding: "48px 24px" }}>
      <div style={cardStyle}>
        <p style={{ fontSize: 13, color: "#64748b", marginBottom: 6 }}>
          {data.creator} started a {baseSymbol} {data.direction} Syndicate.
        </p>

        <h1 style={{
          fontSize: 36, fontWeight: 900, margin: "0 0 20px", letterSpacing: "-0.03em",
          background: data.direction === "BUY"
            ? "linear-gradient(135deg, #10b981, #06b6d4)"
            : "linear-gradient(135deg, #f43f5e, #fb923c)",
          WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent",
        }}>
          {data.direction} {baseSymbol}
        </h1>

        <div style={{ textAlign: "center", margin: "24px 0" }}>
          <CountdownTimer closesAt={data.closesAt} />
          <p style={{ fontSize: 12, color: "#64748b", marginTop: 6 }}>until lobby closes</p>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginBottom: 28 }}>
          {[
            { label: "Market", value: data.market },
            { label: "Total Pool", value: `${data.totalPool.toFixed(2)} ${baseSymbol}` },
            { label: "Participants", value: String(data.participants) },
          ].map((s) => (
            <div key={s.label} style={{
              background: "rgba(30, 41, 59, 0.4)", borderRadius: 12, padding: "14px 10px", textAlign: "center",
              border: "1px solid rgba(51, 65, 85, 0.3)",
            }}>
              <div style={{ fontSize: 11, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 600 }}>{s.label}</div>
              <div style={{ fontSize: 16, fontWeight: 700, marginTop: 6, color: "#e2e8f0" }}>{s.value}</div>
            </div>
          ))}
        </div>

        {data.pledges.length > 0 && (
          <div style={{ marginBottom: 28 }}>
            <h3 style={{ fontSize: 12, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 10, fontWeight: 600 }}>
              Pledges
            </h3>
            {data.pledges.map((p, i) => (
              <div key={i} style={{
                padding: "10px 12px",
                background: "rgba(30, 41, 59, 0.3)", borderRadius: 8, marginBottom: 4, fontSize: 13,
              }}>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ fontFamily: "monospace", color: "#94a3b8" }}>{p.user}</span>
                  <span style={{ fontWeight: 700, color: "#e2e8f0" }}>{p.amount} {baseSymbol}</span>
                </div>
                {p.assets && p.assets.length > 0 && (
                  <div style={{ display: "flex", gap: 6, marginTop: 4, flexWrap: "wrap" }}>
                    {p.assets.map((a, j) => (
                      <span key={j} style={{
                        fontSize: 11, padding: "2px 8px", borderRadius: 6,
                        background: "rgba(168, 85, 247, 0.1)", border: "1px solid rgba(147, 51, 234, 0.2)",
                        color: "#c084fc",
                      }}>
                        {a.amount.toFixed(2)} {a.symbol}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {isConnected && (
          <div style={{
            marginBottom: 20, padding: "12px 14px", borderRadius: 12,
            background: "rgba(251, 146, 60, 0.06)", border: "1px solid rgba(251, 146, 60, 0.2)",
          }}>
            <p style={{ fontSize: 12, color: "#fb923c", margin: 0, lineHeight: 1.5 }}>
              Ensure your vault has at least {MARKETS[data.market]?.minAmount ?? 1} {baseSymbol} deposited before the lobby closes.
            </p>
          </div>
        )}

        {isConnected ? (
          <div>
            <p style={{ fontSize: 12, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 8, fontWeight: 600 }}>
              Pledge Assets
            </p>
            <div style={{ display: "flex", gap: 6, marginBottom: 12, flexWrap: "wrap" }}>
              {["STT", "SOMI", "USDC", "WETH"].map((sym) => {
                const active = joinSelectedAssets.includes(sym);
                return (
                  <button key={sym} onClick={() => toggleJoinAsset(sym)} style={{
                    padding: "6px 14px", borderRadius: 14, fontSize: 12, fontWeight: 600, cursor: "pointer",
                    color: active ? "#a855f7" : "rgba(148,163,184,0.6)",
                    background: active ? "rgba(168,85,247,0.12)" : "rgba(30,41,59,0.5)",
                    border: active ? "1px solid rgba(147,51,234,0.5)" : "1px solid rgba(51,65,85,0.5)",
                    transition: "all 0.2s",
                  }}>
                    {sym}
                  </button>
                );
              })}
            </div>
            <input
              type="number" min={0} value={joinAmount}
              onChange={(e) => setJoinAmount(e.target.value)}
              placeholder={`Amount in ${baseSymbol}`}
              style={inputStyle}
            />
            <button onClick={handleJoin} disabled={joinBusy || joinSuccess} style={{
              width: "100%", marginTop: 14, padding: "14px 0", border: "none", borderRadius: 12,
              fontWeight: 700, fontSize: 15, cursor: joinBusy ? "wait" : "pointer",
              background: joinSuccess
                ? "linear-gradient(135deg, #10b981, #06b6d4)"
                : joinBusy ? "rgba(51,65,85,0.5)" : "linear-gradient(135deg, #06b6d4, #10b981)",
              color: joinBusy ? "#64748b" : "#06060e",
              boxShadow: joinBusy ? "none" : "0 0 25px rgba(6, 182, 212, 0.3)",
              transition: "all 0.25s",
            }}>
              {joinSuccess ? "Pledged!" : joinBusy ? "Approving & Joining..." : "Join Squad & Lock Trade"}
            </button>
            {joinError && <p style={{ color: "#f43f5e", fontSize: 13, marginTop: 8 }}>{joinError}</p>}
          </div>
        ) : (
          <p style={{ fontSize: 14, color: "#64748b", textAlign: "center" }}>Connect your wallet to join.</p>
        )}
      </div>
    </main>
  );
}
