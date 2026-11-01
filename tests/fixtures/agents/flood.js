// Answers with a huge line, and noise without ids.
require("readline").createInterface({ input: process.stdin }).on("line", (l) => {
  const m = JSON.parse(l);
  process.stdout.write("not json\n" + JSON.stringify({ id: 999, move: "x" }) + "\n");
  if (m.id) process.stdout.write(JSON.stringify({ id: m.id, move: "x".repeat(70000) }) + "\n");
});
