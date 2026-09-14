# AZ segment script — gray to black: brownout, power interruption, zonal shift

The on-stage narrative beats (F9 / Q5b: written script, no recording). Operator mechanics
live in the runbook §4b; this is what you *say* while doing them. Total time ~10 minutes.
Runs in the **primary region** with the load generator on.

Every claim below is either visible on a cockpit chart while you say it, or it is not in
the script. Do not narrate a number a chart is not currently showing. The AZ story is **one
chart, one badge and three tiles**: the chart is **client-perceived availability by AZ**
(the share of that zone's requests that were non-error *and* answered within 2 seconds), the
badge is the load balancer's **target health**, and the tiles are **client p90 per zone**.
The chart is the only thing called "availability", and it is deliberately the *customer's*
definition of it — the wording below depends on that distinction.

---

## Beat 1 — the setup (card at steady state)

> "Earlier we broke a whole region and let ARC Region Switch move us. But most bad days
> aren't a region — they're one Availability Zone. And the hard ones aren't even a *dead*
> zone — they're a *slow* one. So here's the chart that matters: **for each zone, the share
> of customers who got a working answer within two seconds.** Three zones, all at a hundred
> percent. Above it, the load balancer's own verdict: three of three zones healthy. And the
> p90 tiles, around 95 milliseconds. Watch those two disagree."

Point at the three flat lines, the green 3 / 3 badge, and the three baseline tiles.

## Beat 2 — the hidden-severity beat (start `latency-single-az`, ~3 min, then stop it)

> "First, the failure your monitoring is worst at seeing. I'm injecting 400 milliseconds of
> network latency into one zone's *database* path."

Let it run ~3 minutes. Point at the aggregate availability chart holding, the badge still
reading 3 / 3 healthy, and then the faulted zone's line on the per-AZ chart.

> "Error rate: zero. Every health check: green. Nothing has paged, and nothing is going to.
> Now the customer's view of that same zone — **twenty-three percent**. Its p90 is about
> five seconds. Four hundred milliseconds on the database path becomes five seconds at the
> customer, because one request crosses that path a dozen times. So: the app never *failed*
> anything. It just made three quarters of that zone's customers wait. **Our error rate said
> we were fine.**"

Stop the fault.

*(Measured 2026-09-04: 22.7% on the faulted zone, ~4.9 s p90, zero errors, 3/3 targets
healthy. If you need the old "the app shrugs this off" contrast beat, it needs a milder
fault than anything currently deployed — 10% packet loss, which TCP retransmission absorbs
entirely. Do not use the 25% one; it reads 64.3%.)*

## Beat 3 — the gray beat (arm, then start `brownout-single-az`)

> "This is a **brownout**: eight hundred milliseconds of latency, plus or minus four
> hundred, on one zone's path to the load balancer itself — not the database. Health checks and
> client responses both ride that path. And I don't pick the zone: the cockpit picks the
> busiest one, because degrading an idle zone would show you nothing."

Arm, then type the fault name to confirm. Watch the faulted zone's line start to sag.

## Beat 4 — the dashboards argue (wait ~2–3 min)

> "There's the gray. That zone's p90 went from 95 milliseconds to about **two and a
> quarter seconds** — the request pays the toll roughly three times over — and a third of
> its customers are now outside two seconds. Sixty-six percent. Now look up: the load
> balancer still says **three of three zones healthy**. It isn't wrong, and it isn't lying —
> it measures *one* hop of that journey, so its probe comes back in about a second and
> passes, every single time. Same two-second bar, opposite verdicts. Error rate is still
> zero. Nothing is down. Nothing will page. **This is the day your dashboards argue with
> each other** — and someone has to make a call."

## Beat 5 — the judgment call (start the shift)

> "Here's what makes it a call: **nothing is going to do this for me.** The zone is
> healthy by every automated signal, so it will not be removed — clients keep landing on
> it and keep waiting, indefinitely. The ARC **zonal shift** is how I take it out on
> purpose: stop routing there, full stop, until I say otherwise — and it's self-expiring,
> so if I walk away it undoes itself. To confirm, I type the name of the zone the fault is
> actually degrading — the cockpit derives it from the running experiment, so I can't shift
> away from the wrong zone."

Type the AZ name. Watch the faulted zone's line go quiet:

> "Its line goes *quiet* — no data, because nobody's being served there anymore. That's the
> shift working. And the badge still says three of three healthy, because the checks are
> still probing it — still sick, just no longer in the path."

Stop the fault; the shift auto-cancels with it, and the line returns to 100%.

## Beat 6 — the black beat (start `power-interruption-single-az`)

> "Now the day that *does* page. This one is modeled on a real AZ power interruption: it
> stops every one of this app's instances in one zone, blocks the autoscalers from
> replacing them *in that zone*, and blackholes the zone's network for the first two
> minutes. Expect everything to wobble in those two minutes — that's the blackhole
> hitting the health-check plumbing itself, exactly what a real power event does — and
> then watch it settle: **the badge drops to two of three, and that zone's line stops
> reporting at all.** No data, because there's nobody left there to serve anyone. And the
> pods hold the dead node for the full window, so it stays that way for fifteen minutes
> instead of quietly disappearing."

## Beat 7 — control, not recovery (~60–90s in)

> "Now watch the aggregate — because it recovers *on its own*, in about a minute, and I
> haven't touched anything. Cross-zone routing stops sending to failed targets as soon as
> the checks fail. So why shift at all? Because 'the load balancer probably worked around
> it' is not an operating posture. The shift is my **control move, not the recovery
> mechanism**: deterministic, auditable, self-expiring — it's the difference between an
> incident that *happened to* resolve and one that was *handled*. And you already saw
> the day that difference matters: the gray day, where nothing was down and the shift
> was the only thing that would take that zone out at all."

Start the shift — typed zone name, expiry countdown on the tile.

## Beat 8 — the cleanup (stop the fault)

> "When I stop the fault, the cockpit cancels the shift with it — a mitigation shouldn't
> outlive the thing it mitigates. Power comes back, the instances restart, the targets
> re-register, and the line climbs back to 100."

Stop. Show the line returning.

## The one-sentence close

> "Region switch for a region problem, zonal shift for a zone problem — and the zone
> problems that matter are the gray ones, where nothing is down, the dashboards disagree,
> and the shift is how an operator takes *control* instead of waiting to get lucky."

---

## If it goes sideways on stage

- **AZ controls disabled, reason says traffic is elsewhere** — you're not in the primary.
  This segment does not run from the standby; say so and fall back to the region-wide story.
- **Fault start refused: no eligible AZ** — the loadgen is off or warming. Start it, fill
  ~2 minutes on the per-AZ chart mechanics, retry.
- **Fault dies seconds in: "Target resolution returned empty set"** — the busiest AZ
  holds no *armed* instance. Re-arm (it should report all five nodes) and retry.
- **Brownout runs and the zone's line does NOT sag** — check the p90 tile first. The sag is
  defined as "outside 2 seconds", so a zone whose p90 sits under 2 s produces none by
  arithmetic. If the tile is climbing but the line is flat, the SLO classifier is not
  emitting — fall back to narrating the tile. Do **not** wait for target health to move:
  it never does at this severity, by design (the check pays one hop and passes). After the
  session, read the real target-group health-check settings back — the calibration assumes
  the live 2 s HTTP timeout and ~2.8× client amplification.
- **All lines wobble hard for ~2 minutes right at power-fault start** — the subnet
  blackhole; it's in the script (Beat 6). Narrate it, never apologize for it.
- **Aggregate dips hard for ~2 minutes at power-fault start** — the blackhole caught the
  Aurora writer's AZ, and Aurora is failing over to a reader in another zone. A real power
  event would do the same; narrate it ("the zone's network just vanished — even the database
  felt that"). If instead the aggregate goes to **zero** and FIS halts the experiment, the
  cluster has lost its multi-AZ spread — check
  `aws rds describe-db-instances --query 'DBInstances[].[DBInstanceIdentifier,AvailabilityZone]'`
  and stop the segment; that is the 2026-09-04 single-instance failure, not a demo beat.
  Either way, expect writes to need `build/restore-steady-state.sh --execute` afterwards:
  a writer failover is exactly the trigger for the planted connection-pool defect.
- **Shift start 409s "not opted into zonal shift"** — the Service migration didn't land;
  the post-deploy verifier should have caught this. Skip the shift beats, narrate what the
  shift *would* do, and file it.
- **One AZ line missing at steady state** — that zone has no registered target; check the
  pod spread (`kubectl get pods -o wide`) before blaming the chart.
