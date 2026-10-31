import os
import sys
import subprocess
import json
import time
from pathlib import Path
import pytest
from subprocess import CompletedProcess
from pytest import fixture

REPO = Path(__file__).resolve().parent.parent
SCRIPT = REPO / "bin" / "cc-peers"
LIVE_TEST_PID = os.getpid()
DEAD_PID = 999999
KEY_CANARY = "SECRET" + "VALUE123"

@fixture
def live_child():
    proc = subprocess.Popen(["sleep", "60"])
    yield proc.pid
    proc.kill()
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait()

@fixture
def socks(tmp_path):
    socks_dir = tmp_path / "socks"
    socks_dir.mkdir()
    yield socks_dir

@fixture
def home(tmp_path, live_child, socks):
    h = tmp_path / "home"
    h.mkdir()
    (h / ".claude").mkdir()
    (h / ".claude-account2").mkdir()
    (h / ".claude/sessions").mkdir()
    (h / ".claude-account2/sessions").mkdir()

    def write_session(sessions_dir, pid, name, cwd, sock):
        sock.touch()
        sess_file = sessions_dir / f"{pid}.json"
        data = {
            "pid": pid,
            "name": name,
            "cwd": cwd,
            "kind": "interactive",
            "entrypoint": "cli",
            "status": "idle",
            "startedAt": int(time.time() * 1000 - 45 * 60 * 1000),
            "messagingSocketPath": str(sock),
            "version": "2.0.0",
            "sessionId": f"sid-{pid}"
        }
        with open(sess_file, "w") as f:
            json.dump(data, f)

    write_session(h / ".claude/sessions", LIVE_TEST_PID, "alpha", "/x/alpha-proj", socks / "alpha.sock")
    write_session(h / ".claude/sessions", DEAD_PID, "ghost", "/x/ghost-proj", socks / "ghost.sock")
    write_session(h / ".claude-account2/sessions", live_child, "beta", "/x/beta-proj", socks / "beta.sock")

    yield h

def run(home, *args):
    env = os.environ.copy()
    env["HOME"] = str(home)
    return subprocess.run([sys.executable, str(SCRIPT), *args], env=env, capture_output=True, text=True, timeout=30)

def test_lists_live_sessions_from_both_accounts_and_hides_dead(home):
    result = run(home)
    assert result.returncode == 0
    assert "alpha" in result.stdout
    assert "beta" in result.stdout
    assert "ghost" not in result.stdout
    assert "2 live session(s) across 2 account dir(s)" in result.stdout

def test_all_includes_dead_session(home):
    result = run(home, "--all")
    assert result.returncode == 0
    assert "ghost" in result.stdout
    assert "dead" in result.stdout

def test_json_output_has_address_and_account(home, socks):
    result = run(home, "--json")
    assert result.returncode == 0
    data = json.loads(result.stdout)
    beta_row = next(row for row in data if row["name"] == "beta")
    assert beta_row["account"] == ".claude-account2"
    assert beta_row["address"] == "uds:" + str(socks / "beta.sock")
    assert beta_row["live"] is True
    assert beta_row["self"] is False
    assert "config_dir" in beta_row
    assert "pid" in beta_row
    assert "status" in beta_row
    assert "entrypoint" in beta_row
    assert "kind" in beta_row
    assert "project" in beta_row
    assert "cwd" in beta_row
    assert "started_at_ms" in beta_row

def test_filter_by_name_substring_returns_only_matching_row(home):
    result = run(home, "BETA")
    assert result.returncode == 0
    assert "beta" in result.stdout
    assert "alpha" not in result.stdout
    assert "1 live session(s) across 1 account dir(s)" in result.stdout

def test_filter_matches_project_basename(home):
    result = run(home, "--json", "alpha-proj")
    data = json.loads(result.stdout)
    assert result.returncode == 0
    names = [row["name"] for row in data]
    assert names == ["alpha"]

def test_filter_with_no_match_exits_1_with_message(home):
    result = run(home, "zzz-no-such-session")
    assert result.returncode == 1
    assert "no live sessions found" in result.stderr

def test_no_claude_dirs_exits_2(tmp_path):
    result = run(tmp_path)
    assert result.returncode == 2

def test_session_with_missing_socket_is_dead(home, socks, live_child):
    sess_dir = home / ".claude-account2/sessions"
    sess_file = sess_dir / f"{live_child}.json"
    with open(sess_file, "w") as f:
        json.dump({
            "pid": live_child,
            "name": "beta",
            "cwd": "/x/beta-proj",
            "kind": "interactive",
            "entrypoint": "cli",
            "status": "idle",
            "startedAt": int(time.time() * 1000 - 45 * 60 * 1000),
            "messagingSocketPath": str(socks / "missing.sock"),
            "version": "2.0.0",
            "sessionId": f"sid-{live_child}"
        }, f)

    result = run(home)
    assert result.returncode == 0
    assert "beta" not in result.stdout
    assert "alpha" in result.stdout

    result = run(home, "--all")
    assert result.returncode == 0
    assert "beta" in result.stdout
    assert "dead" in result.stdout

def test_key_file_contents_never_printed(home):
    key_file = home / ".claude/sessions" / f"{LIVE_TEST_PID}.abc123.key"
    key_file.write_text(KEY_CANARY)
    for flag in ["", "--json", "--all"]:
        result = run(home, flag)
        assert result.returncode == 0
        assert KEY_CANARY not in result.stdout
        assert KEY_CANARY not in result.stderr

def test_unparseable_json_warns_and_other_rows_still_listed(home):
    broken_file = home / ".claude-account2/sessions" / "broken.json"
    broken_file.write_text("{not json")
    result = run(home)
    assert result.returncode == 0
    assert "warning: 1 unreadable session file(s)" in result.stderr
    assert "alpha" in result.stdout
    assert "beta" in result.stdout

def test_symlinked_config_dir_does_not_duplicate_rows(home):
    account9_dir = home / ".claude-account9"
    account9_dir.mkdir()
    (account9_dir / "sessions").symlink_to(home / ".claude/sessions")
    result = run(home, "--json")
    assert result.returncode == 0
    data = json.loads(result.stdout)
    assert len(data) == 2
    names = sorted(row["name"] for row in data)
    assert names == ["alpha", "beta"]
    assert "account9" not in result.stdout
