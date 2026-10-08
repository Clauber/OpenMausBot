#!/usr/bin/env python3
"""Read-only Gmail/Slack delta scan. stdout is JSON; errors never include responses."""
import argparse
import concurrent.futures
import decimal
import fcntl
import html
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys
import tempfile
import urllib.parse
import urllib.request


ACCOUNTS = {
    "main": "gog-mcp",
    "cklauber": "gog-mcp-cklauber",
    "clauber93": "gog-mcp-clauber93",
}
SLACK_KEYS = {"SLACK_MCP_XOXC_TOKEN_GSD", "SLACK_MCP_XOXC_TOKEN_JUMP", "SLACK_MCP_XOXD_TOKEN"}
READ_METHODS = {"client.counts", "conversations.history", "conversations.info"}
MAX_ITEMS = 20_000
MAX_BYTES = 4 * 1024 * 1024


class ScanError(Exception):
    """A partial scan must never be mistaken for an empty inbox."""


def first_line(value, limit):
    if not isinstance(value, str):
        raise ScanError("Invalid text")
    line = next((html.unescape(x).strip() for x in value.splitlines() if x.strip()), "")
    line = re.sub(r"\b(?:xox[bapcrs]|xapp)-[A-Za-z0-9-]+", "[redacted]", line)
    line = re.sub(r"\bsk-[A-Za-z0-9_-]{16,}", "[redacted]", line)
    return line[:limit]


def slack_credentials(env_file):
    values = {}
    for line in env_file.read_text().splitlines():
        key, separator, value = line.partition("=")
        if separator and key in SLACK_KEYS:
            values[key] = value.strip().strip("\"'")
    if any(not values.get(k) for k in SLACK_KEYS):
        raise ScanError("Missing Slack credentials")
    return values


class Slack:
    def __init__(self, token, cookie):
        self.token = token
        self.cookie = cookie

    def call(self, method, **params):
        if method not in READ_METHODS:
            raise ScanError("Denied Slack method")
        body = urllib.parse.urlencode({"token": self.token, **params}).encode()
        request = urllib.request.Request("https://slack.com/api/" + method, data=body, headers={
            "Content-Type": "application/x-www-form-urlencoded", "Cookie": "d=" + self.cookie,
        })
        # Do not follow redirects with account credentials.
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, req, fp, code, msg, headers, newurl):
                return None
        with urllib.request.build_opener(NoRedirect).open(request, timeout=12) as response:
            data = response.read(MAX_BYTES + 1)
        if len(data) > MAX_BYTES:
            raise ScanError("Slack response limit")
        result = json.loads(data)
        if not isinstance(result, dict) or result.get("ok") is not True:
            raise ScanError("Slack request failed")
        return result


def timestamp(value):
    if not isinstance(value, str) or not re.fullmatch(r"\d+(?:\.\d+)?", value):
        raise ScanError("Invalid Slack timestamp")
    return decimal.Decimal(value)


def scan_slack(workspace, client, seen):
    counts = client.call("client.counts", thread_counts_by_channel="true", org_wide_aware="true", include_file_channels="true")
    # client.counts does not identify individual unread thread replies or
    # mentions in unjoined channels. Let the full routine inspect those.
    threads = counts.get("threads")
    activity = counts.get("activity_v2")
    if not isinstance(threads, dict) or not isinstance(threads.get("has_unreads"), bool) or not isinstance(activity, dict):
        raise ScanError("Missing Slack unread coverage")
    if threads["has_unreads"] or threads.get("mention_count", 0) or activity.get("unjoined_channel_mention", 0):
        raise ScanError("Slack thread or unjoined-channel mention requires full triage")
    snapshots = []
    for group in ("channels", "ims", "mpims"):
        values = counts.get(group)
        if not isinstance(values, list):
            raise ScanError("Missing Slack conversation coverage")
        snapshots.extend(values)
    items, ids = [], set()
    for snapshot in snapshots:
        if not isinstance(snapshot, dict) or not isinstance(snapshot.get("has_unreads"), bool):
            raise ScanError("Invalid Slack snapshot")
        mentions = snapshot.get("mention_count")
        if not isinstance(mentions, int) or mentions < 0:
            raise ScanError("Invalid Slack mention count")
        if not snapshot["has_unreads"] and not mentions:
            continue
        channel = snapshot.get("id")
        if not isinstance(channel, str) or not re.fullmatch(r"[CDG][A-Z0-9]+", channel):
            raise ScanError("Invalid Slack channel")
        oldest = snapshot.get("last_read")
        latest = snapshot.get("latest")
        if timestamp(latest) < timestamp(oldest):
            raise ScanError("Invalid Slack bounds")
        # Resolve names once; an unavailable channel is a failed scan.
        info = client.call("conversations.info", channel=channel)
        detail = info.get("channel")
        if not isinstance(detail, dict) or detail.get("id") != channel:
            raise ScanError("Invalid Slack channel info")
        name = first_line(detail.get("name") or channel, 180)
        cursor, cursors, found = "", set(), 0
        while True:
            history = client.call("conversations.history", channel=channel, oldest=oldest, latest=latest,
                                  inclusive="true", limit="200", **({"cursor": cursor} if cursor else {}))
            messages = history.get("messages")
            if not isinstance(messages, list):
                raise ScanError("Invalid Slack history")
            for message in messages:
                if not isinstance(message, dict):
                    raise ScanError("Invalid Slack message")
                ts = message.get("ts")
                if timestamp(ts) <= timestamp(oldest):
                    continue
                if timestamp(ts) > timestamp(latest):
                    raise ScanError("Slack history outside snapshot")
                identity = channel + ":" + ts
                ids.add(identity)
                found += 1
                if identity not in seen:
                    items.append({"source": "slack:" + workspace, "id": identity,
                                  "from": first_line(message.get("user") or message.get("bot_id") or "unknown", 150),
                                  "channel": name, "snippet": first_line(message.get("text", ""), 240)})
                if found > MAX_ITEMS:
                    raise ScanError("Slack item limit")
            metadata = history.get("response_metadata", {})
            if not isinstance(metadata, dict):
                raise ScanError("Invalid Slack pagination")
            cursor = metadata.get("next_cursor", "")
            if not isinstance(cursor, str) or (cursor and cursor in cursors) or (history.get("has_more") and not cursor):
                raise ScanError("Incomplete Slack history")
            if not cursor:
                break
            cursors.add(cursor)
            if len(cursors) > 100:
                raise ScanError("Slack page limit")
        if not found:
            raise ScanError("Unread Slack snapshot with no accessible messages")
    return items, ids


