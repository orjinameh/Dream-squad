"use client";

import dynamic from "next/dynamic";

const GameApp = dynamic(() => import("@/game/GameApp"), { ssr: false });

export default function Home() {
  return <GameApp />;
}
