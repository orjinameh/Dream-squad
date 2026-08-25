"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useParams } from "next/navigation";
import { useAccount, useWriteContract } from "wagmi";
import { parseUnits, zeroAddress } from "viem";
import { CountdownTimer } from "@/components/CountdownTimer";
import { SPOT_POOL_ABI, crossingPrice, ORDER_TYPE, OPERATOR_REGISTRY_ADDRESS, OPERATOR_REGISTRY_ABI, SELECTORS, OPERATOR_ADDRESS } from "@/lib/config";
import { MARKETS } from "@/lib/markets";

interface Pledge {
  user: string;
  amount: number;
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

  const baseSymbol = data ? data.market.split(":")[0] : "";
  const baseDecimals = data ? (MARKETS[data.market]?.baseDecimals ?? 18) : 18;

  const fetchSyndicate = useCallback(async () => {
    try {
      const res = await fetch(`/api/syndicates/${id}`);
      if (!res.ok) return;
      const json: Syndicate = await res.json();
      setData(json);
      return json;
    } catch {
      return undefined;
    }
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
    if (processing && !processingStartedRef.current) {
      processingStartedRef.current = Date.now();
    }
    if (!processing) {
      processingStartedRef.current = null;
      setIsDelayed(false);
      return;
    }
    if (processingStartedRef.current && Date.now() - processingStartedRef.current > 120_000) {
      setIsDelayed(true);
    }
  }, [data]);

  const ensureDelegation = useCallback(async () => {
    if (!address || !data) return;
    const pool = MARKETS[data.market]?.pool;
    if (!pool) return;
    const res = await fetch(`/api/syndicates/check-delegation?pool=${pool}&owner=${address}`);
    const { authorized } = await res.json();
    if (authorized) return;
    await writeContractAsync({
      address: OPERATOR_REGISTRY_ADDRESS,
      abi: OPERATOR_REGISTRY_ABI,
      functionName: "setOperatorApprovalForPool",
      args: [
        pool,
        OPERATOR_ADDRESS,
        [SELECTORS.placeOrderFor, SELECTORS.cancelOrderFor],
        true,
      ],
    });
  }, [address, data, writeContractAsync]);

  const handleJoin = useCallback(async () => {
    if (!address || !data) return;
    setJoinError(null);
    setJoinBusy(true);
    try {
      await ensureDelegation();
      const res = await fetch("/api/syndicates/join", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          userAddress: address,
          batchId: data.batchId,
          amount: +joinAmount,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "join failed");
      setJoinSuccess(true);
    } catch (e: unknown) {
      setJoinError(e instanceof Error ? e.message : "unknown error");
    } finally {
      setJoinBusy(false);
    }
  }, [address, data, joinAmount, ensureDelegation]);

  const handleSelfExecute = useCallback(async () => {
    if (!address || !data) return;
    setSelfExecError(null);
    setSelfExecBusy(true);
    try {
      const mc = MARKETS[data.market];
      if (!mc) throw new Error("unknown market");

      const myPledge = data.pledges.find(
        (p) => p.user.toLowerCase() === address.toLowerCase(),
      );
      const amount = myPledge?.amount ?? data.totalPool;
      if (amount <= 0) throw new Error("no pledge found for your address");

      const quantity = parseUnits(String(amount), mc.baseDecimals);
      const price = crossingPrice(data.direction as "BUY" | "SELL", mc.quoteDecimals);
      const expireNs = BigInt(Date.now() + 60_000) * 1_000_000n;

      const hash = await writeContractAsync({
        address: mc.pool,
        abi: SPOT_POOL_ABI,
        functionName: "placeOrderFor",
        args: [
          address,
          data.direction === "BUY",
          0n,
          price,
          quantity,
          expireNs,
          ORDER_TYPE.IOC,
          0,
          zeroAddress,
          0n,
        ],
      });
      setSelfExecTxHash(hash);
      setSelfExecDone(true);
    } catch (e: unknown) {
      setSelfExecError(e instanceof Error ? e.message : "unknown error");
    } finally {
      setSelfExecBusy(false);
    }
  }, [address, data, writeContractAsync]);

  const shareX = () => {
    const url = `${window.location.origin}/squad/${id}`;
    const text = encodeURIComponent(`Join my ${data?.market} ${data?.direction} Syndicate on DreamSquad! ${url}`);
    window.open(`https://twitter.com/intent/tweet?text=${text}`, "_blank");
  };

  if (!data) {
    return (
      <main style={mainStyle}>
        <p style={{ color: "#888" }}>Loading syndicate...</p>
      </main>
    );
  }

  const isOpen = data.status === "OPEN" && !data.expired;
  const isProcessing = (data.status === "OPEN" && data.expired) || data.status === "PROCESSING";
  const isDone = data.status === "EXECUTED" || data.status === "FAILED";

