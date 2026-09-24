// node run.mjs --url https://do-alarm-held-repro.<subdomain>.workers.dev [options]
//
// One fresh Durable Object per trial. Arms its alarm, looks at the object `--check` ms after the
// alarm's time, and prints one line per trial. An alarm not yet delivered then is HELD; the runner
// handles held alarms in turn with each strategy in --on-held:
//   wait   poll getAlarm() every 5 s until the alarm is delivered
//   rearm  setAlarm(now + 1 ms), a different time, and time the delivery
//   idle   leave the object alone until +120 s, then read when it was delivered
//   same   setAlarm(the stored time) again, then poll like wait
//   put    storage.put() of an unrelated key, no setAlarm, then poll like wait
//
// Options (defaults):
//   --trials 200          stop after this many trials...
//   --minutes 0           ...or after this many minutes (0: no limit)
//   --concurrency 50      trials in flight
//   --shape both          move (+60 s, then +1.5 s) | single (+1.5 s) | both (alternate)
//   --soon 1500 --later 60000
//   --hints ""            location hints, round-robin, e.g. weur,enam,wnam,apac
//   --check 4000          ms after the alarm's time to look; not delivered by then = held
//   --on-held wait,rearm,idle,same,put
//   --give-up 300000      stop watching a held alarm this many ms after its time
//   --out results-<run>.jsonl
//
// node run.mjs --summarize a.jsonl,b.jsonl   prints the summary of earlier runs
import { appendFileSync, readFileSync } from "node:fs";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, arg, i, all) => {
    if (arg.startsWith("--")) pairs.push([arg.slice(2), all[i + 1]?.startsWith("--") ? "1" : (all[i + 1] ?? "1")]);
    return pairs;
  }, []),
);
const opt = (name, fallback) => args[name] ?? fallback;
const summarize = args.summarize?.split(",");
const base = (opt("url", process.env.REPRO_URL) ?? "").replace(/\/$/, "");
if (!base && !summarize) throw new Error("--url https://do-alarm-held-repro.<subdomain>.workers.dev is required");
const trials = Number(opt("trials", 200));
const minutes = Number(opt("minutes", 0));
const concurrency = Number(opt("concurrency", 50));
const shapeOpt = opt("shape", "both");
const soon = Number(opt("soon", 1500));
const later = Number(opt("later", 60000));
const hints = opt("hints", "").split(",").filter(Boolean);
const check = Number(opt("check", 4000));
const onHeld = opt("on-held", "wait,rearm,idle,same,put").split(",");
const giveUp = Number(opt("give-up", 300000));
const run = Date.now().toString(36);
const out = opt("out", `results-${run}.jsonl`);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
const utc = (ms) => (ms == null ? "null" : new Date(ms).toISOString());
const hms = (ms) => (ms == null ? "null" : new Date(ms).toISOString().slice(11, 23));
const secs = (ms) => `${(ms / 1000).toFixed(1)} s`;
async function get(path, params) {
  const res = await fetch(`${base}${path}?${new URLSearchParams(params)}`);
  const text = await res.text();
  const title = /<title>([^<]*)<\/title>/.exec(text)?.[1];
  if (!res.ok) throw new Error(`${path} ${res.status}: ${(title ?? text).slice(0, 200)}`);
  return JSON.parse(text);
}

const started = Date.now();
const results = [];
let heldSeen = 0;
let nextIndex = 0;
let stopping = false;

