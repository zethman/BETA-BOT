const WebSocket = require("ws");

const API_KEY = "20090c99-e289-4381-b84a-812ea62bd8cb";
const WS_URL = `wss://mainnet.helius-rpc.com/?api-key=${API_KEY}`;

console.log("Connecting...");

const ws = new WebSocket(WS_URL);

ws.on("open", () => {
  console.log("WebSocket connected");

  ws.send(JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "logsSubscribe",
    params: [
      "all",
      {
        commitment: "processed"
      }
    ]
  }));

  console.log("Subscription request sent");
});

ws.on("message", (data) => {
  console.log("MESSAGE:", data.toString().slice(0, 1000));
});

ws.on("error", (error) => {
  console.error("ERROR:", error);
});

ws.on("close", (code, reason) => {
  console.log("CLOSED:", code, reason.toString());
});

setTimeout(() => {
  console.log("10 second timeout reached");
  ws.close();
}, 10000);
