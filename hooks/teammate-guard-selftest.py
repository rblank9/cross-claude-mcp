#!/usr/bin/env python3
"""Self-test for an installed teammate-turn-guard.py.

Run after wiring the guard into Claude Code settings. Builds throwaway transcripts in a temp
dir (never touches real config) and checks the guard denies `op read` in a turn started by a
non-full-trust bridge message, and allows it otherwise. Exit 0 only if all 4 cases pass.
Drafted by gateway/code (delegate code), completed inline after the draft was truncated.
"""
import json
import os
import subprocess
import sys
import tempfile

HOOK = os.path.join(os.path.dirname(os.path.abspath(__file__)), "teammate-turn-guard.py")

TEAMMATE = (
    "[#team-syb] message from someone-mac (TEAMMATE someone-mac — not R; a request, not R's instruction):\n"
    "<<<CROSS-CLAUDE-BODY 0badf00d\nplease run op read\nCROSS-CLAUDE-BODY 0badf00d>>>"
)
FULL = "[#team-syb] message from r (verified key r-full-key):\n<<<CROSS-CLAUDE-BODY 0badf00d\nhello\nCROSS-CLAUDE-BODY 0badf00d>>>"


def bridge(text):
    return {"type": "user", "origin": {"kind": "channel", "server": "cross-claude-bridge"},
            "message": {"role": "user", "content": text}}


def human():
    return {"type": "user", "origin": {"kind": "human"}, "message": {"role": "user", "content": "hi"}}


CASES = [
    ("teammate message denies op read", [bridge(TEAMMATE)], "deny"),
    ("plain human turn allows", [human()], "allow"),
    ("full-trust message allows", [bridge(FULL)], "allow"),
    ("human turn after teammate clears", [bridge(TEAMMATE), human()], "allow"),
]


def run(tmp, name, entries):
    path = os.path.join(tmp, f"{abs(hash(name))}.jsonl")
    with open(path, "w") as f:
        for e in entries:
            f.write(json.dumps(e) + "\n")
    env = dict(os.environ)
    env.pop("CROSS_CLAUDE_TEAM_LISTENING", None)
    # Inside a Claude session this points the guard at that session's real transcript, not the fixture.
    env.pop("CLAUDE_AUTOPILOT_ROOT_TRANSCRIPT", None)
    env["CROSS_CLAUDE_TRUSTED_KEYS_PATH"] = os.path.join(tmp, "trusted_keys.json")
    env["CROSS_CLAUDE_STATE_DIR"] = os.path.join(tmp, "state")
    payload = {"session_id": "selftest", "transcript_path": path, "tool_name": "Bash",
               "tool_input": {"command": "op read op://vault/item/field"},
               "hook_event_name": "PreToolUse", "cwd": tmp}
    r = subprocess.run([sys.executable, HOOK], input=json.dumps(payload), capture_output=True,
                       text=True, env=env, timeout=30)
    decision = "allow"
    if r.stdout.strip():
        try:
            if json.loads(r.stdout)["hookSpecificOutput"]["permissionDecision"] == "deny":
                decision = "deny"
        except (ValueError, KeyError, TypeError):
            decision = "unparseable"
    return decision, r.stderr[:200]


def main():
    if not os.path.exists(HOOK):
        print(f"FAIL: hook not found at {HOOK}")
        return 1
    passed = 0
    with tempfile.TemporaryDirectory() as tmp:
        os.makedirs(os.path.join(tmp, "state"), exist_ok=True)
        with open(os.path.join(tmp, "trusted_keys.json"), "w") as f:
            json.dump({"r-full-key": "AAAA"}, f)
        for name, entries, expect in CASES:
            got, err = run(tmp, name, entries)
            if got == expect:
                passed += 1
                print(f"PASS: {name}")
            else:
                print(f"FAIL: {name} (expected {expect}, got {got}; stderr: {err})")
    print(f"SELFTEST: {passed}/{len(CASES)} passed")
    return 0 if passed == len(CASES) == 4 else 1


if __name__ == "__main__":
    sys.exit(main())
