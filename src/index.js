<!DOCTYPE html>
<html>
<head>
  <title>Super FirstLedger Detector</title>
  <style>
    table { border-collapse: collapse; width: 100%; margin-bottom: 20px; }
    th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
    th { background-color: #f2f2f2; }
    .unsure { background-color: #fff3cd; }
    #stats { font-family: monospace; }
  </style>
</head>
<body>
  <h1>FirstLedger Token Detector</h1>
  <table id="tokenTable">
    <thead>
      <tr>
        <th>Ticker</th>
        <th>Issuer</th>
        <th>Burned XRP</th>
        <th>Supply</th>
        <th>Holders</th>
        <th>Price (XRP)</th>
        <th>Market Cap (XRP)</th>
        <th>Liquidity (XRP)</th>
        <th>Confidence</th>
        <th>Timestamp</th>
      </tr>
    </thead>
    <tbody id="tokenBody"></tbody>
  </table>

  <h2>Performance Stats (Last 5 Minutes)</h2>
  <pre id="stats"></pre>

  <script>
    const ws = new WebSocket("ws://localhost:3000");
    const tokens = new Map();

    ws.onmessage = (event) => {
      try {
        const { type, data } = JSON.parse(event.data);
        if (type === "token") {
          tokens.set(`${data.currency}-${data.issuer}`, data);
          const row = document.getElementById(`${data.currency}-${data.issuer}`);
          if (row) {
            row.cells[4].textContent = data.holders;
            row.cells[5].textContent = data.price.toFixed(6);
            row.cells[6].textContent = data.marketCap.toFixed(2);
            row.cells[7].textContent = data.liquidityXRP.toFixed(2);
          } else {
            const tbody = document.getElementById("tokenBody");
            tbody.innerHTML += `
              <tr id="${data.currency}-${data.issuer}" class="${data.isFirstLedger ? "" : "unsure"}">
                <td>${data.currency}</td>
                <td>${data.issuer.slice(0, 10)}...</td>
                <td>${data.burnedXRP}</td>
                <td>${data.supply.toLocaleString()}</td>
                <td>${data.holders}</td>
                <td>${data.price.toFixed(6)}</td>
                <td>${data.marketCap.toFixed(2)}</td>
                <td>${data.liquidityXRP.toFixed(2)}</td>
                <td>${data.isFirstLedger ? "Confirmed" : "Unsure"}</td>
                <td>${data.timestamp}</td>
              </tr>`;
          }
        } else if (type === "stats") {
          document.getElementById("stats").textContent = data.map(stat => 
            `${stat.event}: Count=${stat.count}, Avg Latency=${stat.avgLatency.toFixed(3)}s, ` +
            `Min=${stat.minLatency.toFixed(3)}s, Max=${stat.maxLatency.toFixed(3)}s, ` +
            `Success Rate=${stat.successRate.toFixed(1)}%`
          ).join("\n");
        }
      } catch (e) {
        console.error(`WebSocket message error: ${e.message}`);
      }
    };

    ws.onerror = (e) => console.error(`WebSocket error: ${e.message}`);
    ws.onclose = () => console.log("WebSocket closed, attempting to reconnect...");
  </script>
</body>
</html>