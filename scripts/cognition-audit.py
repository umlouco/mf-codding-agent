#!/usr/bin/env python3
"""Independently audit a cognition journal without executing tools or writing SQL.

Usage: python scripts/cognition-audit.py --database path/to/cognition.db

Hashes cover the stored UTF-8 payload exactly, including whitespace and escapes.
This checks ledger consistency, not authenticity against someone who can rewrite
the entire database, tool correctness, recorded OS process death, or the current
state of workspace files.
"""

import argparse
import hashlib
import json
from pathlib import Path
import re
import sqlite3
import sys


HASH = re.compile(r"[0-9a-f]{64}\Z")
KINDS = {"run", "start", "finish", "sync", "orphan", "gap"}


def issue(issues, code, message, seq=None):
    item = {"code": code, "message": message}
    if seq is not None:
        item["seq"] = seq
    issues.append(item)


def integer(value):
    return type(value) is int and value >= 0


def unique_object(pairs):
    obj = {}
    for key, value in pairs:
        if key in obj:
            raise ValueError("duplicate JSON property: " + key)
        obj[key] = value
    return obj


def reject_constant(value):
    raise ValueError("non-JSON numeric constant: " + value)


def parse_object(raw):
    if not isinstance(raw, str):
        raise ValueError("expected a JSON text column")
    obj = json.loads(raw, object_pairs_hook=unique_object,
                     parse_constant=reject_constant)
    if not isinstance(obj, dict):
        raise ValueError("expected a JSON object")
    return obj


def scope_valid(scope, work_id):
    return (isinstance(scope, dict) and scope.get("workId") == work_id
            and all(isinstance(scope.get(key), str) and scope[key]
                    for key in ("workId", "observer", "runId")))


def validate_event(event, row, work_id, issues):
    seq, kind, _, _, _ = row
    errors = []
    scope = event.get("scope")
    if not isinstance(scope, dict):
        scope = {}
    if type(event.get("version")) is not int or event["version"] != 1:
        errors.append("unsupported event version")
    if not integer(event.get("seq")) or event["seq"] != seq:
        errors.append("payload sequence differs from event row")
    if kind not in KINDS or event.get("kind") != kind:
        errors.append("unknown or inconsistent event kind")
    if not scope_valid(event.get("scope"), work_id):
        errors.append("invalid scope or mismatched work identity")
    if not integer(event.get("epoch")):
        errors.append("epoch must be a nonnegative integer")
    for key in ("isError", "unknown", "concurrentMutation"):
        if key in event and type(event[key]) is not bool:
            errors.append(key + " must be boolean")
    if "excerpt" in event and not isinstance(event["excerpt"], str):
        errors.append("excerpt must be text")
    if "stateHash" in event and (not isinstance(event["stateHash"], str)
                                  or HASH.fullmatch(event["stateHash"]) is None):
        errors.append("stateHash must be a SHA-256 snapshot digest")
    ticket = event.get("ticket")
    if kind in ("start", "finish", "orphan"):
        if not isinstance(ticket, dict):
            errors.append("operation event requires a ticket")
        else:
            if not scope_valid(ticket, work_id):
                errors.append("invalid ticket scope")
            if any(ticket.get(key) != scope.get(key)
                   for key in ("workId", "observer", "runId")):
                errors.append("ticket scope differs from event scope")
            for key in ("id", "tool", "action"):
                if not isinstance(ticket.get(key), str) or not ticket[key]:
                    errors.append("ticket requires nonempty " + key)
            for key in ("callId", "summary"):
                if not isinstance(ticket.get(key), str):
                    errors.append("ticket requires text " + key)
            if type(ticket.get("mutating")) is not bool:
                errors.append("ticket mutating must be boolean")
            if "concurrentMutation" in ticket and type(ticket["concurrentMutation"]) is not bool:
                errors.append("ticket concurrentMutation must be boolean")
            if "ownerPID" in ticket and not integer(ticket["ownerPID"]):
                errors.append("ticket ownerPID must be a nonnegative integer")
            if not integer(ticket.get("epoch")):
                errors.append("ticket epoch must be a nonnegative integer")
            if not integer(ticket.get("startSeq")) or ticket["startSeq"] < 1:
                errors.append("ticket startSeq must be a positive integer")
            if kind == "start" and (ticket.get("startSeq") != seq
                                    or ticket.get("epoch") != event.get("epoch")):
                errors.append("start ticket sequence/epoch differs from event")
        if kind == "finish" and (not isinstance(event.get("digest"), str)
                                 or HASH.fullmatch(event["digest"]) is None):
            errors.append("finish requires a SHA-256 output digest")
    elif ticket is not None:
        errors.append("non-operation event contains a ticket")
    if errors:
        issue(issues, "event_schema", "; ".join(errors), seq)
    return not errors


