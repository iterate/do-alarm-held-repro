# Durable Object alarm held past its time while getAlarm() reports it

**When you run this you expect every Durable Object alarm to run within a few milliseconds of its
time. Sometimes, after `setAlarm()` has moved the alarm earlier, it runs about 19, 39 or 58 s late,
and all that time `ctx.storage.getAlarm()` returns the overdue time. Calling `setAlarm()` again gets
it run within about 100 ms.** It happened to about 1 in 180 alarms moved from +60 s to +1.5 s, and
to about 1 in 37 when the two `setAlarm()` calls were a second apart. It never happened to an alarm
that was set once.

## The code

`src/index.js` is the whole Worker: one SQLite-backed Durable Object class, `Probe`, and a fresh
object per trial. A trial is:

```js
// GET /arm: one request, two RPC calls to the same new object
await stub.armLater(60_000); // ctx.storage.setAlarm(Date.now() + 60_000)
await stub.arm(1_500);       // ctx.storage.setAlarm(target = Date.now() + 1_500): the alarm moves earlier

// GET /status, 4 s after target
await ctx.storage.getAlarm(); // null, because alarm() has run. Sometimes it is still target.
```

That is the `move` shape. The `single` shape is `arm(1_500)` alone. `alarm()` stores `Date.now()`
and the object's instance id, a random value minted in the constructor, so a new incarnation shows.

`run.mjs` drives the trials and reads each object 4 s after its alarm's time. If `alarm()` has not
run and `getAlarm()` still returns the alarm's own time, the alarm is **held**, and the runner takes
turns among five things to do with it:

| | |
|---|---|
| `wait` | read `getAlarm()` every 5 s until `alarm()` runs |
| `idle` | leave the object alone until +120 s |
| `rearm` | `setAlarm(now + 1 ms)`, a different time |
| `same` | `setAlarm(t)`, with the `t` that `getAlarm()` returned |
| `put` | `storage.put()` of an unrelated key, no `setAlarm()` |

## Expected, and what happens

Expected, every trial (real lines):

```
2026-09-24T13:04:25.785Z move   #2036  -    66ada0ef85875888  delivered +0 ms
2026-09-24T13:04:25.873Z single #2037  -    345abf69a9995d62  delivered +0 ms
```

The columns are the alarm's time, the shape, the trial, the location hint, the object id, and how
late `alarm()` ran. That is what the documentation leads us to expect:

- `alarm()` runs at or just after the time given to `setAlarm()`. Here 99% of alarms ran within 6 ms.
- A second `setAlarm()` replaces the first. The alarm runs once, at the new time.
- `getAlarm()` returns the time the alarm will run. A time in the past means it is running now.

