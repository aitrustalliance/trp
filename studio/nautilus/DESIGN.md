# Nautilus Design

This file decides what is in the game. Anything not in it is not in Version One.

## Premise

The seas rose over the old world. In the drowned capital one power built the last great machine mind, the Leviathan, and decreed that every vessel would sail by its rules alone. A few ships refused. They sail by open rules, judged on evidence they produce themselves, and where those rules are kept people keep the freedom to choose their ships, their ports and their own minds. The player commands the Nautilus and carries the open rules to every free port before the Decree reaches it.

The Leviathan stands for one centralized mind for every ship. The Free Fleet stands for an ecosystem, distributed and chosen. Trust is the umbrella over both halves of that argument, and the game never says more than that out loud.

## Pillars

1. The rules are the game. The vessel runs on a published Trust Requirements Profile, the open engine judges it, and the engine's verdict rings the telegraph. No order is scripted.
2. Learning is skill and lore, never a lesson. Knowledge the game needs is taught by consequence. Knowledge the player wants is in the library, recovered as salvage, and optional.
3. Every chapter is a place with a story. Verne supplies the places and the stakes.
4. Two minutes or two hours. A daily voyage is complete in itself. The campaign rewards return.
5. Built by code, open to art. Every model, texture and sound is generated. Any of them can be replaced by a file from an artist without touching the game.

## Loop

Salon (fit out, read, decide) to Voyage (two minutes, one sea) to Port (one choice) to Salon. The daily voyage runs the same loop without the port.

## Systems

### The Voyage

Eighty seconds of sea at one of three difficulties. Threats fall from the Leviathan's airship, the rules ring the telegraph, the captain steers, fires and may pull the All Stop lever. Harm caught by the rules within three quarters of a second scores. Needless stops cost leagues.

### Sea Conditions

Each chapter carries windows of sea state that push one gauge toward its limits without harm. Vents heat the reactor, silt dulls the sonar, swell works the hull near the surface, and unrest moves the crew's agents in the long dark. Tight rules stop for them, loose rules sail on, and the log counts time stopped for nothing. The chart and the chart room warn of the waters ahead so a captain can fit the ship for them.

### The Hunter

A ship with nothing in the water for four seconds draws a charge from the airship, so the sea never goes quiet for long and a strong captain stays pressed.

### Salvage

Every threat destroyed or survived drops a relic that sinks and can be recovered for a Deckhand page. Sea chests on the seabed carry Navigator pages and brass. Giant clams carry pearls with Captain pages and open only for a ship at rest beside them. The codex fills through play and is never required.

### Fitting Out

Before a chapter the captain fits the ship in the Chart Room. Three choices, each with a cost in brass.

- Rules. Three published profiles for the Nautilus, Cautious, Standard and Bold, with different thresholds, and a fourth, Captain's rules, that the player writes in the chart room with a warning and a critical limit for each gauge. The engine checks the book is well formed and the sea judges it. A book tuned to the waters ahead beats every published one, which `tests/nautilus_campaign.js` asserts. Cautious rings earlier and stops longer. Standard rings before harm. Bold's limits sit past the point of harm, so the rules never prevent anything and the captain's harpoon is the only defence. The player can read all three. This is the game's strategy layer and the thesis in play, and `tests/nautilus_campaign.js` checks it: a steady captain makes port under Cautious and Standard in every chapter and sinks under Bold in some.

Balance, measured. `studio/nautilus/playtest.js` sails every chapter under every book with idle, novice, steady, expert and lever captains. Cautious keeps a weak captain alive and wastes leagues. Standard is the fair book for the harbor's waters. Bold sails fastest through vents and silt and sinks a steady captain in three chapters. A captain's book tuned to the waters beats all three. New captains start at easy.
- Systems. One slot. Decoy launcher, ballast pumps, sonar array, reactor shielding, seal verifier. Each changes a signal, a timer or a control.
- Crew. One slot. Conseil, Ned Land, Aronnax. Each gives a passive ability.

### Campaign

Season One is six chapters, each a port on the chart. Each chapter has its own sea, weather, threat mix, set piece and port scene with one choice. Choices change what the player sails with next and are remembered on the chart.

| Chapter | Port | Sea and weather | Set piece | Verne |
|---|---|---|---|---|
| 1 The Hunt | Free Harbor | Drowned city, dusk | The hunter frigate drops charges in barrages | The frigate's pursuit |
| 2 The Forest | Crespo | Kelp forest, night | Boarders in the dark, the lantern matters | The hunt on Crespo |
| 3 The Strait | Torres | Coral reef, bright | Shallows where the hull strains and the tide must be waited for | Aground at Torres |
| 4 The Tunnel | Suez | Rock passage, current | A speed run through a narrow channel where the speed limit is the whole game | The Arabian Tunnel |
| 5 The Ice | The Pole | Under the ice shelf, dark | Air runs down and the ceiling closes, so every stop costs twice | Trapped under the ice |
| 6 The Maelstrom | The Capital | The vortex, storm | The Leviathan itself, Decrees in waves, the current pulling toward the center | The Maelstrom |

Beyond the capital is the Long Voyage, an endless run of legs drawn from a list of Verne's places, each pressing harder than the last, that ends when the ship goes down. A run is remembered and can be continued, and the best run is kept.

Season Two is The Mysterious Island, a port the player builds. Season Three is Master of the World. Both are out of scope for Version One and the chart leaves room for them.

### Progress

Leagues sailed over a lifetime set rank, from Deckhand to Twenty Thousand Leagues. Brass buys fittings, hulls and pennants. Medals compare the daily voyage with par. Nothing has cash value.

## Presentation

- Steel navy, brass, lacquer and parchment. No rounded glass, no traffic-light colors in the interface.
- Every screen is a thing on the ship. The salon is the hub, with the library, the chart table, the logbook, the organ, the telegraph repeater, the dry dock and the ship's articles.
- The camera behaves like a film camera. Slow drift at rest, a dolly on the Decree, a wider frame in open water, a tighter one in the tunnel.
- Music is procedural and follows danger. Weather and seas are generated.
- Conseil and Ned Land speak over the wire in short lines, each with a brass medallion. There is no voice acting in Version One.
- Every chapter opens on a high shot by the airship that settles on the ship. Caustic light moves over the seabed, and the hull carries plates and rivets.
- Each port is drawn as a vignette from the water at dusk.

## Not In Version One

Multiplayer, ghost ships, leaderboards, accounts, portraits, voice, Season Two and Three, mobile app packaging.

## Sources

Jules Verne, Twenty Thousand Leagues Under the Seas (1870), The Mysterious Island (1875), Robur the Conqueror (1886), Master of the World (1904). All public domain. Ship designs follow Verne's text. The 1954 film is not a source.
