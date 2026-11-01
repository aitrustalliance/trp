// Exits on the first request.
require("readline").createInterface({ input: process.stdin }).on("line", (l) => { if (JSON.parse(l).id) process.exit(3); });
