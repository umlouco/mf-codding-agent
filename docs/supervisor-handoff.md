# Supervisor recovery after verification

## Observed incident

The verifier stopped without producing accepted evidence. The supervisor chose
`REVERIFY`, reached the verification-pass limit, and requested replacement tasks.
The replacement planner first reported a provider spend limit. After a provider
change, its connection stayed alive without returning model output. The task
remained `VERIFYING` with a generic “replacing the rejected task” message.

The existing watchdog used transport activity as its liveness signal. Regular
`model_wait` heartbeats could therefore keep a replacement-planning cycle busy
indefinitely, preventing lockstep execution from advancing.

## Fix

- Replacement planning tracks actual nonempty text/thinking separately from
  transport heartbeats. At the next supervisor tick after two minutes without
  model output (or the shorter configured worker-silence limit), the watchdog
  abandons and fences that review, even if cancellation never resolves it.
- Actual streamed output renews the idle deadline. A continuously streaming plan
  is not interrupted merely because its total runtime exceeds two minutes.
- Watchdog and provider failures share persistent backoff, measured from failure,
  and the existing maximum of three attempts for unchanged inputs.
- The task shows the planner's current activity/provider wait, then its retry
  deadline or an explicit recovery blocker. Late callbacks cannot replace this
  state, commit tasks, or release a newer review's ownership.
- Existing implementation, verification evidence, and spend accounting survive.
  No task is falsely marked verified and lockstep dependencies are not bypassed.

A provider that cannot produce a valid plan still needs remediation. The queue
must report that blocker rather than claim to be doing useful work indefinitely;
changing the configured planner/provider or relevant task inputs enables the
existing bounded recovery lane. Restarting alone does not renew exhausted spend.

## Regression tests

`node --test scripts/supervisor-handoff.test.cjs` uses the real SQLite queue and
orchestrator, with a simulated planner and controlled clock. Before implementation,
the activity-visibility and heartbeat-only-stall tests failed. The suite covers
successful retry, original-work preservation, ignored late results, real streaming
activity, bounded repeated stalls, provider errors, and accounting across reload.

The incident queue was inspected read-only; no live task or queue state was reset.
Install the rebuilt extension and reload VS Code to apply the runtime fix.
