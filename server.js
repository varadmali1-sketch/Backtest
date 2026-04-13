const http = require("http");

const PORT = process.env.PORT || 10000;

const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });

  res.end(`
    <html>
      <head>
        <title>Backtest Engine</title>
        <style>
          body {
            background: #0a0f1c;
            color: white;
            font-family: Arial;
            text-align: center;
            padding-top: 100px;
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
        <h1>🚀 Backtest Engine Live</h1>
        <p>Your deployment is working</p>
        <button onclick="alert('Next step: integrate full engine')">
          Run Backtest
        </button>
      </body>
    </html>
  `);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("Server running on port " + PORT);
});
