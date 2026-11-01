"use strict";
// House style for copy in the open repository. Shared by the content tests.
// Professional and industry terms stand on their own. These are filler,
// hedges and stock phrases that read as machine written.
const TELLS = [
  "plainly", "simply put", "delve", "robust", "seamless", "leverage", "harness the", "navigate the", "journey", "landscape",
  "tapestry", "crucial", "vital", "worth noting", "in today's", "dive into", "elevate", "empower", "cutting[- ]edge",
  "game[- ]changer", "at its core", "the key is", "a testament", "stands as", "serves as", "underscore", "foster",
  "it is important", "genuinely", "honestly", "straightforward", "plain[- ]language", "rather than", "not just", "not only",
  "more than just", "in other words", "ultimately", "in essence", "essentially", "nuanced", "multifaceted", "holistic",
  "meticulous", "streamline", "utilize", "facilitate", "showcase", "realm", "paramount", "pivotal", "intricate", "embark",
  "beacon", "whilst", "designed to", "in order to", "keep in mind", "feel free", "rest assured", "that being said",
  "needless to say", "at the end of the day", "moving forward", "going forward", "first and foremost", "last but not least",
  "this is why", "that is why", "which is to say", "in short(?!\\s+line)", "think of it", "imagine", "truly", "deeply", "incredibly",
  "remarkably", "notably", "importantly", "interestingly", "fundamentally", "inherently", "arguably", "undeniably",
  "absolutely", "elegant", "effortless", "intuitive", "world[- ]class", "state of the art", "revolutionary",
  "transformative", "innovative", "disruptive", "synergy", "paradigm", "north star", "double down", "deep dive",
  "single source of truth", "exactly this", "\\bvery\\b",
];
const TELL_RE = new RegExp("\\b(" + TELLS.join("|") + ")\\b", "i");

// Returns the first problem found in a run of prose, or null.
function check(text) {
  if (/—|–/.test(text)) return "a dash";
  if (/;/.test(text)) return "a semicolon";
  const m = TELL_RE.exec(text);
  if (m) return `the phrase "${m[1]}"`;
  return null;
}

module.exports = { TELLS, TELL_RE, check };
