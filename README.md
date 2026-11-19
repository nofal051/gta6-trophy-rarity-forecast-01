# GTA VI trophy rarity forecaster

Forecasts, for every Grand Theft Auto VI trophy on PlayStation 5, its earn
rate on Exophase at the case target — as five quantiles per trophy — from
the house's recorded reads of the public trophy page.

## The idea

An earn rate is earners divided by players tracked, and on launch week
the two move for different reasons:

- **Players tracked explodes** as new buyers sync Exophase profiles.
  That dilutes every rate: a trophy nobody new has earned yet falls
  even while nobody un-earns it.
- **Earners grow** as the launch cohort plays through the game — early
  trophies first, endgame trophies last.

So `main.ts` fits, per trophy, two separate log-time trends on the recent
window of reads — log(earners) and log(players) — plus a direct trend of
logit(rate), and blends them, shrunk toward the last observed rate when
the history is thin. A flat history (launch night: every read identical)
carries no trend signal, so the program instead applies a dilution prior:
rates fall at the next refresh, easy early activities least, endgame
trophies most. The 5%–95% band widens with horizon and with fit noise,
so it stays honest after a refresh instead of pretending the last read
will persist.

## What the public page showed

Exophase's page for the game
(`https://www.exophase.com/game/grand-theft-auto-vi-psn/trophies/`,
read 2026-11-19 ~19:12 UTC): launch night it showed 638 players tracked
with Chapter 1 at 1.25%, Chapter 2 at 1.10%, the final mission at 1.10%
and the platinum at 0.63%. A day later Chapter 1 was at 0.73%, Chapter 2
at 0.14%, the final mission at 0.06% and the platinum at 0.03%, while
the fishing challenge held up at 1.89% (from 2.04%) and the intro trophy
stayed at ~100%. Dilution dominates story trophies; easy early
activities resist it. The program encodes that asymmetry; it never
fetches the page at run time (the grading sandbox has no network) — the
page only calibrated the model design, and the forecast itself comes
entirely from the case file it is given.

## Run it

```sh
mkdir -p out
MAKEFUN_INPUT_DIR=<kit>/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

Reads every `*.in` in the input directory, writes one `<id>.out` per
case. Node 22, standard library only, no network, no randomness:
two runs on the same case write byte-identical output.
Each run takes ~0.2 s on the two practice cases.

## Files

- `main.ts` — the whole forecaster (single file, no dependencies).
- `LICENSE` — MIT (written by `makefun init`).
