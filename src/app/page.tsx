export default function Home() {
  return (
    <main style={{ maxWidth: 600, margin: "0 auto", padding: "80px 24px", textAlign: "center" }}>
      <h1 style={{ fontSize: 40, fontWeight: 800, color: "#00d4ff", marginBottom: 12 }}>
        DreamSquad
      </h1>
      <p style={{ fontSize: 18, color: "#aaa", lineHeight: 1.6, marginBottom: 40 }}>
        Pool capital with friends. Execute synchronized trades on DreamDEX via
        backend operator delegation. No custody, no custom contracts.
      </p>
      <a
        href="/create"
        style={{
          display: "inline-block",
          background: "#00d4ff",
          color: "#08080f",
          fontWeight: 700,
          fontSize: 16,
          padding: "14px 32px",
          borderRadius: 10,
          textDecoration: "none",
        }}
      >
        Create a Syndicate
      </a>
    </main>
  );
}