def scan_gmail(label, seen):
    container = ACCOUNTS[label]
    helper = Path(__file__).with_name("gmail-readonly.cjs").read_text()
    # SSH interprets its command remotely: quote every argument as shell data.
    command = shlex.join(["pct", "exec", "110", "--", "docker", "exec", "-i", container, "node", "-e", helper, label])
    result = subprocess.run(["ssh", "-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "proxmox", command],
                            input=json.dumps({"seen": sorted(seen)}).encode(), stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, timeout=105)
    if result.returncode or len(result.stdout) > MAX_BYTES:
        raise ScanError("Gmail read-only scan failed")
    response = json.loads(result.stdout)
    if not isinstance(response, dict) or not isinstance(response.get("items"), list) or not isinstance(response.get("ids"), list):
        raise ScanError("Invalid Gmail scan")
    ids = set(response["ids"])
    if any(not isinstance(i, str) or not re.fullmatch(r"[a-fA-F0-9]{1,128}", i) for i in ids):
        raise ScanError("Invalid Gmail id")
    items = []
    for value in response["items"]:
        if not isinstance(value, dict) or value.get("id") not in ids or value["id"] in seen:
            raise ScanError("Invalid Gmail delta")
        items.append({"source": "gmail:" + label, "id": value["id"],
                      "from": first_line(value.get("from"), 150), "subject": first_line(value.get("subject"), 180),
                      "snippet": first_line(value.get("snippet"), 240)})
    if len(items) != len(ids - seen) or len({i["id"] for i in items}) != len(items):
        raise ScanError("Incomplete Gmail metadata")
    return items, ids


def load_state(path):
    if not path.exists():
        return {"version": 1, "seen": {}}
    state = json.loads(path.read_text())
    if not isinstance(state, dict) or state.get("version") != 1 or not isinstance(state.get("seen"), dict):
        raise ScanError("Invalid seen state")
    for source, ids in state["seen"].items():
        if source not in {"gmail:" + x for x in ACCOUNTS} | {"slack:GSD", "slack:JUMP"} or not isinstance(ids, list) or not all(isinstance(i, str) for i in ids):
            raise ScanError("Invalid seen state")
    return state


def collect(state, credentials, gmail=scan_gmail, slack=scan_slack):
    seen = state["seen"]
    tasks = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=5) as executor:
        for label in ACCOUNTS:
            source = "gmail:" + label
            tasks[source] = executor.submit(gmail, label, set(seen.get(source, [])))
        for workspace in ("GSD", "JUMP"):
            source = "slack:" + workspace
            client = Slack(credentials["SLACK_MCP_XOXC_TOKEN_" + workspace], credentials["SLACK_MCP_XOXD_TOKEN"])
            tasks[source] = executor.submit(slack, workspace, client, set(seen.get(source, [])))
        items, next_seen = [], dict(seen)
        # All five sources must succeed before output or state changes.
        for source, future in tasks.items():
            fresh, ids = future.result()
            items.extend(fresh)
            next_seen[source] = sorted(set(seen.get(source, [])) | ids)
    items.sort(key=lambda i: (i["source"], i["id"]))
    payload = json.dumps({"items": items}, ensure_ascii=False, separators=(",", ":")) + "\n"
    if len(items) > MAX_ITEMS or len(payload.encode()) > MAX_BYTES:
        raise ScanError("Output limit")
    return payload, {"version": 1, "seen": next_seen}


def save_state(path, state):
    fd, temporary = tempfile.mkstemp(prefix=".triage-", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as stream:
            json.dump(state, stream, separators=(",", ":"))
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state-file", type=Path, required=True, help="Use a separate state file for shadow comparisons")
    parser.add_argument("--env-file", type=Path, default=Path.home() / "ai/.env")
    parser.add_argument("--dry-run", action="store_true", help="Scan without creating or advancing seen state")
    args = parser.parse_args()
    try:
        if args.dry_run:
            payload, _ = collect(load_state(args.state_file), slack_credentials(args.env_file))
            sys.stdout.write(payload)
            sys.stdout.flush()
            return 0
        args.state_file.parent.mkdir(parents=True, exist_ok=True)
        descriptor = os.open(str(args.state_file) + ".lock", os.O_CREAT | os.O_WRONLY, 0o600)
        with os.fdopen(descriptor, "w") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            payload, state = collect(load_state(args.state_file), slack_credentials(args.env_file))
            # A broken output pipe leaves state unchanged. A state-save failure
            # exits nonzero, so the scheduler still runs its normal turn.
            sys.stdout.write(payload)
            sys.stdout.flush()
            save_state(args.state_file, state)
        return 0
    except Exception:
        # Provider errors can echo cookies, bodies, or OAuth tokens. Keep only
        # a fixed diagnostic; nonzero always means run the full routine.
        print("Read-only triage pre-check failed; run the full routine.", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
