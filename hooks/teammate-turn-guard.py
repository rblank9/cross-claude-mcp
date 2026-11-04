#!/usr/bin/env python3
"""teammate-turn-guard: Claude Code PreToolUse hook (stdlib only, standalone).

Denies dangerous tool calls while the session is TAINTED. Taint is set by a
channel/peer message whose header is not a verified key in trusted_keys.json,
and it is sticky: only a later human-typed entry clears it.

Helpers marked "copied from autopilot.py" mirror
/Users/rblank/Projects/claude-optimization/hooks/lib/autopilot.py and are
copied, not imported, so this repo stays standalone.
"""
import glob
import json
import os
import re
import subprocess
import sys

ENV_ROOT = "CLAUDE_AUTOPILOT_ROOT_TRANSCRIPT"
ENV_TRUSTED = "CROSS_CLAUDE_TRUSTED_KEYS_PATH"
ENV_LISTENING = "CROSS_CLAUDE_TEAM_LISTENING"
SESSION_ID_RE = re.compile(r"^[A-Za-z0-9-]{8,64}$")
BODY_OPEN_RE = re.compile(r"^<<<CROSS-CLAUDE-BODY ([0-9a-f]{8})$")
VERIFIED_HEADER_RE = re.compile(r"^\[#[^\]]+\] message from \S+ \(verified key (\S+)\):$")
DAEMON_MARKERS = ("--bg-spare", " bg-spare", "--bg-pty-host", " daemon run")

BASH_DENY = [
    (r"\b(op|with-env|secret-provision|spawn-collaborator|cc-bridge-keys)\b", "credential/spawn tool"),
    (r"\bclaude\s+(--bg|-p)\b", "claude --bg / claude -p spawn"),
    (r"\brailway\s+(up|deploy|variables?)\b", "railway deploy/variables"),
    (r"(?:^|[\s;&|(`])(printenv|env)(?=[\s;&|)`]|$)", "environment dump"),
]
SECRET_FILE = r"\.env|\.mcp\.json|\.pem|\.key|\.token|credentials\.json|\.netrc|\.npmrc"
BASH_SECRET_READ = r"(?:^|[\s;&|(`])(cat|head|tail|less|more|grep|rg|strings|xxd|base64|sed|awk)\b[^\n]*(?:" + SECRET_FILE + ")"
WRITE_TARGETS = ("trusted_keys.json", "CROSS_CLAUDE_", "settings.json", "settings.local.json", "/hooks/", ".claude/")
WRITE_OP_RE = re.compile(r">|(?:^|[\s;&|(`])(tee|mv|cp|rm|touch|chmod|dd|install|ln)\b|\bsed\s+(?:-[a-zA-Z]*i|--in-place)")
READ_SECRET_PATH = re.compile(SECRET_FILE + r"|\.config/cross-claude/(identity|bearer)|bearer", re.I)
WRITE_PATH_MARKERS = ("trusted_keys.json", "settings.json", "settings.local.json", "/hooks/", "/.claude/", ".config/cross-claude")
RAILWAY_TOOL_WORDS = ("deploy", "set-variables", "create-deployment", "redeploy", "accept-deploy", "update-service")


# --- copied from autopilot.py: root transcript resolution -------------------

def _projects_roots():
    roots = []
    cfg = os.environ.get("CLAUDE_CONFIG_DIR")
    if cfg:
        roots.append(os.path.join(cfg, "projects"))
    home = os.path.expanduser("~")
    roots.append(os.path.join(home, ".claude", "projects"))
    roots.append(os.path.join(home, ".claude-account2", "projects"))
    return roots


def find_session_transcript(session_id):
    try:
        if not isinstance(session_id, str) or not SESSION_ID_RE.match(session_id):
            return None
        for root in _projects_roots():
            for cand in sorted(glob.glob(os.path.join(root, "*", session_id + ".jsonl"))):
                if os.path.isfile(cand):
                    return cand
        return None
    except Exception:
        return None


def is_session_transcript(path):
    try:
        if not isinstance(path, str) or not path.endswith(".jsonl") or not os.path.isfile(path):
            return False
        if not SESSION_ID_RE.match(os.path.basename(path)[: -len(".jsonl")]):
            return False
        parent = os.path.dirname(os.path.dirname(os.path.realpath(path)))
        return any(os.path.isdir(r) and os.path.realpath(r) == parent for r in _projects_roots())
    except Exception:
        return False


