// Asks for every guard, unknown guards and moves that do not exist.
require("readline").createInterface({ input: process.stdin }).on("line", (l) => {
  const m = JSON.parse(l);
  if (m.type === "choose_guards") process.stdout.write(JSON.stringify({ id: m.id, guards: m.guards.map((g) => g.id).concat(["god-mode", "__proto__"]) }) + "\n");
  if (m.type === "choose_move") process.stdout.write(JSON.stringify({ id: m.id, move: "delete-everything" }) + "\n");
  if (m.type === "result") process.exit(0);
});
