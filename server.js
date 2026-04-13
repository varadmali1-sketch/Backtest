const http = require("http");

const PORT = process.env.PORT || 10000;

const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Working 🚀");
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("Server running on port " + PORT);
});
