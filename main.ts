// GTA VI trophy rarity forecaster (make.fun: gta6-trophy-rarity-forecast-01).
//
// Reads every case file (<id>.in) in the input directory and writes one
// forecast file (<id>.out) per case to the output directory. Node 22,
// standard library only, no network, fully deterministic.
//
// Model, in one paragraph: an earn rate is earners divided by players
// tracked, and on launch week the two move for different reasons. Players
// tracked explodes as new buyers sync Exophase profiles (dilution: it
// drags every rate down), while earners grow as the launch cohort plays
// through the game (progression: it lifts early trophies first, endgame
// trophies last). So for each trophy the program fits, on the recent
// window of reads, two separate log-time trends -- log(earners) and
// log(players) -- plus a direct trend of logit(rate), and blends them.
// The blend is shrunk toward the last observed rate when the history is
// thin or flat, because a flat launch-night history says nothing about
// the next refresh. The spread widens with horizon and with how noisy
// the recent fit is, so the 5%-95% band stays honest after a refresh.
//
// Grounding (public Exophase page, read 2026-11-19 ~19:12 UTC):
// launch night the page showed 638 players tracked and e.g. Chapter 1 at
// 1.25%, Chapter 2 at 1.10%, the final mission at 1.10%, platinum at
// 0.63%. A day later the same page showed Chapter 1 at 0.73%, Chapter 2
// at 0.14%, the final mission at 0.06%, platinum at 0.03%, while the
// fishing challenge ("Baited My Tackle") held up at 1.89% (from 2.04%)
// and the intro trophy stayed at ~100%. Dilution dominates story
// trophies; easy early activities resist it. The model encodes exactly
// that asymmetry instead of assuming rates persist.

import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

// Standard-normal quantiles for the five scored levels.
const Z = [-1.6448536269514722, -0.6744897501960817, 0, 0.6744897501960817, 1.6448536269514722];
const RELEASE_START_MS = Date.parse("2026-11-19T00:00:00Z");

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function logit(pct) {
  const p = clamp(pct, 0.01, 99.99) / 100;
  return Math.log(p / (1 - p));
}

function invLogit(l) {
  return (100 / (1 + Math.exp(-l)));
}

// Ordinary least squares of y on x. Returns {a, b, residVar, n}.
// Caller guarantees n >= 2 and some spread in x.
function ols(xs, ys) {
  const n = xs.length;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i++) {
    mx += xs[i];
    my += ys[i];
  }
  mx /= n;
  my /= n;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    sxx += dx * dx;
    sxy += dx * (ys[i] - my);
  }
  const b = sxx > 1e-12 ? sxy / sxx : 0;
  const a = my - b * mx;
  let sse = 0;
  for (let i = 0; i < n; i++) {
    const r = ys[i] - (a + b * xs[i]);
    sse += r * r;
  }
  const residVar = n > 2 ? sse / (n - 2) : 0;
  return { a, b, residVar, n };
}

// A small progression prior from the trophy's own description. Early
// story beats and cheap open-world activities are earned quickly by the
// launch cohort; endgame grinds are earned late. This is only a prior:
// it nudges the fitted slope when the history is thin and washes out
// when the history is rich. Units: extra logit per unit of log-time.
function progressionPrior(trophy) {
  const d = (trophy.description || "").toLowerCase();
  const name = (trophy.name || "").toLowerCase();
  const text = name + " " + d;
  if (trophy.tier === "platinum") return -0.55;
  if (/100% completion|250 stunts|50 challenges|100 locations|3 collectible card sets/.test(text)) return -0.5;
  if (/final mission|attain 100%/.test(text)) return -0.45;
  if (/chapter 1|gone fishing/.test(text)) return 0.35;
  if (/chapter 2/.test(text)) return 0.15;
  if (/chapter 3|chapter 4/.test(text)) return -0.1;
  if (/arcade game|fishing challenge|discover 100 vehicles|cocktail|bowling|ten pin/.test(text)) return 0.25;
  if (/meditate|hunt a unique animal|explore all of leonida/.test(text)) return -0.2;
  return 0;
}

