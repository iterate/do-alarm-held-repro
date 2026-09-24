# Durable Object alarm held past its time while getAlarm() reports it

**When you run this you expect every Durable Object alarm to run within a few milliseconds of its
time. Sometimes it runs 19, 39 or 58 s late, and all that time `ctx.storage.getAlarm()` returns the
overdue time. Calling `setAlarm()` again gets it delivered, typically within 50 ms, even with the
time that is already stored.**

`src/index.js` is the whole Worker: one SQLite-backed Durable Object class, `Probe`, and a fresh
object per trial. A trial arms the alarm in one of two shapes:

- `move`: `setAlarm(now + 60 s)`, then `setAlarm(now + 1.5 s)` in a second RPC call from the same
  request. The alarm moves earlier.
- `single`: `setAlarm(now + 1.5 s)` only.

`alarm()` stores `Date.now()` and the object's instance id, a random value minted in the
constructor, so a new incarnation shows. `run.mjs` reads the object 4 s after the alarm's time. An
alarm not delivered by then is **held**, and the runner takes turns among five things to do with it:

| | |
|---|---|
| `wait` | read `getAlarm()` every 5 s until `alarm()` runs |
| `idle` | leave the object alone until +120 s |
| `rearm` | `setAlarm(now + 1 ms)`, a different time |
| `same` | `setAlarm(t)`, with the `t` that `getAlarm()` returned |
| `put` | `storage.put()` of an unrelated key, no `setAlarm()` |

Expected, every trial (real lines):

```
2026-09-24T13:04:25.785Z move   #2036  -    66ada0ef85875888  delivered +0 ms
2026-09-24T13:04:25.873Z single #2037  -    345abf69a9995d62  delivered +0 ms
```

