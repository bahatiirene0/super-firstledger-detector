const express = require("express");
const WebSocket = require("ws");
const SuperFirstLedgerDetector = require("./detector");
const logger = require("./logger");
const path = require("path"); // Add path module

const app = express();
const server = app.listen(3000, () => logger.info("Server running on port 3000"));
const wss = new WebSocket.Server({ server });

// Serve static files from 'public' directory
app.use(express.static(path.join(__dirname, "public")));

// Explicitly serve index.html for root route
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

wss.on("connection", (ws) => {
  logger.info("New WebSocket client connected");
  ws.on("error", (e) => logger.error(`WebSocket error: ${e.message}`));
  ws.on("close", () => logger.info("WebSocket client disconnected"));
});

function broadcast(data) {
  wss.clients.forEach((client) => {
    try {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify(data));
      }
    } catch (e) {
      logger.error(`Broadcast failed: ${e.message}`);
    }
  });
}

const detector = new SuperFirstLedgerDetector();
detector.start((data) => broadcast({ type: "token", data })).catch((e) => {
  logger.error(`Detector startup failed: ${e.message}`);
  process.exit(1);
});

setInterval(async () => {
  try {
    const stats = await detector.getPerformanceStats();
    broadcast({ type: "stats", data: stats });
  } catch (e) {
    logger.error(`Stats broadcast failed: ${e.message}`);
  }
}, 300000);