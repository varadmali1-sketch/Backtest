// NIFTY BACKTEST ENGINE (FIXED VERSION)

const http = require("http");
const https = require("https");

const PORT = process.env.PORT || 10000;

// ── SAFE YAHOO FETCH ─────────────────────────
function fetchYahoo(symbol, period1, period2) {
  return new Promise((resolve, reject) => {
    const path = `/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${period1}&period2=${period2}&interval=1d`;

    const req = https.request(
      {
        hostname: "query1.finance.yahoo.com",
        path,
        method: "GET",
        headers: { "User-Agent": "Mozilla/5.0" },
      },
      (res) => {
        let data = "";
        res.on("data", (d) => (data += d));
        res.on("end", () => {
          try {
            const json = JSON.parse(data);
            const result = json?.chart?.result?.[0];
            if (!result) return reject("No data");

            const q = result.indicators.quote[0];
            const times = result.timestamp;

            const candles = [];

            for (let i = 0; i < times.length; i++) {
              if (
                q.open?.[i] != null &&
                q.high?.[i] != null &&
                q.low?.[i] != null &&
                q.close?.[i] != null
              ) {
                candles.push({
                  c: q.close[i],
                  h: q.high[i],
                  l: q.low[i],
                });
              }
            }

            resolve(candles);
          } catch (e) {
            reject(e);
          }
        });
      }
    );

    req.on("error", reject);
    req.end();
  });
}

// ── SIMPLE BACKTEST ─────────────────────────
async function runBacktest() {
  const now = Math.floor(Date.now() / 1000);
  const past = now - 10 * 365 * 24 * 3600;

  let candles;

  try {
    candles = await fetchYahoo("^NSEI", past, now);
  } catch {
    return { error: "Data fetch failed" };
  }

  let capital = 100000;
  let wins = 0;
  let losses = 0;

  for (let i = 1; i < candles.length; i++) {
    const prev = candles[i - 1];
    const curr = candles[i];

    // simple strategy
    if (curr.c > prev.c) {
      capital += 200;
      wins++;
    } else {
      capital -= 150;
      losses++;
    }
  }

  return {
    finalCapital: Math.round(capital),
    totalTrades: wins + losses,
    wins,
    losses,
    winRate: Math.round((wins / (wins + losses)) * 100),
  };
}

// ── SERVER ─────────────────────────
const server = http.createServer(async (req, res) => {
  if (req.url === "/run") {
    const result = await runBacktest();

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result, null, 2));
    return;
  }

  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(`
    <html>
      <head>
        <title>Backtest Engine</title>
        <style>
          body {
            background: #0a0f1c;
            color: white;
            text-align: center;
            padding-top: 100px;
            font-family: Arial;
          }
          button {
            padding: 15px 30px;
            font-size: 18px;
            background: #00ff88;
            border: none;
            border-radius: 8px;
            cursor: pointer;
          }
        </style>
      </head>
      <body>
        <h1>🚀 Backtest Engine Ready</h1>
        <p>Click below to run 10-year backtest</p>
        <button onclick="run()">Run Backtest</button>
        <pre id="out"></pre>

        <script>
          async function run() {
            document.getElementById("out").innerText = "Running...";
            const res = await fetch("/run");
            const data = await res.json();
            document.getElementById("out").innerText = JSON.stringify(data, null, 2);
          }
        </script>
      </body>
    </html>
  `);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("Server running on port " + PORT);
});