The columns are the alarm's time, the shape, the trial, the location hint, the object id, and how
late `alarm()` ran.

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
node run.mjs --url https://do-alarm-held-repro.<subdomain>.workers.dev --minutes 10
node run.mjs --url https://do-alarm-held-repro.<subdomain>.workers.dev --minutes 10 --hints enam,wnam,apac
```

It prints one line per trial and then a summary, and writes every reading to
`results-<run>.jsonl`. `node run.mjs --summarize a.jsonl,b.jsonl` prints the summary again. With the
default 50 trials in flight a runner does about 470 trials a minute. A trial is three to five
requests and one alarm. The runs with location hints saw their first held alarm within 20 s, and
the runs without hints within 3 minutes. Options are at the top of `run.mjs`.

## What we saw

2026-09-24, 12:35–13:20 UTC, 43 minutes of trials, from a laptop in London. Two runners went side by
side: one without location hints (its objects ran in LHR and AMS) and one rotating
`enam,wnam,weur,eeur,apac`. [`observed-2026-09-24.txt`](observed-2026-09-24.txt) is the runner's
summary of all of it, with every held and late line.

| shape | trials | held (not delivered 4 s after its time) |
|---|---|---|
| `move` (+60 s, then +1.5 s) | 20,702 | **107** (0.52%) |
| `single` (+1.5 s) | 20,703 | 1 |

Over the 20,640 `move` alarms we did not re-arm, lateness was p50 0 ms, p99 5 ms, p99.9 39.1 s and
max 58.5 s.

**How late.** The 59 held alarms we did not re-arm (`wait`, `idle`, `put`) ran at three delays:

| ran after its time | alarms | scheduled time of that invocation in Workers Logs |
|---|---|---|
| 18.7–19.5 s | 22 | its own |
| 38.6–39.7 s | 17 | its own |
| 57.6–58.5 s | 19 | the replaced +60 s time; `alarm()` ran 0–4 ms after it |
| 5.9 s | 1 | its own; our read found a new instance, and the alarm ran as it started (#1870, MIA) |

Every held object shows exactly one alarm invocation in Workers Logs. With `wait` (a read every
5 s) the alarm ran in the same instance 27 of 28 times. With `idle` it ran in a new instance 23 of
23 times.

The rate depends on where the object is (`move` trials):

| location hint | trials | held |
|---|---|---|
| none (LHR, AMS) | 10,631 | 32 (0.30%) |
| `enam` | 2,015 | 20 (0.99%) |
| `wnam` | 2,013 | 23 (1.14%) |
| `apac` | 2,010 | 23 (1.14%) |
| `weur` | 2,013 | 2 (0.10%) |
| `eeur` | 2,014 | 7 (0.35%) |

The held objects ran in 22 colos, most in LHR 24, AMS 10, NRT 8, IAD 6, SJC 6 and SIN 6.

**getAlarm() while held.** We read held alarms 250 times before doing anything to them. 249 reads
returned the overdue time, up to 56.1 s past it. The other one is #1870 above, whose read arrived
as the alarm ran and returned null. After a `put`, 83 more reads all returned the overdue time.

**What gets it delivered**, called 4 s after the alarm's time:

| call on a held alarm | result |
|---|---|
| `setAlarm(now + 1 ms)` | 26 of 26 ran 14–290 ms later, median 45 ms |
| `setAlarm(t)`, `t` = what `getAlarm()` returned | 22 of 22 ran 8–126 ms later, median 39 ms |
| `storage.put()` of another key | 8 of 8 not helped: they ran 14.5–54.3 s later, at the 19/39/58 s delays |
| `getAlarm()` every 5 s | not helped (the `wait` rows above) |

Before 13:00 UTC, `same` also wrote a storage key in the same call. That covers 14 of its 22 rows.
From 13:00 it is `setAlarm(t)` alone: 8 of 8 ran 8–51 ms later. Workers Logs shows the invocation
after `setAlarm(t)` scheduled for the time of the call, not `t`: #2924's stored time was
13:06:14.151, and its invocation shows 13:06:18.

**The one held `single`.** #433 (LHR, 13:01:11.968) is like #1870. Our read at +7.5 s found a new
instance, `getAlarm()` returned null, and the alarm ran at that moment. It fell inside a burst of the
slow `setAlarm()` calls described next.

**Also seen: `setAlarm()` slow to resolve.** In bursts, `/arm`, which returns once
`await setAlarm()` resolves, took 5–41 s. That happened in 188 of 39,400 timed trials: 113 on
objects in LHR, 36 in AMS and 25 in SIN, about half of them within four minutes (12:54, 13:00, 13:06
and 13:16 UTC). Nine more `/arm` calls returned 500: Workers Logs shows their RPC call to the object
ending with `exceededWallTime` after 30–36 s. Separately from the held ones, 104 alarms ran
1.0–27.5 s late but before our first read, so we could not read `getAlarm()` in between. The runner
prints them as `LATE`, not `HELD`. 73 of them came with an `/arm` slower than 5 s, and 9 are from
the first two minutes, before the runner timed `/arm`. Of the 95 with a colo reading, 93 were in
LHR. We don't know whether this is the same fault.

## First seen

In our own Worker from 2026-09-21. Between 2026-09-23 20:00 and 09-24 04:00 UTC, 7 of 124 CI
end-to-end jobs failed because an alarm ran 15–60 s late. The alarm had usually just been moved
earlier from about a minute out. A first plain-Worker version of this repro (Worker
`alarm-move-earlier-repro`, same account, 50 objects at a time) measured on 2026-09-24:

| sequence | alarms | held > 3 s | how late |
|---|---|---|---|
| +60 s, then +1.5 s | 1,000 | 2 | 39.7 s, 39.0 s |
| +60 s, then +1.5 s | 1,500 | 1 | 6.6 s |
| +1.5 s only | 1,500 | 1 | 11.8 s |
| +15 min, then +1.5 s | 1,500 | 0 | |

- `f05ccfb77ccf84a1ce9cc2c745e000aed368a7ff03ef173be8bcc1cffab011bc` 09:41:45.264 → 09:42:24.925
- `2fd08fe25a782eef46a9d812706db3cc7ba49203e29e347ca99856ff2cf4a395` 09:42:39.987 → 09:43:19.035
- `f83a1e6e6e8a9b61167dbc9c8073c84fb86d7089450eeb2e8ea7150023ea8540` 09:45:32.150 → 09:45:43.971 (+1.5 s only)
- `cbc6c0b55c57ac3b8992124378dd39d88e32d4ccaddf027a13323c9e4e88d48f` 09:45:36.258 → 09:45:42.833

In our own Worker a re-arm once failed to help. At 2026-09-24 10:03:34 UTC, on object
`38dbb6504ec5da84265e20a6823b59e7f3a1bb617f99f2e5e8a8da5f3e1853c1`, three `setAlarm(now)` calls
5 s apart were never delivered. The held alarm ran 28.8 s late, in a new incarnation. Here all 48
`setAlarm()` calls on a held alarm worked.

## Questions for Cloudflare

1. After `setAlarm()` moves an armed alarm earlier, why is it sometimes not run at its time while
   `getAlarm()` keeps returning that time? It then runs about 19 or 39 s late, or at the time it
   replaced. What runs on a ~20 s cycle, and why does the replaced time still fire?
2. Why does a second `setAlarm()`, even with the time already stored, deliver it within ~50 ms,
   while a storage write without `setAlarm()` does not?
3. Why are objects in North America and Asia held about 1% of the time, and those in western
   Europe 0.1–0.3%?
4. Is `setAlarm()` taking 5–41 s in LHR, AMS and SIN, with RPC calls hitting the 30 s wall-time
   limit, the same fault?