def audit_work(db, work_id, clock_epoch, index_tables):
    result = {"workId": work_id, "ok": True, "events": 0,
              "starts": 0, "finishes": 0, "orphans": 0, "recordingGaps": 0, "pending": 0,
              "interrupted": 0, "unknownOutcomes": 0,
              "checkedIndexes": sorted(index_tables), "issues": []}
    issues = result["issues"]
    prior_hash, last_seq, last_epoch = "", 0, 0
    last_state_hash = None
    last_gap_seq = 0
    starts, finished, pending, interrupted = {}, set(), {}, set()
    orphaned = set()
    receipts = {}
    for row in db.execute(
            "SELECT seq,kind,prev_hash,hash,payload FROM cognition_events "
            "WHERE work_id=? ORDER BY seq", (work_id,)):
        seq, kind, prev_hash, stored_hash, raw = row
        result["events"] += 1
        if not integer(seq) or seq != last_seq + 1:
            issue(issues, "sequence", "expected sequence " + str(last_seq + 1), seq)
        if prev_hash != prior_hash:
            issue(issues, "chain_link", "previous hash does not match preceding event", seq)
        if not isinstance(stored_hash, str) or HASH.fullmatch(stored_hash) is None:
            issue(issues, "hash_format", "event hash is not lowercase SHA-256", seq)
        try:
            if not isinstance(prev_hash, str) or not isinstance(raw, str):
                raise ValueError("hash inputs must be text")
            expected_hash = hashlib.sha256((prev_hash + "\n" + raw).encode("utf-8")).hexdigest()
            if expected_hash != stored_hash:
                issue(issues, "payload_hash", "stored payload does not match its hash", seq)
            event = parse_object(raw)
        except (ValueError, UnicodeError, RecursionError) as exc:
            issue(issues, "payload_json", str(exc), seq)
            event = None
        prior_hash = stored_hash
        last_seq = seq if integer(seq) else last_seq
        if event is None or not validate_event(event, row, work_id, issues):
            continue
        last_state_hash = event.get("stateHash")
        if event["epoch"] < last_epoch:
            issue(issues, "epoch", "event epoch moved backwards", seq)
        if kind == "gap" and event["epoch"] <= last_epoch:
            issue(issues, "epoch", "recording gap must advance the workspace epoch", seq)
        if clock_epoch is not None and event["epoch"] > clock_epoch:
            issue(issues, "epoch", "event epoch exceeds workspace clock", seq)
        last_epoch = event["epoch"]
        if kind == "gap":
            result["recordingGaps"] += 1
            last_gap_seq = seq
        elif kind == "run":
            for op_id, ticket in list(pending.items()):
                if (ticket["observer"] == event["scope"]["observer"]
                        and ticket["runId"] != event["scope"]["runId"]):
                    interrupted.add(op_id)
                    del pending[op_id]
        elif kind == "start":
            result["starts"] += 1
            ticket = event["ticket"]
            op_id = ticket["id"]
            if op_id in starts:
                issue(issues, "duplicate_start", "operation ID was already started", seq)
            else:
                starts[op_id] = ticket
                pending[op_id] = ticket
        elif kind == "finish":
            result["finishes"] += 1
            ticket = event["ticket"]
            op_id = ticket["id"]
            if op_id not in starts:
                issue(issues, "missing_start", "finish has no preceding start", seq)
            elif starts[op_id] != ticket:
                issue(issues, "ticket_mismatch", "finish ticket differs from persisted start", seq)
            if op_id in finished:
                issue(issues, "duplicate_finish", "operation was already finished", seq)
            finished.add(op_id)
            receipts[op_id] = (event["digest"], seq)
            pending.pop(op_id, None)
        elif kind == "orphan":
            result["orphans"] += 1
            ticket = event["ticket"]
            op_id = ticket["id"]
            if op_id not in starts:
                issue(issues, "missing_start", "orphan has no preceding start", seq)
            elif starts[op_id] != ticket:
                issue(issues, "ticket_mismatch", "orphan ticket differs from persisted start", seq)
            if op_id in finished:
                issue(issues, "orphan_after_finish", "completed operation cannot become orphaned", seq)
            if op_id in orphaned:
                issue(issues, "duplicate_orphan", "operation was already recorded as orphaned", seq)
            orphaned.add(op_id)
            interrupted.add(op_id)
            pending.pop(op_id, None)

    result["pending"] = len(pending)
    result["interrupted"] = len(interrupted - finished)
    result["unknownOutcomes"] = len(starts.keys() - finished)
    result["hasUncertainty"] = result["unknownOutcomes"] > 0 or result["recordingGaps"] > 0
    result["headSeq"] = last_seq
    result["headHash"] = prior_hash if isinstance(prior_hash, str) else None
    snapshot = db.execute(
        "SELECT seq,head_hash,state_json FROM cognition_state WHERE work_id=?",
        (work_id,)).fetchone()
    if snapshot is None:
        issue(issues, "missing_snapshot", "work journal has no materialized state")
    else:
        state_seq, state_hash, state_raw = snapshot
        if state_seq != last_seq or state_hash != prior_hash:
            issue(issues, "snapshot_head", "snapshot does not reference the latest journal event")
        try:
            state = parse_object(state_raw)
            if (last_state_hash is not None
                    and hashlib.sha256(state_raw.encode("utf-8")).hexdigest() != last_state_hash):
                issue(issues, "snapshot_hash", "snapshot content differs from the journal's stateHash")
            if type(state.get("version")) is not int or state["version"] != 1:
                issue(issues, "snapshot_version", "unsupported snapshot version")
            if not integer(state.get("seq")) or state["seq"] != state_seq:
                issue(issues, "snapshot_sequence", "snapshot JSON sequence differs from row")
            if not integer(state.get("epoch")) or state["epoch"] != last_epoch:
                issue(issues, "snapshot_epoch", "snapshot epoch differs from journal")
            if state.get("pending") != pending:
                issue(issues, "snapshot_pending", "snapshot pending tickets differ from journal")
            if (not integer(state.get("lastGapSeq", 0))
                    or state.get("lastGapSeq", 0) != last_gap_seq):
                issue(issues, "snapshot_gap", "snapshot lastGapSeq differs from the latest recording gap")
        except (ValueError, UnicodeError, RecursionError) as exc:
            issue(issues, "snapshot_json", str(exc))
    if "cognition_active" in index_tables:
        expected = sorted((op_id, ticket["observer"], ticket["runId"])
                          for op_id, ticket in starts.items()
                          if ticket["mutating"] and op_id not in finished and op_id not in orphaned)
        actual = list(db.execute(
            "SELECT op_id,observer,run_id FROM cognition_active WHERE work_id=? ORDER BY op_id",
            (work_id,)))
        if actual != expected:
            issue(issues, "active_index", "active mutation index differs from journal "
                  "(expected " + str(len(expected)) + " rows, found " + str(len(actual)) + ")")
    if "cognition_receipts" in index_tables:
        expected = sorted((op_id, digest, seq) for op_id, (digest, seq) in receipts.items())
        actual = list(db.execute(
            "SELECT op_id,digest,seq FROM cognition_receipts WHERE work_id=? ORDER BY op_id",
            (work_id,)))
        if actual != expected:
            issue(issues, "receipt_index", "receipt index differs from journal "
                  "(expected " + str(len(expected)) + " rows, found " + str(len(actual)) + ")")
    result["ok"] = not issues
    return result