async function trial(i) {
  const shape = shapeOpt === "both" ? (i % 2 ? "single" : "move") : shapeOpt;
  const hint = hints.length ? hints[Math.floor(shapeOpt === "both" ? i / 2 : i) % hints.length] : "";
  const name = `${run}-${shape}-${i}`;
  const params = { id: name, ...(hint && { hint }) };
  const sent = Date.now();
  const armed = await get("/arm", { ...params, shape, soon, later }).catch((error) => {
    throw new Error(`${error.message} (after ${secs(Date.now() - sent)})`);
  });
  const t = { run, i, shape, hint: hint || null, name, doId: armed.doId, laterAt: armed.laterAt, target: armed.target };
  t.armInstance = armed.instance;
  t.armMs = Date.now() - sent; // round trip of /arm, which returns once setAlarm() has resolved
  await sleep(soon + check);

  let s = await get("/status", params);
  t.looks = [{ now: s.now, getAlarm: s.getAlarm, delivered: s.deliveries.length > 0 }];
  if (s.deliveries.length === 0) {
    t.held = true;
    t.strategy = onHeld[heldSeen++ % onHeld.length];
    const look = async () => {
      s = await get("/status", params);
      t.looks.push({ now: s.now, getAlarm: s.getAlarm, delivered: s.deliveries.length > 0 });
    };
    if (["rearm", "same", "put"].includes(t.strategy)) {
      t.rearm = await get("/rearm", { ...params, to: t.strategy === "rearm" ? "next" : t.strategy });
      for (const wait of [100, 200, 500, 1000, 2000]) {
        await sleep(wait);
        await look();
        if (s.deliveries.length) break;
      }
    }
    if (t.strategy === "idle") {
      await sleep(t.target + 120000 - s.now);
      await look();
    }
    while (s.deliveries.length === 0 && s.now < t.target + giveUp) {
      await sleep(t.strategy === "idle" ? 10000 : 5000);
      await look();
    }
  }
  t.deliveries = s.deliveries;
  t.instance = s.instance;
  const first = s.deliveries[0];
  t.latenessMs = first ? first.at - t.target : null;
  if (t.rearm) {
    const after = s.deliveries.find((d) => d.at >= t.rearm.at);
    t.rearmDeliveryMs = after ? after.at - t.rearm.at : null;
  }
  t.atReplacedTime = Boolean(first && t.laterAt && Math.abs(first.at - t.laterAt) < 2000);
  if (t.held || t.latenessMs > 1000 || t.armMs > 5000) t.colo = (await get("/colo", params)).colo;
  return t;
}

function line(t) {
  const head = `${utc(t.target)} ${t.shape.padEnd(6)} #${String(t.i).padEnd(5)} ${(t.hint ?? "-").padEnd(4)}`;
  if (t.error) return `${head} ERROR ${t.error.split("\n")[0]}`;
  const first = t.deliveries[0];
  const slowArm = t.armMs > 5000 ? ` (/arm took ${secs(t.armMs)})` : "";
  if (!t.held && t.latenessMs <= 1000) return `${head} ${t.doId.slice(0, 16)}  delivered +${t.latenessMs} ms${slowArm}`;
  if (!t.held) return `${head} ${t.doId} ${t.colo ?? "-"} LATE delivered ${hms(first.at)} (+${secs(t.latenessMs)})${slowArm}`;
  const heldLooks = t.looks.filter((l) => !l.delivered && (!t.rearm || l.now < t.rearm.at));
  const readings = [...new Set(heldLooks.map((l) => l.getAlarm))].map(hms).join(", ");
  const at = heldLooks.map((l) => `+${((l.now - t.target) / 1000).toFixed(1)}`);
  const span = at.length > 1 ? `${at[0]}..${at.at(-1)} s (${at.length} reads)` : `${at[0]} s`;
  let text = `${head} ${t.doId} ${t.colo ?? "-"} HELD [${t.strategy}] getAlarm()=${readings} at ${span}`;
  if (!first) return `${text}; NOT DELIVERED by +${secs(giveUp)}`;
  const incarnation = first.instance === t.armInstance ? "same instance" : "new instance";
  if (t.rearm) {
    const poke = { next: "setAlarm(now + 1 ms)", same: "setAlarm(the same time)", put: "storage.put() alone" };
    text += `; ${poke[t.rearm.to]} at ${hms(t.rearm.at)}`;
    if (t.rearmDeliveryMs == null) return `${text} -> NOT DELIVERED`;
    return `${text} -> delivered ${t.rearmDeliveryMs} ms later (${incarnation})`;
  }
  const replaced = t.atReplacedTime ? ", at the replaced +60 s time" : "";
  return `${text}; delivered ${hms(first.at)} (+${secs(t.latenessMs)}, ${incarnation}${replaced})`;
}