function forecastCase(c) {
  const trophies = c.trophies;
  const history = (c.history || []).slice().sort((p, q) => Date.parse(p.at) - Date.parse(q.at));
  const atMs = Date.parse(c.at);
  const targetMs = Date.parse(c.target);
  const horizonDays = Math.max((targetMs - atMs) / 86400000, 0.01);
  const xTarget = Math.log(1 + Math.max((targetMs - RELEASE_START_MS) / 3600000, 0));

  // Recent window: last 24h of reads, falling back to everything.
  const windowStart = atMs - 24 * 3600000;
  let recent = history.filter((h) => Date.parse(h.at) >= windowStart);
  if (recent.length < 3) recent = history;

  // Global players-tracked trend on the recent window.
  const px = [];
  const py = [];
  for (const h of recent) {
    if (h.players_tracked > 0) {
      px.push(Math.log(1 + Math.max((Date.parse(h.at) - RELEASE_START_MS) / 3600000, 0)));
      py.push(Math.log(h.players_tracked));
    }
  }
  const playersFit = px.length >= 2 ? ols(px, py) : null;
  const logPlayersTarget = playersFit
    ? playersFit.a + playersFit.b * xTarget
    : Math.log(Math.max(history.length ? history[history.length - 1].players_tracked : 1, 1));

  // How much did the history actually move? Flat launch-night histories
  // carry no trend signal at all.
  let moved = 0;
  if (history.length >= 2) {
    const first = history[0].rates;
    const last = history[history.length - 1].rates;
    for (let i = 0; i < trophies.length; i++) {
      const a = first[i];
      const b = last[i];
      if (a != null && b != null) moved = Math.max(moved, Math.abs(logit(b) - logit(a)));
    }
  }
  const flat = moved < 0.05;

  const rows = [];
  for (let ti = 0; ti < trophies.length; ti++) {
    const trophy = trophies[ti];
    const lastRead = history[history.length - 1];
    const lastRate = lastRead && lastRead.rates[ti] != null ? lastRead.rates[ti] : 0.5;
    const lastLogit = logit(lastRate);

    // Per-trophy series on the recent window.
    const xs = [];
    const lgs = []; // logit(rate)
    const les = []; // log(earners)
    for (const h of recent) {
      const r = h.rates[ti];
      if (r == null || h.players_tracked <= 0) continue;
      xs.push(Math.log(1 + Math.max((Date.parse(h.at) - RELEASE_START_MS) / 3600000, 0)));
      lgs.push(logit(r));
      les.push(Math.log(Math.max((r / 100) * h.players_tracked, 0.05)));
    }

    const prior = progressionPrior(trophy);
    let medianLogit;
    let sigma;

    if (flat) {
      // No movement in history (practice cases: every read identical).
      // The next refresh dilutes: new players arrive faster than anyone
      // earns anything, so every rate except the ~100% intro trophy
      // falls. Scale the drop with horizon: a 90-minute practice
      // horizon saw the mean rate fall roughly a quarter at the first
      // refresh; a multi-day horizon falls further. Easy early
      // activities fall least, endgame trophies most.
      const drop = lastRate >= 99.5 ? 0.0 : 0.28 + 0.1 * Math.min(horizonDays, 4) - 0.35 * Math.max(prior, 0);
      const oddsFactor = 1 - clamp(drop, 0, 0.85);
      medianLogit = lastLogit + Math.log(Math.max(oddsFactor, 0.05));
      sigma = 1.05 + 0.15 * Math.min(horizonDays, 4);
    } else if (xs.length >= 3) {
      const fitLogit = ols(xs, lgs);
      const fitEarn = ols(xs, les);
      // Trend forecast A: direct logit trend, prior-nudged.
      const trendA = fitLogit.a + (fitLogit.b + 0.25 * prior) * xTarget;
      // Trend forecast B: earners over players at the target.
      const logEarnTarget = fitEarn.a + (fitEarn.b + 0.15 * prior) * xTarget;
      const rateB = clamp((Math.exp(logEarnTarget) / Math.exp(logPlayersTarget)) * 100, 0.01, 99.99);
      const trendBLogit = logit(rateB);
      // Blend the two trend views, then shrink toward persistence by
      // how much signal the window actually held.
      const blend = 0.5 * trendA + 0.5 * trendBLogit;
      const quality = clamp(xs.length / 24, 0.15, 1) * clamp(1 - Math.sqrt(fitLogit.residVar) / 1.5, 0.2, 1);
      const w = clamp(quality, 0.2, 0.9);
      medianLogit = w * blend + (1 - w) * lastLogit;
      // Spread: random-walk base, plus fit noise, plus extrapolation.
      const xLast = xs[xs.length - 1];
      const stretch = Math.max(xTarget - xLast, 0);
      sigma = Math.sqrt(
        Math.pow(0.5 * Math.sqrt(horizonDays), 2) +
        Math.pow(0.55 + 0.35 * stretch, 2) +
        fitLogit.residVar * (1 + stretch * stretch),
      );
      sigma = clamp(sigma, 0.6, 1.6);
    } else {
      // Too few reads to fit: persistence with a wide band.
      medianLogit = lastLogit;
      sigma = 1.0;
    }

    // Platinum and the ~100% intro trophy need clamps, not trends.
    if (trophy.tier === "platinum") medianLogit = Math.min(medianLogit, logit(Math.max(lastRate * 1.6, 0.05)));
    if (lastRate >= 99.5) medianLogit = Math.min(Math.max(medianLogit, logit(99.5)), logit(99.99));

    const qs = Z.map((z) => {
      const v = invLogit(medianLogit + z * sigma);
      return Math.round(clamp(v, 0.01, 99.99) * 10000) / 10000;
    });
    // Enforce non-decreasing after rounding.
    for (let k = 1; k < qs.length; k++) if (qs[k] < qs[k - 1]) qs[k] = qs[k - 1];
    rows.push({ id: trophy.id, q: qs });
  }
  rows.sort((a, b) => a.id - b.id);
  return { trophies: rows };
}

function main() {
  const inputDir = process.env.MAKEFUN_INPUT_DIR || "/input";
  const outputDir = process.env.MAKEFUN_OUTPUT_DIR || "/output";
  mkdirSync(outputDir, { recursive: true });
  const files = readdirSync(inputDir).filter((f) => f.endsWith(".in")).sort();
  if (files.length === 0) throw new Error("no .in case files in " + inputDir);
  for (const f of files) {
    const c = JSON.parse(readFileSync(join(inputDir, f), "utf8"));
    const out = forecastCase(c);
    const id = f.replace(/\.in$/, "");
    writeFileSync(join(outputDir, id + ".out"), JSON.stringify(out), "utf8");
  }
}

main();