def audit_database(database, work_id=None):
    path = Path(database).expanduser().resolve()
    report = {"database": str(path), "ok": False, "works": [], "issues": [],
              "checkedIndexes": [], "hasUncertainty": False,
              "assurance": "Ledger consistency only; does not establish tool correctness, "
                           "task completion, recorded OS process death, current file freshness, "
                           "or resistance to a full ledger rewrite."}
    if not path.is_file():
        issue(report["issues"], "database_missing", "database file does not exist")
        return report
    try:
        # Keep one read transaction so a live writer cannot move the snapshot
        # between reading events and materialized state. mode=ro prevents writes
        # to the database; query_only also rejects accidental mutation statements.
        db = sqlite3.connect(path.as_uri() + "?mode=ro", uri=True)
        try:
            db.execute("PRAGMA query_only=ON")
            db.execute("BEGIN")
            clocks = db.execute("SELECT id,epoch FROM cognition_clock").fetchall()
            clock_epoch = None
            if len(clocks) != 1 or clocks[0][0] != 1 or not integer(clocks[0][1]):
                issue(report["issues"], "clock_schema", "expected one nonnegative workspace clock at id=1")
            else:
                clock_epoch = clocks[0][1]
            index_tables = {row[0] for row in db.execute(
                "SELECT name FROM sqlite_master WHERE type='table' "
                "AND name IN ('cognition_active','cognition_receipts')")}
            report["checkedIndexes"] = sorted(index_tables)
            query = "SELECT work_id FROM cognition_events UNION SELECT work_id FROM cognition_state"
            if "cognition_active" in index_tables:
                query += " UNION SELECT work_id FROM cognition_active"
            if "cognition_receipts" in index_tables:
                query += " UNION SELECT work_id FROM cognition_receipts"
            params = ()
            if work_id is not None:
                query = "SELECT work_id FROM (" + query + ") WHERE work_id=?"
                params = (work_id,)
            ids = [row[0] for row in db.execute(query + " ORDER BY work_id", params)]
            if work_id is not None and not ids:
                issue(report["issues"], "work_missing", "requested work identity was not found")
            for identity in ids:
                if not isinstance(identity, str) or not identity:
                    issue(report["issues"], "work_identity", "work identity must be nonempty text")
                    continue
                report["works"].append(audit_work(db, identity, clock_epoch, index_tables))
        finally:
            db.close()
    except (sqlite3.Error, OSError, ValueError, UnicodeError) as exc:
        issue(report["issues"], "database_read", str(exc))
    report["ok"] = not report["issues"] and all(work["ok"] for work in report["works"])
    report["hasUncertainty"] = any(work["hasUncertainty"] for work in report["works"])
    return report


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database", required=True, help="existing cognition SQLite database")
    parser.add_argument("--work-id", help="audit only this durable work identity")
    args = parser.parse_args(argv)
    report = audit_database(args.database, args.work_id)
    print(json.dumps(report, ensure_ascii=True, indent=2))
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
