#!/usr/bin/env python3
"""Run with: python scripts/cognition-audit.test.py"""

import copy
import hashlib
import json
from pathlib import Path
import runpy
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from unittest import mock


SCRIPT = Path(__file__).with_name("cognition-audit.py")
AUDIT = runpy.run_path(str(SCRIPT))
audit_database = AUDIT["audit_database"]


class Fixture:
    def __init__(self, path):
        self.path = path
        self.db = sqlite3.connect(path)
        self.db.executescript("""
            CREATE TABLE cognition_events (
                work_id TEXT, seq INTEGER, kind TEXT, prev_hash TEXT,
                hash TEXT, payload TEXT, PRIMARY KEY (work_id,seq));
            CREATE TABLE cognition_state (
                work_id TEXT PRIMARY KEY, seq INTEGER, head_hash TEXT,
                state_json TEXT);
            CREATE TABLE cognition_clock (id INTEGER PRIMARY KEY, epoch INTEGER);
            INSERT INTO cognition_clock VALUES (1,0);
        """)
        self.seq = 0
        self.head = ""
        self.epoch = 0
        self.pending = {}
        self.last_gap_seq = 0
        self.indexes = False
        self.scope = {"workId": "work-1", "observer": "executor", "runId": "run-1"}

    def enable_indexes(self):
        self.db.executescript("""
            CREATE TABLE cognition_active (
                op_id TEXT PRIMARY KEY, work_id TEXT, observer TEXT, run_id TEXT);
            CREATE TABLE cognition_receipts (
                work_id TEXT, op_id TEXT, digest TEXT, seq INTEGER,
                PRIMARY KEY (work_id,op_id));
        """)
        self.indexes = True

    def event(self, kind, ticket=None, **fields):
        self.seq += 1
        event = {"version": 1, "seq": self.seq, "kind": kind,
                 "scope": dict(self.scope), "epoch": self.epoch}
        if ticket is not None:
            event["ticket"] = copy.deepcopy(ticket)
        event.update(fields)
        # Deliberately use literal Unicode and spaces. Canonicalizing this JSON
        # would invalidate the fixture's hash even though its values are equal.
        payload = json.dumps(event, ensure_ascii=False)
        digest = hashlib.sha256((self.head + "\n" + payload).encode("utf-8")).hexdigest()
        self.db.execute("INSERT INTO cognition_events VALUES (?,?,?,?,?,?)",
                        (self.scope["workId"], self.seq, kind, self.head, digest, payload))
        self.head = digest
        if kind == "start":
            self.pending[ticket["id"]] = copy.deepcopy(ticket)
        elif kind in ("finish", "orphan"):
            self.pending.pop(ticket["id"], None)
        elif kind == "run":
            self.pending = {key: value for key, value in self.pending.items()
                            if value["observer"] != self.scope["observer"]
                            or value["runId"] == self.scope["runId"]}
        elif kind == "gap":
            self.last_gap_seq = self.seq
        if self.indexes:
            if kind == "start" and ticket["mutating"]:
                self.db.execute("INSERT INTO cognition_active VALUES (?,?,?,?)",
                                (ticket["id"], ticket["workId"], ticket["observer"], ticket["runId"]))
            elif kind in ("finish", "orphan"):
                self.db.execute("DELETE FROM cognition_active WHERE op_id=?", (ticket["id"],))
                if kind == "finish":
                    self.db.execute("INSERT INTO cognition_receipts VALUES (?,?,?,?)",
                                    (ticket["workId"], ticket["id"], event["digest"], self.seq))
        state = {"version": 1, "seq": self.seq, "epoch": self.epoch,
                 "pending": self.pending}
        if self.last_gap_seq:
            state["lastGapSeq"] = self.last_gap_seq
        self.db.execute("INSERT OR REPLACE INTO cognition_state VALUES (?,?,?,?)",
                        (self.scope["workId"], self.seq, self.head, json.dumps(state)))
        self.db.execute("UPDATE cognition_clock SET epoch=? WHERE id=1", (self.epoch,))
        self.db.commit()
        return event

    def start(self, op_id="op-1", **ticket_fields):
        ticket = dict(self.scope, id=op_id, callId="call-1", tool="read_file",
                      action="action-sha", summary="Read ação/🧪.go", mutating=False,
                      epoch=self.epoch, startSeq=self.seq + 1)
        ticket.update(ticket_fields)
        self.event("start", ticket)
        return ticket

    def finish(self, ticket, output="package ação 🧪\n", **fields):
        fields.setdefault("digest", hashlib.sha256(output.encode("utf-8")).hexdigest())
        fields.setdefault("excerpt", output)
        self.event("finish", ticket, **fields)

    def orphan(self, ticket):
        self.epoch += 1
        scope = {key: ticket[key] for key in ("workId", "observer", "runId")}
        self.event("orphan", ticket, scope=scope)

    def gap(self):
        self.epoch += 1
        self.event("gap")

    def report(self, work_id=None):
        return audit_database(self.path, work_id)

    def change_payload(self, seq, change):
        raw = self.db.execute("SELECT payload FROM cognition_events WHERE seq=?", (seq,)).fetchone()[0]
        value = json.loads(raw)
        change(value)
        self.db.execute("UPDATE cognition_events SET payload=? WHERE seq=?", (json.dumps(value), seq))
        self.db.commit()


class CognitionAuditTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.fixture = Fixture(Path(self.temp.name) / "memory #1%.sqlite")
        self.addCleanup(self.fixture.db.close)

    def codes(self, report):
        return {item["code"] for item in report["issues"]} | {
            item["code"] for work in report["works"] for item in work["issues"]}

    def test_valid_unicode_exact_payload_and_read_only_database(self):
        f = self.fixture
        f.event("run")
        f.finish(f.start())
        before = f.path.read_bytes()
        real_connect = sqlite3.connect
        queries = []

        def connect(database_uri, **kwargs):
            self.assertIn("?mode=ro", database_uri)
            self.assertTrue(kwargs["uri"])
            connection = real_connect(database_uri, **kwargs)
            with self.assertRaises(sqlite3.OperationalError):
                connection.execute("CREATE TABLE forbidden (x)")
            connection.set_trace_callback(queries.append)
            return connection

        with mock.patch.object(sqlite3, "connect", side_effect=connect):
            report = f.report()
        self.assertTrue(report["ok"], report)
        self.assertEqual([], report["checkedIndexes"])
        self.assertEqual((3, 1, 1, 0), tuple(report["works"][0][key]
                                          for key in ("events", "starts", "finishes", "unknownOutcomes")))
        self.assertEqual(before, f.path.read_bytes())
        self.assertTrue(all(sql.split()[0] in ("SELECT", "PRAGMA", "BEGIN") for sql in queries))

    def test_unfinished_start_is_uncertainty_not_corruption(self):
        f = self.fixture
        f.event("run")
        f.start()
        report = f.report()
        self.assertTrue(report["ok"], report)
        self.assertEqual(1, report["works"][0]["pending"])
        self.assertEqual(1, report["works"][0]["unknownOutcomes"])

    def test_restart_retires_only_same_observer_pending(self):
        f = self.fixture
        f.event("run")
        f.start("executor-op")
        f.scope["observer"] = "verifier"
        f.event("run")
        f.start("verifier-op")
        f.scope.update(observer="executor", runId="run-2")
        f.event("run")
        report = f.report()
        self.assertTrue(report["ok"], report)
        self.assertEqual(1, report["works"][0]["pending"])
        self.assertEqual(1, report["works"][0]["interrupted"])
        self.assertEqual(2, report["works"][0]["unknownOutcomes"])

    def test_late_finish_of_interrupted_operation_is_valid(self):
        f = self.fixture
        old = f.start()
        f.scope["runId"] = "run-2"
        f.event("run")
        f.scope["runId"] = "run-1"
        f.finish(old)
        report = f.report()
        self.assertTrue(report["ok"], report)
        self.assertEqual(0, report["works"][0]["unknownOutcomes"])

    def test_orphan_retains_unknown_outcome_without_pending_operation(self):
        f = self.fixture
        ticket = f.start(ownerPID=31415, mutating=True)
        f.orphan(ticket)
        report = f.report()
        self.assertTrue(report["ok"], report)
        work = report["works"][0]
        self.assertEqual((1, 0, 1, 1), tuple(work[key] for key in
                                           ("orphans", "pending", "interrupted", "unknownOutcomes")))
        self.assertIn("recorded OS process death", report["assurance"])

    def test_late_finish_after_orphan_resolves_uncertainty(self):
        f = self.fixture
        ticket = f.start(ownerPID=31415, mutating=True)
        f.orphan(ticket)
        f.finish(ticket)
        report = f.report()
        self.assertTrue(report["ok"], report)
        self.assertEqual(0, report["works"][0]["unknownOutcomes"])
        self.assertEqual(0, report["works"][0]["interrupted"])

    def test_orphan_after_replacement_run_does_not_double_count_uncertainty(self):
        f = self.fixture
        ticket = f.start(ownerPID=31415, mutating=True)
        f.scope["runId"] = "replacement"
        f.event("run")
        f.orphan(ticket)
        report = f.report()
        self.assertTrue(report["ok"], report)
        self.assertEqual(1, report["works"][0]["interrupted"])
        self.assertEqual(1, report["works"][0]["unknownOutcomes"])

    def test_duplicate_orphan_is_rejected(self):
        f = self.fixture
        ticket = f.start(ownerPID=31415, mutating=True)
        f.orphan(ticket)
        f.orphan(ticket)
        self.assertIn("duplicate_orphan", self.codes(f.report()))

    def test_orphan_after_finish_is_rejected(self):
        f = self.fixture
        ticket = f.start(ownerPID=31415, mutating=True)
        f.finish(ticket)
        f.orphan(ticket)
        self.assertIn("orphan_after_finish", self.codes(f.report()))

    def test_orphan_must_match_its_original_ticket_and_start(self):
        f = self.fixture
        ticket = f.start(ownerPID=31415, mutating=True)
        ticket["ownerPID"] += 1
        f.orphan(ticket)
        self.assertIn("ticket_mismatch", self.codes(f.report()))
        ticket["id"] = "nonexistent-operation"
        f.orphan(ticket)
        self.assertIn("missing_start", self.codes(f.report()))

    def test_owner_pid_and_concurrency_flags_have_explicit_types(self):
        f = self.fixture
        f.start(ownerPID=True, concurrentMutation="yes")
        self.assertIn("event_schema", self.codes(f.report()))

    def test_valid_indexes_include_reads_receipts_and_replaced_active_mutations(self):
        f = self.fixture
        f.enable_indexes()
        f.start("in-flight-mutation", mutating=True)
        f.finish(f.start("completed-read"))
        f.scope["runId"] = "replacement"
        f.event("run")
        report = f.report()
        self.assertTrue(report["ok"], report)
        self.assertEqual(["cognition_active", "cognition_receipts"], report["checkedIndexes"])
        self.assertEqual(report["checkedIndexes"], report["works"][0]["checkedIndexes"])

    def test_missing_active_row_is_detected_with_intact_snapshot(self):
        f = self.fixture
        f.enable_indexes()
        f.start(mutating=True)
        f.db.execute("DELETE FROM cognition_active")
        f.db.commit()
        self.assertEqual({"active_index"}, self.codes(f.report()))

    def test_changed_active_owner_is_detected(self):
        f = self.fixture
        f.enable_indexes()
        f.start(mutating=True)
        f.db.execute("UPDATE cognition_active SET run_id='incorrect-owner'")
        f.db.commit()
        self.assertEqual({"active_index"}, self.codes(f.report()))

    def test_missing_receipt_is_detected_with_intact_snapshot(self):
        f = self.fixture
        f.enable_indexes()
        f.finish(f.start())
        f.db.execute("DELETE FROM cognition_receipts")
        f.db.commit()
        self.assertEqual({"receipt_index"}, self.codes(f.report()))

    def test_changed_receipt_digest_or_sequence_is_detected(self):
        f = self.fixture
        f.enable_indexes()
        f.finish(f.start())
        digest, seq = f.db.execute("SELECT digest,seq FROM cognition_receipts").fetchone()
        for changed_digest, changed_seq in (("0" * 64, seq), (digest, seq + 1)):
            with self.subTest(digest=changed_digest, seq=changed_seq):
                f.db.execute("UPDATE cognition_receipts SET digest=?,seq=?", (changed_digest, changed_seq))
                f.db.commit()
                self.assertEqual({"receipt_index"}, self.codes(f.report()))

    def test_orphan_releases_active_marker_and_late_finish_creates_receipt(self):
        f = self.fixture
        f.enable_indexes()
        ticket = f.start(mutating=True, ownerPID=31415)
        f.orphan(ticket)
        self.assertEqual(0, f.db.execute("SELECT COUNT(*) FROM cognition_active").fetchone()[0])
        self.assertEqual(0, f.db.execute("SELECT COUNT(*) FROM cognition_receipts").fetchone()[0])
        self.assertTrue(f.report()["ok"])
        f.finish(ticket)
        self.assertEqual(1, f.db.execute("SELECT COUNT(*) FROM cognition_receipts").fetchone()[0])
        self.assertTrue(f.report()["ok"])

    def test_index_rows_for_nonexistent_work_are_not_silently_ignored(self):
        f = self.fixture
        f.enable_indexes()
        f.event("run")
        f.db.execute("INSERT INTO cognition_active VALUES ('invented','other-work','observer','run')")
        f.db.commit()
        report = f.report()
        self.assertEqual(2, len(report["works"]))
        self.assertIn("active_index", self.codes(report))
        self.assertTrue(f.report("work-1")["ok"])

    def test_recording_gap_is_uncertainty_without_a_fabricated_tool_result(self):
        f = self.fixture
        f.enable_indexes()
        f.event("run")
        self.assertFalse(f.report()["hasUncertainty"])
        f.gap()
        report = f.report()
        self.assertTrue(report["ok"], report)
        self.assertTrue(report["hasUncertainty"])
        work = report["works"][0]
        self.assertTrue(work["hasUncertainty"])
        self.assertEqual((1, 0, 0, 0), tuple(work[key] for key in
                                           ("recordingGaps", "starts", "finishes", "unknownOutcomes")))

    def test_recording_gap_preserves_pending_and_links_latest_gap(self):
        f = self.fixture
        f.enable_indexes()
        ticket = f.start(mutating=True)
        f.gap()
        f.gap()
        f.finish(ticket)
        report = f.report()
        self.assertTrue(report["ok"], report)
        self.assertEqual(2, report["works"][0]["recordingGaps"])
        self.assertEqual(0, report["works"][0]["pending"])
        self.assertTrue(report["hasUncertainty"], "later results do not invent missing history")

    def test_recording_gap_requires_epoch_advance(self):
        f = self.fixture
        f.event("run")
        f.event("gap")
        self.assertEqual({"epoch"}, self.codes(f.report()))

    def test_snapshot_must_retain_latest_recording_gap_identity(self):
        f = self.fixture
        f.event("run")
        f.gap()
        f.gap()
        raw = f.db.execute("SELECT state_json FROM cognition_state").fetchone()[0]
        state = json.loads(raw)
        for marker in (None, 2, True):
            with self.subTest(lastGapSeq=marker):
                altered = dict(state)
                if marker is None:
                    del altered["lastGapSeq"]
                else:
                    altered["lastGapSeq"] = marker
                f.db.execute("UPDATE cognition_state SET state_json=?", (json.dumps(altered),))
                f.db.commit()
                self.assertEqual({"snapshot_gap"}, self.codes(f.report()))

    def test_gap_cannot_carry_a_tool_ticket(self):
        f = self.fixture
        ticket = f.start()
        f.epoch += 1
        f.event("gap", ticket)
        self.assertIn("event_schema", self.codes(f.report()))

    def test_tampered_output_is_detected(self):
        f = self.fixture
        f.finish(f.start())
        f.change_payload(2, lambda event: event.update(excerpt="all tests passed"))
        self.assertIn("payload_hash", self.codes(f.report()))

    def test_sequence_gap_is_detected_even_with_rehashed_valid_payload(self):
        f = self.fixture
        f.event("run")
        f.seq += 1
        f.event("sync")
        self.assertIn("sequence", self.codes(f.report()))

    def test_chain_pointer_tampering_is_detected(self):
        f = self.fixture
        f.event("run")
        f.start()
        f.db.execute("UPDATE cognition_events SET prev_hash=? WHERE seq=2", ("a" * 64,))
        f.db.commit()
        self.assertIn("chain_link", self.codes(f.report()))

    def test_unknown_version_is_rejected_even_with_valid_hash(self):
        f = self.fixture
        f.event("run", version=2)
        self.assertIn("event_schema", self.codes(f.report()))

    def test_malformed_scope_returns_issues_instead_of_crashing(self):
        f = self.fixture
        ticket = f.start()
        f.event("finish", ticket, scope=17, digest="0" * 64)
        self.assertIn("event_schema", self.codes(f.report()))

    def test_finish_ticket_cannot_change_the_original_operation(self):
        f = self.fixture
        ticket = f.start()
        ticket["tool"] = "write_file"
        f.finish(ticket)
        self.assertIn("ticket_mismatch", self.codes(f.report()))

    def test_duplicate_finish_is_detected(self):
        f = self.fixture
        ticket = f.start()
        f.finish(ticket)
        f.finish(ticket)
        self.assertIn("duplicate_finish", self.codes(f.report()))

    def test_finish_without_start_is_detected(self):
        f = self.fixture
        ticket = dict(f.scope, id="absent", callId="call", tool="read_file",
                      action="action", summary="read", mutating=False, epoch=0, startSeq=1)
        f.finish(ticket)
        self.assertIn("missing_start", self.codes(f.report()))

    def test_snapshot_head_and_pending_are_verified(self):
        f = self.fixture
        f.start()
        f.db.execute("UPDATE cognition_state SET head_hash=?,state_json=?",
                     ("f" * 64, json.dumps({"version": 1, "seq": 1, "epoch": 0, "pending": {}})))
        f.db.commit()
        self.assertTrue({"snapshot_head", "snapshot_pending"} <= self.codes(f.report()))

    def test_attested_snapshot_detects_content_changes_outside_pending(self):
        f = self.fixture
        f.event("run")
        seq, state_raw = f.db.execute("SELECT seq,state_json FROM cognition_state").fetchone()
        previous, raw = f.db.execute("SELECT prev_hash,payload FROM cognition_events WHERE seq=?",
                                    (seq,)).fetchone()
        event = json.loads(raw)
        event["stateHash"] = hashlib.sha256(state_raw.encode("utf-8")).hexdigest()
        raw = json.dumps(event)
        event_hash = hashlib.sha256((previous + "\n" + raw).encode("utf-8")).hexdigest()
        f.db.execute("UPDATE cognition_events SET payload=?,hash=? WHERE seq=?", (raw, event_hash, seq))
        f.db.execute("UPDATE cognition_state SET head_hash=?", (event_hash,))
        f.db.commit()
        self.assertTrue(f.report()["ok"])
        state = json.loads(state_raw)
        state["evidence"] = {"invented": "tests passed"}
        f.db.execute("UPDATE cognition_state SET state_json=?", (json.dumps(state),))
        f.db.commit()
        self.assertIn("snapshot_hash", self.codes(f.report()))

    def test_mutation_epochs_can_jump_but_cannot_regress(self):
        f = self.fixture
        f.event("run")
        f.epoch = 27
        f.event("sync")
        self.assertTrue(f.report()["ok"])
        f.epoch = 2
        f.event("sync")
        self.assertIn("epoch", self.codes(f.report()))

    def test_work_filter_is_parameterized_and_unknown_is_an_error(self):
        f = self.fixture
        f.event("run")
        self.assertTrue(f.report("work-1")["ok"])
        report = f.report("' OR 1=1 --")
        self.assertFalse(report["ok"])
        self.assertEqual([], report["works"])
        self.assertIn("work_missing", self.codes(report))

    def test_mismatched_payload_work_identity_is_detected(self):
        f = self.fixture
        f.event("run", scope=dict(f.scope, workId="some-other-work"))
        self.assertIn("event_schema", self.codes(f.report()))

    def test_missing_database_is_not_created_and_cli_returns_json_failure(self):
        path = Path(self.temp.name) / "missing.sqlite"
        process = subprocess.run([sys.executable, str(SCRIPT), "--database", str(path)],
                                 text=True, capture_output=True, check=False)
        self.assertEqual(1, process.returncode, process.stderr)
        self.assertIn("database_missing", self.codes(json.loads(process.stdout)))
        self.assertFalse(path.exists())

    def test_cli_success_and_corruption_exit_codes(self):
        f = self.fixture
        f.event("run")
        command = [sys.executable, str(SCRIPT), "--database", str(f.path)]
        good = subprocess.run(command, text=True, capture_output=True, check=False)
        self.assertEqual(0, good.returncode, good.stdout + good.stderr)
        self.assertTrue(json.loads(good.stdout)["ok"])
        f.change_payload(1, lambda event: event.update(version=88))
        bad = subprocess.run(command, text=True, capture_output=True, check=False)
        self.assertEqual(1, bad.returncode, bad.stderr)
        self.assertFalse(json.loads(bad.stdout)["ok"])


if __name__ == "__main__":
    unittest.main()
