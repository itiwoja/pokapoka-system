import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";

async function start() {
  // ラボはサンプルのみ。ブリッジの接続・実データへの書き込みを開始しない。
  if (new URLSearchParams(location.search).get("view") !== "lab") {
    for (const src of ["/slip-renderer.js", "/relay-server/party-size.js", "/relay-server/kds-bridge.js"]) {
      await new Promise<void>((resolve) => {
        const script = document.createElement("script");
        script.src = src;
        script.onload = () => resolve();
        script.onerror = () => resolve();
        document.head.appendChild(script);
      });
    }
  }
  createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
}
void start();