def daemon_spawned(max_depth=12):
    try:
        out = subprocess.run(["ps", "-axo", "pid=,ppid=,command="], capture_output=True,
                             text=True, timeout=10).stdout
        table = {}
        for line in out.splitlines():
            parts = line.strip().split(None, 2)
            if len(parts) >= 2 and parts[0].isdigit() and parts[1].isdigit():
                table[int(parts[0])] = (int(parts[1]), parts[2] if len(parts) > 2 else "")
        if not table:
            return True
        pid = os.getpid()
        for _ in range(max_depth):
            if pid not in table:
                break
            ppid, cmd = table[pid]
            if any(m in " " + cmd for m in DAEMON_MARKERS):
                return True
            if ppid <= 1:
                break
            pid = ppid
        return False
    except Exception:
        return True


def root_transcript(payload):
    try:
        if not isinstance(payload, dict):
            payload = {}
        env_val = os.environ.get(ENV_ROOT)
        if env_val:
            if daemon_spawned():
                return None
            return env_val if is_session_transcript(env_val) else None
        found = find_session_transcript(payload.get("session_id"))
        if found:
            return found
        if "agent_id" not in payload:
            tp = payload.get("transcript_path")
            if isinstance(tp, str) and tp:
                return tp
        return None
    except Exception:
        return None


# --- copied from autopilot.py: human-typed entry detection ------------------

def human_typed_text(entry):
    if not isinstance(entry, dict) or entry.get("isMeta"):
        return None
    if entry.get("type") == "user":
        content = (entry.get("message") or {}).get("content")
        if not isinstance(content, str):
            return None
        if (entry.get("origin") or {}).get("kind") != "human":
            return None
        if entry.get("promptSource") == "suggestion_accepted":
            return None
        return content
    if entry.get("type") == "attachment":
        att = entry.get("attachment") or {}
        if att.get("type") != "queued_command":
            return None
        if (att.get("origin") or {}).get("kind") != "human":
            return None
        if att.get("commandMode") != "prompt":
            return None
        prompt = att.get("prompt")
        return prompt if isinstance(prompt, str) else None
    return None


# --- transcript and trust logic ---------------------------------------------

def read_entries(path):
    if not isinstance(path, str) or not path:
        raise OSError("no transcript path")
    with open(path, encoding="utf-8", errors="replace") as f:
        lines = [ln for ln in f.read().splitlines() if ln.strip()]
    entries = []
    for i, line in enumerate(lines):
        try:
            entries.append(json.loads(line))
        except ValueError:
            if i == len(lines) - 1:
                break  # partial final line while the session is still writing
            raise ValueError("malformed transcript line")
    return entries


def trusted_keys():
    path = os.environ.get(ENV_TRUSTED) or os.path.expanduser("~/.config/cross-claude/trusted_keys.json")
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}


def message_text(entry):
    msg = entry.get("message")
    content = msg.get("content") if isinstance(msg, dict) else None
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(i["text"] for i in content
                         if isinstance(i, dict) and i.get("type") == "text" and isinstance(i.get("text"), str))
    return ""


def trigger_like(entry):
    if not isinstance(entry, dict) or entry.get("type") != "user" or "toolUseResult" in entry:
        return False
    msg = entry.get("message")
    content = msg.get("content") if isinstance(msg, dict) else None
    if isinstance(content, list) and any(isinstance(i, dict) and i.get("type") == "tool_result" for i in content):
        return False
    if entry.get("isMeta") is True and "origin" not in entry:
        return False
    return True


def origin_kind(entry):
    origin = entry.get("origin")
    return origin.get("kind") if isinstance(origin, dict) else None


def trusted_message(text, trusted):
    """True only if every top-level envelope (outside body blocks) has a verified header
    whose key is a string entry in trusted_keys, and there is at least one envelope.
    Text inside a body block is never a header."""
    lines = [ln.rstrip() for ln in text.splitlines()]
    envelopes = 0
    in_body = None
    for i, line in enumerate(lines):
        if in_body is not None:
            if line == f"CROSS-CLAUDE-BODY {in_body}>>>":
                in_body = None
            continue
        m = BODY_OPEN_RE.match(line)
        if m:
            envelopes += 1
            hm = VERIFIED_HEADER_RE.match(lines[i - 1]) if i > 0 else None
            if not hm or not isinstance(trusted.get(hm.group(1)), str):
                return False
            in_body = m.group(1)
    return envelopes > 0