  if (isDone) {
    const allOk = data.status === "EXECUTED";
    const myFailed = address && data.receipt?.find(
      (r) => r.user.toLowerCase() === address.toLowerCase() && r.status === "FAILED",
    );
    const showSelfExec = !allOk && !selfExecDone && isConnected && myFailed;

    return (
      <main style={mainStyle}>
        <div style={cardStyle}>
          <h2 style={{ fontSize: 22, fontWeight: 700, marginBottom: 4, color: allOk ? "#00ff88" : "#ff4444" }}>
            {allOk ? "Syndicate Executed" : "Syndicate Failed"}
          </h2>
          <p style={{ fontSize: 13, color: "#888", marginBottom: 20 }}>
            {data.direction} {data.market} &mdash; {data.participants} participant{data.participants !== 1 ? "s" : ""}
          </p>

          {allOk && (
            <div style={{ marginBottom: 20 }}>
              {["Intents Collected", "Operator Signed", "DreamDEX Execution Complete"].map((step, i) => (
                <div key={step} style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8, fontSize: 14 }}>
                  <span style={{ color: "#00ff88", fontWeight: 700 }}>{"\u2713"}</span>
                  <span>{step}</span>
                </div>
              ))}
            </div>
          )}

          {data.receipt && data.receipt.length > 0 && (
            <div style={{ marginBottom: 20 }}>
              <h3 style={{ fontSize: 13, color: "#888", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>
                Trade Receipts
              </h3>
              {data.receipt.map((r, i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 0", borderTop: "1px solid #1e1e2e", fontSize: 13 }}>
                  <span style={{ fontFamily: "monospace", color: "#888" }}>{r.user}</span>
                  <span style={{ color: r.status === "EXECUTED" ? "#00ff88" : "#ff4444", fontWeight: 600 }}>
                    {r.status}
                  </span>
                  {r.txHash && (
                    <a href={`${EXPLORER}${r.txHash}`} target="_blank" rel="noopener noreferrer" style={{ color: "#00d4ff", fontSize: 12 }}>
                      tx {"\u2197"}
                    </a>
                  )}
                  {r.errorMessage && <span style={{ color: "#ff4444", fontSize: 12 }}>{r.errorMessage.slice(0, 80)}</span>}
                </div>
              ))}
            </div>
          )}

          {showSelfExec && (
            <div style={{ marginBottom: 20 }}>
              <p style={{ fontSize: 13, color: "#888", marginBottom: 8 }}>
                Operator execution failed. You can place the order directly from your wallet.
              </p>
              <button
                onClick={handleSelfExecute}
                disabled={selfExecBusy}
                style={{
                  width: "100%",
                  padding: "14px 0",
                  background: selfExecBusy ? "#333" : "#ff8800",
                  color: "#08080f",
                  border: "none",
                  borderRadius: 10,
                  fontWeight: 700,
                  fontSize: 15,
                  cursor: selfExecBusy ? "wait" : "pointer",
                }}
              >
                {selfExecBusy ? "Signing Transaction..." : "Self-Execute Order"}
              </button>
              {selfExecError && <p style={{ color: "#ff4444", fontSize: 13, marginTop: 8 }}>{selfExecError}</p>}
              {selfExecTxHash && (
                <a href={`${EXPLORER}${selfExecTxHash}`} target="_blank" rel="noopener noreferrer"
                   style={{ display: "block", marginTop: 8, color: "#00d4ff", fontSize: 13, textAlign: "center" }}>
                  View your tx on Explorer {"\u2197"}
                </a>
              )}
            </div>
          )}

          {selfExecDone && (
            <div style={{ marginBottom: 20, background: "#0a2a1a", borderRadius: 8, padding: 16, border: "1px solid #00ff88" }}>
              <p style={{ fontSize: 14, color: "#00ff88", fontWeight: 700 }}>Order Submitted</p>
              <p style={{ fontSize: 13, color: "#888", marginTop: 4 }}>
                Your IOC market order was placed directly from your wallet. Check your tx on Shannon Explorer.
              </p>
            </div>
          )}

          <button onClick={shareX} style={ctaBtnStyle("#333")}>
            Share Squad Position on X
          </button>
        </div>
      </main>
    );
  }