async function worker() {
  while (!stopping && nextIndex < trials && (!minutes || Date.now() - started < minutes * 60000)) {
    const i = nextIndex++;
    let t;
    try {
      t = await trial(i);
    } catch (error) {
      t = { run, i, shape: shapeOpt === "both" ? (i % 2 ? "single" : "move") : shapeOpt, hint: null, error: String(error) };
      t.target = Date.now();
    }
    results.push(t);
    appendFileSync(out, JSON.stringify(t) + "\n");
    console.log(line(t));
  }
}

function summary() {
  const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
  const report = [`\n=== ${results.length} trials in ${((Date.now() - started) / 60000).toFixed(1)} min, run ${run}, results in ${out}`];
  if (summarize) report[0] = `\n=== ${results.length} trials from ${summarize.join(", ")}`;
  for (const shape of ["move", "single"]) {
    const rows = results.filter((t) => t.shape === shape);
    if (!rows.length) continue;
    const ok = rows.filter((t) => !t.error);
    // A re-armed alarm's delivery time is ours, not the runtime's: it is left out of the lateness.
    const natural = ok.filter((t) => !t.rearm);
    const late = natural.map((t) => t.latenessMs).filter((ms) => ms != null).sort((a, b) => a - b);
    const buckets = [
      ["<=10 ms", (ms) => ms <= 10],
      ["10-100 ms", (ms) => ms > 10 && ms <= 100],
      ["0.1-1 s", (ms) => ms > 100 && ms <= 1000],
      [`1 s-${check / 1000} s`, (ms) => ms > 1000 && ms <= check],
      [`${check / 1000}-10 s`, (ms) => ms > check && ms <= 10000],
      ["10-30 s", (ms) => ms > 10000 && ms <= 30000],
      ["30-60 s", (ms) => ms > 30000 && ms <= 60000],
      [">60 s", (ms) => ms > 60000],
    ];
    const label = shape === "move" ? `move (+${later / 1000} s, then +${soon / 1000} s)` : `single (+${soon / 1000} s)`;
    const held = ok.filter((t) => t.held);
    const slow = ok.filter((t) => t.armMs > 5000).length;
    report.push(`${label}: ${rows.length} trials, ${rows.length - ok.length} errors, ${held.length} held (not delivered at +${check / 1000} s), ${slow} with /arm slower than 5 s`);
    report.push(`  lateness of the ${natural.length} not re-armed (delivery minus the alarm's time):`);
    if (late.length) {
      report.push(
        `    p50 ${pct(late, 0.5)} ms, p90 ${pct(late, 0.9)} ms, p99 ${pct(late, 0.99)} ms, p99.9 ${pct(late, 0.999)} ms, max ${late.at(-1)} ms`,
        `    ${buckets.map(([name, test]) => `${name}: ${late.filter(test).length}`).join(" | ")} | never: ${natural.length - late.length}`,
      );
    }
    for (const strategy of onHeld) {
      const these = held.filter((t) => t.strategy === strategy);
      if (!these.length) continue;
      const fmt = (t) =>
        t.rearm
          ? `${t.rearmDeliveryMs == null ? "never" : `${t.rearmDeliveryMs} ms`} after the call`
          : t.latenessMs == null ? "never" : secs(t.latenessMs);
      report.push(`  held [${strategy}]: ${these.map(fmt).join(", ")}`);
    }
  }
  const late = results.filter((t) => t.held || t.latenessMs > 1000);
  if (late.length) report.push("held or late alarms:", ...late.map(line));
  const errors = results.filter((t) => t.error);
  if (errors.length) report.push("errors:", ...errors.map(line));
  console.log(report.join("\n"));
}

if (summarize) {
  for (const file of summarize) results.push(...readFileSync(file, "utf8").trim().split("\n").map((row) => JSON.parse(row)));
  summary();
  process.exit(0);
}
process.on("SIGINT", () => {
  if (stopping) {
    summary();
    process.exit(130);
  }
  stopping = true;
  console.error("no new trials; waiting for the ones in flight (Ctrl-C again to stop now)");
});
await Promise.all(Array.from({ length: concurrency }, worker));
summary();
