import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("pam_triage", Path(__file__).with_name("pam-triage.py"))
triage = importlib.util.module_from_spec(spec)
spec.loader.exec_module(triage)


class FakeSlack:
    def __init__(self, responses):
        self.responses = iter(responses)
        self.calls = []

    def call(self, method, **params):
        self.calls.append((method, params))
        return next(self.responses)


def counts():
    return {"threads": {"has_unreads": False, "mention_count": 0}, "activity_v2": {"unjoined_channel_mention": 0},
            "channels": [{"id": "C123", "has_unreads": True, "mention_count": 1, "last_read": "1.0", "latest": "3.0"}], "ims": [], "mpims": []}


class TriageTests(unittest.TestCase):
    def test_snippets_mask_token_shapes(self):
        self.assertEqual(triage.first_line("Here is xoxc-secret-test\nnext", 100), "Here is [redacted]")

    def test_slack_paginates_and_excludes_boundary_and_seen(self):
        client = FakeSlack([counts(), {"channel": {"id": "C123", "name": "general"}},
                            {"messages": [{"ts": "3.0", "user": "U1", "text": "New request\nDetails"}],
                             "has_more": True, "response_metadata": {"next_cursor": "next"}},
                            {"messages": [{"ts": "2.0", "user": "U1", "text": "Seen"}, {"ts": "1.0", "text": "Read"}],
                             "has_more": False}])
        items, ids = triage.scan_slack("GSD", client, {"C123:2.0"})
        self.assertEqual([x["id"] for x in items], ["C123:3.0"])
        self.assertEqual(items[0]["snippet"], "New request")
        self.assertEqual(ids, {"C123:3.0", "C123:2.0"})
        self.assertTrue(all(method in triage.READ_METHODS for method, _ in client.calls))
        self.assertEqual(client.calls[-1][1]["cursor"], "next")

    def test_partial_slack_page_is_failure(self):
        client = FakeSlack([counts(), {"channel": {"id": "C123"}}, {"messages": [], "has_more": True}])
        with self.assertRaises(triage.ScanError):
            triage.scan_slack("GSD", client, set())

    def test_thread_and_unjoined_mentions_fail_open(self):
        for kind in ("thread", "mention"):
            value = counts()
            if kind == "thread":
                value["threads"]["has_unreads"] = True
            else:
                value["activity_v2"]["unjoined_channel_mention"] = 1
            with self.assertRaises(triage.ScanError):
                triage.scan_slack("JUMP", FakeSlack([value]), set())

    def test_schema_drift_is_not_empty(self):
        with self.assertRaises(triage.ScanError):
            triage.scan_slack("GSD", FakeSlack([{"ok": True}]), set())

    def test_mutating_methods_never_reach_network(self):
        client = triage.Slack("test-token", "test-cookie")
        with patch("urllib.request.build_opener") as network:
            with self.assertRaises(triage.ScanError):
                client.call("conversations.mark", channel="C123")
            network.assert_not_called()

    def test_source_failure_does_not_return_partial_empty(self):
        credentials = {key: "test" for key in triage.SLACK_KEYS}
        def gmail(label, seen):
            if label == "cklauber":
                raise triage.ScanError("Account unavailable")
            return [], set()
        with self.assertRaises(triage.ScanError):
            triage.collect({"version": 1, "seen": {}}, credentials, gmail, lambda *args: ([], set()))

    def test_seen_state_is_not_pruned_when_mail_is_read(self):
        state = {"version": 1, "seen": {"gmail:main": ["old"]}}
        credentials = {key: "test" for key in triage.SLACK_KEYS}
        payload, result = triage.collect(state, credentials, lambda *args: ([], set()), lambda *args: ([], set()))
        self.assertEqual(json.loads(payload), {"items": []})
        self.assertEqual(result["seen"]["gmail:main"], ["old"])
        self.assertEqual(state, {"version": 1, "seen": {"gmail:main": ["old"]}})

    def test_corrupt_state_is_failure_and_atomic_save_is_private(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "seen.json"
            triage.save_state(path, {"version": 1, "seen": {}})
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(triage.load_state(path), {"version": 1, "seen": {}})
            path.write_text('{"version":2}')
            with self.assertRaises(triage.ScanError):
                triage.load_state(path)

    def test_gmail_response_requires_every_unseen_message(self):
        response = type("Response", (), {"returncode": 0, "stdout": b'{"ids":["abc","def"],"items":[]}'})()
        with patch.object(triage.subprocess, "run", return_value=response) as run:
            with self.assertRaises(triage.ScanError):
                triage.scan_gmail("main", set())
            command = run.call_args.args[0]
            self.assertEqual(command[0], "ssh")
            self.assertIn("--readonly", command[-1])
            self.assertIn("--gmail-no-send", command[-1])
            self.assertNotIn("access-token", command[-1])

    def test_provider_error_cannot_echo_credentials(self):
        with patch.object(triage.sys, "argv", ["pam-triage.py", "--state-file", "/unused", "--dry-run"]), \
             patch.object(triage, "load_state", side_effect=RuntimeError("xoxc-SECRET")), \
             patch.object(triage.sys, "stderr", new_callable=io.StringIO) as stderr, \
             patch.object(triage.sys, "stdout", new_callable=io.StringIO) as stdout:
            self.assertEqual(triage.main(), 1)
            self.assertNotIn("SECRET", stderr.getvalue())
            self.assertEqual(stdout.getvalue(), "")


if __name__ == "__main__":
    unittest.main()