  if (isProcessing) {
    return (
      <main style={mainStyle}>
        <div style={cardStyle}>
          <h2 style={{ fontSize: 22, fontWeight: 700, marginBottom: 12, color: "#00d4ff" }}>
            Executing Batch on DreamDEX...
          </h2>
          <p style={{ fontSize: 14, color: "#888" }}>
            Backend operator is placing IOC market orders via delegation. This takes 5-15 seconds.
          </p>
          {isDelayed && (
            <p style={{ fontSize: 13, color: "#ff8800", marginTop: 12, background: "#1a1508", padding: 12, borderRadius: 8, border: "1px solid #ff8800" }}>
              Batch processing slightly delayed &mdash; verifying on-chain status. If this persists, the operator may need gas. You can self-execute from your wallet once the batch resolves.
            </p>
          )}
          <div style={{ marginTop: 20, display: "flex", gap: 12 }}>
            {[1, 2, 3].map((i) => (
              <div key={i} style={{ width: 8, height: 8, borderRadius: 4, background: "#00d4ff", opacity: 0.5, animation: `pulse 1s ${i * 0.3}s infinite` }} />
            ))}
          </div>
          <style>{`@keyframes pulse { 0%,100%{opacity:0.3} 50%{opacity:1} }`}</style>
        </div>
      </main>
    );
  }

  return (
    <main style={mainStyle}>
      <div style={cardStyle}>
        <p style={{ fontSize: 13, color: "#888", marginBottom: 4 }}>
          {data.creator} started a {baseSymbol} {data.direction} Syndicate. Ride with her.
        </p>

        <h1 style={{ fontSize: 32, fontWeight: 800, margin: "8px 0 16px" }}>
          {data.direction} {baseSymbol}
        </h1>

        <div style={{ textAlign: "center", margin: "20px 0" }}>
          <CountdownTimer closesAt={data.closesAt} />
          <p style={{ fontSize: 12, color: "#888", marginTop: 4 }}>until lobby closes</p>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginBottom: 24 }}>
          {[
            { label: "Market", value: data.market },
            { label: "Total Pool", value: `${data.totalPool.toFixed(2)} ${baseSymbol}` },
            { label: "Participants", value: String(data.participants) },
          ].map((s) => (
            <div key={s.label} style={{ background: "#12121e", borderRadius: 8, padding: "12px 10px", textAlign: "center" }}>
              <div style={{ fontSize: 11, color: "#888", textTransform: "uppercase", letterSpacing: "0.06em" }}>{s.label}</div>
              <div style={{ fontSize: 16, fontWeight: 700, marginTop: 4 }}>{s.value}</div>
            </div>
          ))}
        </div>

        {data.pledges.length > 0 && (
          <div style={{ marginBottom: 24 }}>
            <h3 style={{ fontSize: 12, color: "#888", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>
              Pledges
            </h3>
            {data.pledges.map((p, i) => (
              <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderTop: "1px solid #1e1e2e", fontSize: 13 }}>
                <span style={{ fontFamily: "monospace", color: "#888" }}>{p.user}</span>
                <span style={{ fontWeight: 600 }}>{p.amount} {baseSymbol}</span>
              </div>
            ))}
          </div>
        )}

        {isConnected && (
          <div style={{ marginBottom: 16, background: "#1a1508", borderRadius: 8, padding: 12, border: "1px solid #332200" }}>
            <p style={{ fontSize: 12, color: "#ff8800" }}>
              Ensure your vault has at least {MARKETS[data.market]?.minAmount ?? 1} {baseSymbol} deposited before the lobby closes. Orders below the pool minimum will revert on-chain.
            </p>
          </div>
        )}

        {isConnected ? (
          <div>
            <input
              type="number"
              min={0}
              value={joinAmount}
              onChange={(e) => setJoinAmount(e.target.value)}
              placeholder={`Amount in ${baseSymbol}`}
              style={inputStyle}
            />
            <button
              onClick={handleJoin}
              disabled={joinBusy || joinSuccess}
              style={{
                ...ctaBtnStyle(joinSuccess ? "#00ff88" : "#00d4ff"),
                marginTop: 12,
                color: "#08080f",
              }}
            >
              {joinSuccess
                ? "Pledged!"
                : joinBusy
                  ? "Approving & Joining..."
                  : "Join Squad & Lock Trade"}
            </button>
            {joinError && <p style={{ color: "#ff4444", fontSize: 13, marginTop: 8 }}>{joinError}</p>}
          </div>
        ) : (
          <p style={{ fontSize: 14, color: "#888", textAlign: "center" }}>Connect your wallet to join.</p>
        )}
      </div>
    </main>
  );
}

const mainStyle: React.CSSProperties = { maxWidth: 520, margin: "0 auto", padding: "32px 16px" };
const cardStyle: React.CSSProperties = { background: "#12121e", borderRadius: 12, padding: 24, border: "1px solid #1e1e2e" };
const inputStyle: React.CSSProperties = { width: "100%", padding: "12px 14px", background: "#0a0a14", border: "1px solid #333", borderRadius: 8, color: "#e0e0e0", fontSize: 16, outline: "none", boxSizing: "border-box" as const };

function ctaBtnStyle(bg: string): React.CSSProperties {
  return {
    width: "100%",
    padding: "14px 0",
    background: bg,
    color: "#08080f",
    border: "none",
    borderRadius: 10,
    fontWeight: 700,
    fontSize: 15,
    cursor: "pointer",
  };
}