Sometimes (real lines, 2026-09-24, all `move`; after the object id comes the colo it ran in, then
what `getAlarm()` returned and when, relative to the alarm's time):

```
2026-09-24T13:09:41.829Z move   #4620  -    4685036633b3f5ca24a62d4b8e0715380edb13a90c59df1cbc33cc4eadfc3f78 LHR HELD [wait] getAlarm()=13:09:41.829 at +4.2..+39.5 s (8 reads); delivered 13:10:21.559 (+39.7 s, same instance)
2026-09-24T13:04:07.143Z move   #1796  eeur d4c9bf3d349425cc20ba817075b452ac6f0a7ff977659f2394785fc6bdf6acd9 ARN HELD [wait] getAlarm()=13:04:07.143 at +4.1..+14.3 s (3 reads); delivered 13:04:26.164 (+19.0 s, same instance)
2026-09-24T13:00:24.649Z move   #102   wnam f37414937514520a71f37a1cd628f30dc62d11370a3d2340c71d9f2ca315662d LAX HELD [wait] getAlarm()=13:00:24.649 at +4.3..+56.1 s (11 reads); delivered 13:01:22.930 (+58.3 s, same instance, at the replaced +60 s time)
2026-09-24T13:04:46.460Z move   #2208  -    344c4fe305eccf98bd760c11d1600927ed42f128d4755925366abc17ed1c4f04 LHR HELD [idle] getAlarm()=13:04:46.460 at +4.1 s; delivered 13:05:44.846 (+58.4 s, new instance, at the replaced +60 s time)
2026-09-24T13:05:40.956Z move   #2522  wnam e45efc30544c7c1bd51ae9f11f933168756aaae82fcf03ea0ffd66897cc458ce SJC HELD [idle] getAlarm()=13:05:40.956 at +4.2 s; delivered 13:06:00.002 (+19.0 s, new instance)
2026-09-24T13:02:45.084Z move   #1196  -    5ba7afc31cb763e69393fc99a86294fff8ea3c0283b9881b8a0e12a08c0b1507 AMS HELD [rearm] getAlarm()=13:02:45.084 at +4.1 s; setAlarm(now + 1 ms) at 13:02:49.207 -> delivered 33 ms later (same instance)
2026-09-24T13:06:14.151Z move   #2924  -    9306860bed4abbe0fac324f95c5a69b17532a3a4b4560a98982791f824f6996f LHR HELD [same] getAlarm()=13:06:14.151 at +4.1 s; setAlarm(the same time) at 13:06:18.312 -> delivered 30 ms later (same instance)
2026-09-24T13:08:48.784Z move   #4184  -    2881a62e412b1e1a40d2fb800115c5b26ecf443270563565f9421c33b8ce3a2d LHR HELD [put] getAlarm()=13:08:48.784 at +4.1 s; storage.put() alone at 13:08:52.872 -> delivered 15011 ms later (same instance)
```

Take #4620: its alarm was due at 13:09:41.829. Eight reads between +4.2 s and +39.5 s all got
13:09:41.829 back from `getAlarm()`. `alarm()` ran at 13:10:21.559, 39.7 s late, in the same
instance, and Workers Logs shows that invocation scheduled for 13:09:41. #102 and #2208 never ran at
their own time. Their alarm ran at 58.3 s and 58.4 s, within 1 ms of the +60 s time it had replaced,
and Workers Logs shows those invocations scheduled for the replaced time (13:01:22, 13:05:44).

## Run it

```sh
npm install
npx wrangler deploy     # prints https://do-alarm-held-repro.<subdomain>.workers.dev
node run.mjs --url https://do-alarm-held-repro.<subdomain>.workers.dev --minutes 10 --hints enam,wnam,apac
node run.mjs --url https://do-alarm-held-repro.<subdomain>.workers.dev --minutes 10
node run.mjs --url https://do-alarm-held-repro.<subdomain>.workers.dev --minutes 5 --shape move --pause 1000
```

It prints one line per trial and then a summary, and writes every reading to
`results-<run>.jsonl`. `node run.mjs --summarize a.jsonl,b.jsonl` prints the summary again. The
first two commands are what our runs did, side by side. The third is the quickest way to see it:
the Worker waits 1 s between the two `setAlarm()` calls, and 2.7% of alarms are held. With 50
trials in flight a runner does 250–500 trials a minute; a trial is three to five requests and one
alarm. In our runs the first held alarm came 6–27 s in with location hints, 0.1 s to 4.5 min in
without, and in the first seconds with `--pause 1000`. Options are at the top of `run.mjs`. In the
first seconds after a deploy a few `/arm` calls can return 500 while the new version rolls out; the
runner counts them as errors.

## What we saw

Two runs on 2026-09-24 from a laptop in London, each with two runners side by side: one without
location hints (its objects ran in LHR and AMS) and one with hints. The second run was a separate
deployment of the same code, made to check the first.
[`observed-2026-09-24.txt`](observed-2026-09-24.txt) is the runner's summary of each run, with every
held and late line.

| | run 1 | run 2 | both |
|---|---|---|---|
| time (UTC) | 12:35–13:20 | 13:37–13:59 | |
| hints on the second runner | `enam,wnam,weur,eeur,apac` | `enam,wnam,apac` | |
| `move` trials | 20,702 | 10,425 | 31,127 |
| `move` held | 106 (0.51%) | 69 (0.66%) | **175 (0.56%)** |
| `single` trials | 20,703 | 10,424 | 31,127 |
| `single` held | 0 | 0 | **0** |

Every held alarm was a `move`. Over the 31,041 `move` alarms not re-armed with `setAlarm()`,
lateness was p50 0 ms, p99 6 ms, p99.9 57.6 s and max 58.5 s.

**How late.** The 98 held alarms we did not re-arm (`wait`, `idle`, `put`) ran at three delays:

| ran after its time | run 1 | run 2 | scheduled time of that invocation in Workers Logs |
|---|---|---|---|
| 18.7–19.5 s | 22 | 12 | its own |
| 24.3 s | | 1 | its own (#2548, below) |
| 38.6–39.7 s | 17 | 14 | its own |
| 57.6–58.5 s | 19 | 13 | the replaced +60 s time; `alarm()` ran 0–4 ms after it (one 395 ms after) |

With `wait`, which reads the object every 5 s, the alarm ran in the same instance 39 of 40 times.
With `idle` it ran in a new instance 37 of 37 times.

**`getAlarm()` while held.** Before we did anything to them, we read held alarms 393 times. All 393
returned the overdue time, up to 56.1 s past it. After a `put`, 207 more reads all returned it too.

**What gets it run**, each called 4 s after the alarm's time:

| call on a held alarm | run 1 | run 2 |
|---|---|---|
| `setAlarm(now + 1 ms)` | 26 of 26 ran 14–290 ms later, median 45 ms | 15 of 15 ran 23–559 ms later, median 63 ms |
| `setAlarm(t)`, `t` = what `getAlarm()` returned | 22 of 22 ran 8–126 ms later, median 39 ms | 14 of 14 ran 16–101 ms later, median 45 ms |
| `storage.put()` of another key | 8 of 8 not helped | 13 of 13 not helped |
| `getAlarm()` every 5 s | not helped (`wait`) | not helped |

The `put` alarms ran 18.8–58.4 s late, at the same three delays. Before 13:00 UTC in run 1, the
Worker also wrote a storage key in the `rearm` and `same` calls: 16 of the 26 `rearm` rows and 14
of the 22 `same` rows. With the current code only (run 1 from 13:00, and run 2):
`setAlarm(now + 1 ms)` 25 of 25, 14–559 ms, median 61 ms; `setAlarm(t)` 22 of 22, 8–101 ms,
median 40 ms. Workers Logs shows the invocation after `setAlarm(t)` scheduled for the time of the
call, not `t`: #2924's stored time was 13:06:14.151, and its invocation shows 13:06:18.

**Where.** The rate depends on the location hint (`move`, both runs):

| location hint | held |
|---|---|
| none (LHR, AMS) | 46 of 16,113 (0.29%) |
| `weur` | 2 of 2,013 (0.10%) |
| `eeur` | 7 of 2,014 (0.35%) |
| `enam` | 35 of 3,663 (0.96%) |
| `wnam` | 41 of 3,660 (1.12%) |
| `apac` | 44 of 3,655 (1.20%) |

The held objects ran in 22 colos, most in LHR (38), SIN, SJC (12 each), DFW, NRT (11 each), AMS
and KIX (10 each).

The location mostly stands for the time between the two `setAlarm()` calls. The Worker making
both calls runs near the laptop, so an object far away gets its second call later: median 61 ms
after the first for alarms that ran on time, 190 ms for held ones. The rate rises with that time,
and it does so within one location too:

| time between the two `setAlarm()` calls | held, all | held, no hint (LHR, AMS) |
|---|---|---|
| under 50 ms | 24 of 13,909 (0.17%) | 24 of 12,313 (0.19%) |
| 50–100 ms | 10 of 4,004 (0.25%) | 3 of 2,123 (0.14%) |
| 100–200 ms | 65 of 7,432 (0.87%) | 10 of 1,096 (0.91%) |
| 200–500 ms | 67 of 5,266 (1.27%) | 6 of 370 (1.62%) |
| 500 ms and more | 9 of 507 (1.78%) | 3 of 211 (1.42%) |

**What changes the rate.** After the two runs we made five shorter checks against the same Worker,
with the code in this repo (14:09–14:30 UTC; checks A–E in the file):

| check | first `setAlarm()` | wait between the calls | hints | `move` trials | held | how late the held ones ran |
|---|---|---|---|---|---|---|
| A, the README's command | +60 s | none | `enam,wnam,apac` | 465 | 6 (1.3%) | 2 at 18.9 s, 2 at 38.9–39.1 s, 2 re-armed |
| B | +30 s | none | `enam,wnam,apac` | 3,454 | 19 (0.55%) | all 19 at the replaced time, 28.0–28.6 s |
| C | +120 s | none | `enam,wnam,apac` | 3,650 | **0** | |
| D | +60 s | 1 s | none (LHR, AMS) | 2,068 | **55 (2.66%)** | 19 at 18.6–19.5 s, 16 at 38.7–39.6 s, 20 at the replaced time, 56.5–57.5 s |
| E | +60 s | 5 s | none (LHR, AMS) | 1,415 | **40 (2.83%)** | 12 at 18.7–19.1 s, 14 at 38.6–39.9 s, 14 at the replaced time, 53.2–53.9 s |

- Without a wait, objects in LHR and AMS were held 0.19% of the time when the calls came within
  50 ms of each other. A wait of 1 s or 5 s raises that to 2.7–2.8%.
- The ~19 s and ~39 s delays stay put, counted from the alarm's own time. The third delay follows
  the replaced time wherever it is.
- Moved from +30 s, every held alarm waited for the replaced time; none ran at 19 s.
- Moved from +120 s, none was held, where +60 s held about 1% at the same locations. The first
  version of this repro held none of 1,500 moved from +15 min (below).
- In all five checks `getAlarm()` returned the overdue time on every read of a held alarm, 461 of
  461.

**Is it the repro?** We checked the ways the runner could mistake its own bugs for this.

- The alarm's time and its delivery time are both `Date.now()` inside the object: `arm()` stores
  `target` before `setAlarm(target)`, and `alarm()` reads the clock first thing. The laptop's clock
  is only used to decide when to read.
- Every route reaches the object through `idFromName` with the same name and hint. Workers Logs,
  filtered by the printed object id, shows the whole sequence on that one object.
- `retryCount` is 0 on every delivery, and no `alarm()` failed.
- All 77 re-armed alarms ran in the instance that armed them, so the reads before them reached that
  live instance.
- Each runner's object names start with its own run id, so no two runners share an object.

## Also seen, maybe a separate fault

These are not counted as held. The numbers are from runs 1 and 2.

- **`setAlarm()` slow to resolve.** In bursts, `/arm`, which returns once `await setAlarm()`
  resolves, took 5–41 s: 239 of 60,245 timed trials (LHR 118, SIN 55, AMS 41, SEA 14), about half
  of run 1's within four minutes (12:54, 13:00, 13:06 and 13:16 UTC). 15 `/arm` calls returned
  500, 11 of them after 30–40 s. For 9 of those in run 1, Workers Logs shows the RPC call to the
  object ending with `exceededWallTime` after 30.0–36.4 s.
- **Late without being held.** 117 alarms (86 `single`, 31 `move`) ran 1.0–27.5 s late without
  being held: 111 had run by our first read, 74 came with an `/arm` slower than 5 s, and 102 were
  in LHR. In the other 6 our first read found `alarm()` not yet run and `getAlarm()` null, and the
  alarm ran as that read arrived: #1870, #433, #6449, #6471, #6835 and #10640 in the file. Workers
  Logs shows each of those invocations starting within 1 s of its time and taking 5.1–9.1 s.
- **A `canceled` alarm after the real one.** In run 2, 211 of 20,845 objects (both shapes, none of
  them held) show a second alarm invocation in Workers Logs, with outcome `canceled` and scheduled
  for the object's own time, up to 7 s after the one that ran.
- **The replaced time fires after the alarm ran.** #2548 (run 2, `apac`, KIX,
  `07534a4c05203bc5493c3d9974df258fb97a37f2a2182b361b97ac09fec384d0`) was due 13:42:52.029, held,
  and ran 24.3 s late in a new instance. Then at 13:43:50.247 an alarm invocation scheduled for
  13:43:50, the replaced +60 s time, ran with outcome `canceled`. The replaced time was still
  registered after the alarm had run.

## How we found it

We run a platform on Workers whose actors are Durable Objects. An actor arms short deadlines with
`setAlarm()`. Often it already has a housekeeping alarm about a minute out, so the deadline moves
the alarm earlier. From 2026-09-21 our end-to-end tests began failing because a deadline ran 15–60 s
late: 7 of 124 CI jobs between 2026-09-23 20:00 and 09-24 04:00 UTC.

With every `setAlarm()` logged, each failure looked the same: of 6, 4 ran 36–39 s late at their
own time and 2 ran only at the replaced +60 s time. In one, on 2026-09-24, on object
`38f83277274e53ad05ac41ac869f41dcf99e1d77528f865fba91c97f7b00eeea`, the alarm was set to +15 min
and then +60 s at 09:20:11.796, and moved to 09:20:13.805 at 09:20:12.305. At 09:20:42.298,
`getAlarm()` returned 09:20:13.805 and no alarm had run. The next invocation ran at 09:21:11.822,
scheduled for 09:21:11, the replaced time, in a new incarnation.

A first plain-Worker version of this repro (Worker `alarm-move-earlier-repro`, same account, 50
objects at a time) measured on 2026-09-24:

| sequence | alarms | not run 3 s after its time | how late |
|---|---|---|---|
| +60 s, then +1.5 s | 1,000 | 2 | 39.7 s, 39.0 s |
| +60 s, then +1.5 s | 1,500 | 1 | 6.6 s |
| +1.5 s only | 1,500 | 1 | 11.8 s |
| +15 min, then +1.5 s | 1,500 | 0 | |

- `f05ccfb77ccf84a1ce9cc2c745e000aed368a7ff03ef173be8bcc1cffab011bc` 09:41:45.264 → 09:42:24.925
- `2fd08fe25a782eef46a9d812706db3cc7ba49203e29e347ca99856ff2cf4a395` 09:42:39.987 → 09:43:19.035
- `f83a1e6e6e8a9b61167dbc9c8073c84fb86d7089450eeb2e8ea7150023ea8540` 09:45:32.150 → 09:45:43.971 (+1.5 s only)
- `cbc6c0b55c57ac3b8992124378dd39d88e32d4ccaddf027a13323c9e4e88d48f` 09:45:36.258 → 09:45:42.833

The last two ran 1.1 s apart and were already running when read, so they may be the "late without
being held" case above. That version did not tell the two apart.

Once, in our own Worker, re-arming did not help. At 2026-09-24 10:03:34 UTC, on object
`38dbb6504ec5da84265e20a6823b59e7f3a1bb617f99f2e5e8a8da5f3e1853c1`, three `setAlarm(Date.now())`
calls 5 s apart were never delivered, and the held alarm ran 28.8 s late in a new incarnation. In
this repro all 77 `setAlarm()` calls on a held alarm worked.

## Questions for Cloudflare

1. **Why is a stored alarm not run?** After `setAlarm()` moves an alarm earlier, it is sometimes
   not run at its time. It then runs about 19 or 39 s after its own time, whatever the wait between
   the calls, or only at the time it replaced; moved from +30 s, always at the replaced time. What
   holds it, what runs on that ~19.5 s cycle, and why does the replaced time still fire, even after
   the alarm has run (#2548)?
2. **Does `getAlarm()` show the scheduler's state?** While an alarm is held, `getAlarm()` returns
   its time, overdue, on every read (854 of 854 in the runs and checks, up to 56 s past it). Is
   that value only the object's stored copy, which can disagree with what is scheduled? And why
   does any `setAlarm()`, even with the stored time, get a held alarm run within ~100 ms, while a
   storage write does not?
3. **Is moving the alarm earlier the trigger?** 175 of 31,127 moved alarms were held and 0 of
   31,127 set once. Moved from +30 s or +60 s, 0.5–2.8% were held; from +120 s, 0 of 3,650; from
   +15 min, 0 of 1,500. The rate rises with the time between the two calls, from 0.19% under 50 ms
   to 2.7% with a 1 s wait. Is there a window after the first `setAlarm()` in which moving the
   alarm earlier updates storage but not the scheduler, and does it apply only when the first
   alarm is due within about two minutes?