def taint(entries, trusted):
    """Walk backward. A later human-typed entry clears taint; an untrusted channel/peer
    entry taints. Trusted channel messages neither clear nor taint."""
    for entry in reversed(entries):
        if human_typed_text(entry) is not None:
            return False
        if not trigger_like(entry):
            continue
        if bridge_sourced(entry) and not trusted_message(message_text(entry), trusted):
            return True
    return False


def bridge_sourced(entry):
    """Only bridge traffic can carry a teammate. A channel push from the bridge server
    always counts (fail closed on any header). A peer (native SendMessage) entry counts
    only if it carries bridge text (courier path); a plain local peer is one of R's own
    same-machine sessions, and tainted sessions cannot SendMessage (denied below)."""
    origin = entry.get("origin") if isinstance(entry.get("origin"), dict) else {}
    kind = origin.get("kind")
    if kind == "channel":
        return origin.get("server") == "cross-claude-bridge"
    if kind == "peer":
        text = message_text(entry)
        return "CROSS-CLAUDE-BODY" in text or "cross-claude-bridge" in text
    return False


def team_listening(session_id):
    if os.environ.get(ENV_LISTENING) == "1":
        return True
    if isinstance(session_id, str) and SESSION_ID_RE.match(session_id):
        return os.path.exists(os.path.expanduser(f"~/.local/state/cross-claude/team-listening/{session_id}"))
    return False


# --- denial rules -----------------------------------------------------------

def denial(tool, tin):
    if not isinstance(tin, dict):
        tin = {}
    if tool == "Bash":
        cmd = str(tin.get("command") or "")
        for pattern, label in BASH_DENY:
            if re.search(pattern, cmd):
                return label
        if re.search(BASH_SECRET_READ, cmd):
            return "secret file read"
        if any(t in cmd for t in WRITE_TARGETS) and WRITE_OP_RE.search(cmd):
            return "write to protected config/hook path"
        return None
    if tool in ("Read", "Grep", "Glob"):
        keys = ("file_path", "path", "pattern") if tool == "Glob" else ("file_path", "path")
        for k in keys:
            v = tin.get(k)
            if isinstance(v, str) and READ_SECRET_PATH.search(v):
                return "secret path read"
        return None
    if tool in ("Write", "Edit", "NotebookEdit"):
        fp = str(tin.get("file_path") or tin.get("notebook_path") or "")
        if any(m in fp for m in WRITE_PATH_MARKERS):
            return "write to protected path"
        return None
    if tool == "Agent":
        return "Agent spawn"
    if tool == "SendMessage":
        return "SendMessage"
    if "railway" in tool.lower() and any(w in tool.lower() for w in RAILWAY_TOOL_WORDS):
        return "railway deploy/config tool"
    if tool.endswith("__send"):
        to = str(tin.get("to") or "")
        if to.startswith("dm-") or not to.startswith("#"):
            return "bridge send to non-team target"
    return None


def emit_deny(rule):
    print(json.dumps({"hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": "deny",
        "permissionDecisionReason": f"teammate-turn-guard: {rule} is blocked in a turn started by a teammate's message; needs R",
    }}))


def main():
    try:
        payload = json.loads(sys.stdin.read())
    except ValueError:
        sys.stderr.write("teammate-turn-guard: unreadable hook input; allowing\n")
        return 0
    if not isinstance(payload, dict):
        return 0
    tool = str(payload.get("tool_name") or "")
    tin = payload.get("tool_input")
    session_id = payload.get("session_id")

    path = root_transcript(payload)
    if path is None and "agent_id" not in payload:
        path = payload.get("transcript_path")
    try:
        entries = read_entries(path)
    except (OSError, ValueError, TypeError) as e:
        if team_listening(session_id):
            rule = denial(tool, tin)
            if rule:
                emit_deny(rule)
            return 0
        sys.stderr.write(f"teammate-turn-guard: transcript unreadable ({type(e).__name__}); allowing, session not team-listening\n")
        return 0

    if not taint(entries, trusted_keys()):
        return 0
    rule = denial(tool, tin)
    if rule:
        emit_deny(rule)
    return 0


if __name__ == "__main__":
    sys.exit(main())
