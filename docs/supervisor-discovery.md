# Discovery before repetition

The supervisor now separates **what must be achieved** from **how work is scheduled**.
There is no project name, task number, framework extension, expected file count, or
UI-specific migration rule in the new discovery mechanism.

## Admission pipeline

1. The host indexes actual repository paths, without reading or changing application bodies.
2. The configured supervisor interprets the unchanged task, both verification contracts,
   owner context, and repository index. It chooses an atomic outcome, a population of
   independent work, or an explicit evidence gap.
3. For independent work, the model describes populations with repository-relative selectors
   and explains their relevance. The host expands every match into a durable inventory.
4. That inventory becomes prerequisite, per-unit, and final-acceptance execution tickets.
   Ticket membership is checked mechanically, not inferred from a title or a prose promise.
5. The final gate retains the original description, implementation check, behavior check,
   and command. Existing work, reports, and the original journal are archived and retained.
   A local ticket passing does not satisfy the complete objective.

The same path handles repeated changes to source modules, configuration, interfaces,
documentation, or any other population the supervisor discovers. A shared atomic fix
can remain one task. Discovery selects the units; runtime code does not guess the language.
Child ticket metadata accompanies executor, verifier, requirements, and progress prompts.
Global acceptance remains at the final gate rather than being redundantly assigned as a
new implementation demand to every ticket.

## Recovery is durable and finite

- Completed tool outcomes have content fingerprints independent of timing. Full inputs and
  outputs are fingerprinted before the readable journal excerpt is truncated.
- Recovery pages the durable worker-tool journal. Heartbeats, supervisor inspections,
  thinking, and repeated reads cannot manufacture new evidence or hide a tool start.
- New tool results and potentially mutating/test tool starts still fence stale decisions.
- Three unchanged recovery requests, six total recovery requests on unfinished work,
  six repeated completed outcomes, or three failed progress/verdict reviews cause a
  bounded scope re-plan. These are intervention triggers, never completion verdicts.
- If no safe replacement plan emerges, the queue pauses with work and evidence intact.
  Reloading or resetting the displayed attempt count cannot erase this state. Pressing Start
  on a paused/stopped queue archives the recovery ledger and grants a new bounded recovery
  budget without resetting tasks or changing requirements. Automatic RUNNING restoration
  does not release the latch.
- The bounded fingerprint store never evicts old observations to make a long replay look
  novel: exhausting it requires re-planning instead.
- Failed independent verification leaves the direct-validation fast path and returns to
  supervised recovery. Invalid review output cannot imply implementation success.
- Snapshot and generation checks reject late results/errors after cancellation, task edits,
  or replacement planning.

## Validation

Run `npm run typecheck` and `node --test scripts/*.test.cjs`.
The generic inventory tests use mixed-language repositories and injected model responses;
they check complete enumeration, invalid selectors, ownership, immutable final acceptance,
real scope-preflight wiring, and child boundaries. Recovery and verdict-fencing suites
exercise SQLite persistence, long/repeated evidence, retries, and asynchronous races.

The replay harness exercises the actual scope supervisor and queue split implementation
against a scratch backup of an unchanged task list, using the configured supervisor model.
It does not start implementation workers, modify the source queue, or claim the application
work has passed verification. See its report for transport and evidence limitations.
