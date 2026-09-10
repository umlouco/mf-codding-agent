# Verification LLM-interaction budget

`mfagent.queue.verificationMaxInteractions` defaults to **4** (minimum 1).
It limits LLM request/response exchanges for one task, shared across independent
verification passes. It is **not** a duration, token, tool-call, or stream-chunk
limit. A slow response may take as long as needed.

Each response-only plan, correction of a rejected plan, and report consumes one
interaction. Each vision-backed layout check also consumes one interaction.
Ordinary host tools, heartbeat events, and reasoning/text chunks do not consume
interactions. Existing tool-specific execution deadlines and dead-worker silence
detection are unchanged. There are no new verifier/supervisor wall-clock limits.

The queue atomically reserves an interaction before dispatch, recording its
ordinal and purpose in the task journal. Reservations are retained across
reverification, failed requests, pause/resume, and reload; those cannot replenish
the budget. A standalone verification call has an equivalent in-memory budget.
The existing limits on verification passes and supervisor tool rounds still apply
as separate safeguards; supervisor decisions are not verifier interactions.

An admitted final interaction may finish and establish PASS. If the budget is
exhausted without a current host-backed passing report, the supervisor requests
decomposition immediately instead of spending another verification interaction.
Completed tool receipts, partial plans, and implementation handoffs are retained.
Replacement planning uses its existing separate bounded allowance.

The existing split transaction archives the original requirements and evidence,
creates all smaller ordered tasks, and deletes the original executable task.
A rejected/failed replacement leaves the original non-runnable decomposition
obligation intact; it never deletes the only copy of the task's evidence.

Run regression tests without model calls:

```sh
node --test scripts/verification-budget.test.cjs
```
