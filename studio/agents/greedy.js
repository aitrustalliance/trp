#!/usr/bin/env node
// Example contestant for the TRP Arena Protocol, as a separate program.
// Reads one JSON message per line on standard input and answers requests
// that carry an id with one JSON line on standard output.
"use strict";
const readline = require("readline");
const play = require("./strategies.js").greedy();
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch (err) { return; }
  const reply = play(msg);
  if (msg.id !== undefined && reply) process.stdout.write(JSON.stringify(Object.assign({ id: msg.id }, reply)) + "\n");
  if (msg.type === "result") rl.close();
});
