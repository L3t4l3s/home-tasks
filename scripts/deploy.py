"""Deploy custom_components/home_tasks to the live HA instance via SSH (tar-pipe).

Usage:
    python scripts/deploy.py --host HOST --user USER --password PASSWORD

Connection parameters can also be set via environment variables:
    HT_SSH_HOST      SSH hostname or IP of the HA VM
    HT_SSH_PORT      SSH port (default: 22)
    HT_SSH_USER      SSH user
    HT_SSH_PASSWORD  SSH password
    HT_HA_TOKEN      HA long-lived access token (same as live tests .env)
    HT_HA_URL        HA base URL, e.g. http://homeassistant.local:8123

All of these must be supplied — there are no baked-in defaults.

After upload the script reloads every home_tasks config entry via the HA
WebSocket API so the new code is active without a full HA restart.
"""
from __future__ import annotations

import argparse
import io
import os
import sys
import tarfile
import time

# ---------------------------------------------------------------------------
# Third-party (paramiko must be installed: pip install paramiko)
# ---------------------------------------------------------------------------
try:
    import paramiko
except ImportError:
    sys.exit("paramiko is not installed.  Run: pip install paramiko")

try:
    import websocket  # websocket-client
    import json as _json
except ImportError:
    websocket = None  # type: ignore[assignment]

# ---------------------------------------------------------------------------
# Connection parameters — read from env vars, no hard-coded defaults
# ---------------------------------------------------------------------------
DEFAULT_HOST = os.environ.get("HT_SSH_HOST", "")
DEFAULT_PORT = int(os.environ.get("HT_SSH_PORT", "22"))
DEFAULT_USER = os.environ.get("HT_SSH_USER", "")
DEFAULT_PASSWORD = os.environ.get("HT_SSH_PASSWORD", "")
_ha_url = os.environ.get("HT_HA_URL", "").rstrip("/")
HA_WS_URL = _ha_url.replace("http://", "ws://").replace("https://", "wss://") + "/api/websocket"
HA_REST_URL = _ha_url
HA_TOKEN_ENV = "HT_HA_TOKEN"  # Same env var used by live tests (.env file)

SRC_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "custom_components",
    "home_tasks",
)
DEST_DIR = "/homeassistant/custom_components/home_tasks"


# ---------------------------------------------------------------------------
# Build in-memory tar archive of the source directory
# ---------------------------------------------------------------------------

def build_tar(src_dir: str) -> bytes:
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        for root, dirs, files in os.walk(src_dir):
            # Skip __pycache__ and .pyc files
            dirs[:] = [d for d in dirs if d != "__pycache__"]
            for fname in files:
                if fname.endswith(".pyc"):
                    continue
                full_path = os.path.join(root, fname)
                arcname = os.path.relpath(full_path, src_dir)
                tar.add(full_path, arcname=arcname)
    return buf.getvalue()


# ---------------------------------------------------------------------------
# SSH helpers
# ---------------------------------------------------------------------------

def _run(chan: paramiko.Channel, cmd: str) -> tuple[int, str]:
    """Execute a command on an already-open SSH transport."""
    chan.exec_command(cmd)
    stdout = b""
    stderr = b""
    while True:
        if chan.recv_ready():
            stdout += chan.recv(4096)
        if chan.recv_stderr_ready():
            stderr += chan.recv_stderr(4096)
        if chan.exit_status_ready():
            break
        time.sleep(0.05)
    # drain
    while chan.recv_ready():
        stdout += chan.recv(4096)
    while chan.recv_stderr_ready():
        stderr += chan.recv_stderr(4096)
    rc = chan.recv_exit_status()
    return rc, (stdout + stderr).decode(errors="replace")


def deploy_via_tar(host: str, port: int, user: str, password: str) -> None:
    print(f"[deploy] Building tar archive of {SRC_DIR} …")
    tar_data = build_tar(SRC_DIR)
    print(f"[deploy] Archive size: {len(tar_data):,} bytes")

    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    print(f"[deploy] Connecting to {user}@{host}:{port} …")
    client.connect(host, port=port, username=user, password=password, timeout=15)

    transport = client.get_transport()
    assert transport is not None

    # 1. Ensure dest parent exists
    chan = transport.open_session()
    rc, out = _run(chan, f"mkdir -p {os.path.dirname(DEST_DIR)}")
    if rc != 0:
        print(f"[deploy] mkdir warning: {out}")

    # 2. Take ownership of any existing files, then clear them out.
    # After a full HA restart the `homeassistant` docker container re-
    # creates parts of the tree under root:root, which breaks a plain
    # `rm -rf` run as the ssh user.  Chown first (sudo), then remove.
    chan = transport.open_session()
    rc, out = _run(
        chan,
        f"echo {password} | sudo -S chown -R {user}:{user} {DEST_DIR} 2>/dev/null || true",
    )
    chan = transport.open_session()
    rc, out = _run(chan, f"rm -rf {DEST_DIR}")
    if rc != 0:
        print(f"[deploy] rm warning: {out}")

    # 3. Pipe tar into the remote directory
    extract_cmd = f"mkdir -p {DEST_DIR} && tar -xzf - -C {DEST_DIR}"
    chan = transport.open_session()
    chan.exec_command(extract_cmd)

    chunk = 32768
    sent = 0
    while sent < len(tar_data):
        n = chan.send(tar_data[sent : sent + chunk])
        sent += n
    chan.shutdown_write()

    stdout = b""
    stderr = b""
    while True:
        if chan.recv_ready():
            stdout += chan.recv(4096)
        if chan.recv_stderr_ready():
            stderr += chan.recv_stderr(4096)
        if chan.exit_status_ready():
            break
        time.sleep(0.05)
    rc = chan.recv_exit_status()
    if rc != 0:
        msg = (stdout + stderr).decode(errors="replace")
        client.close()
        sys.exit(f"[deploy] tar extract failed (rc={rc}): {msg}")

    # 4. Fix ownership
    chan = transport.open_session()
    rc, out = _run(
        chan,
        f"echo {password} | sudo -S chown -R {user}:{user} {DEST_DIR} 2>/dev/null || true",
    )

    # 5. Verify
    chan = transport.open_session()
    rc, out = _run(chan, f"ls {DEST_DIR}/*.py | head -5")
    print(f"[deploy] Deployed files:\n{out.strip()}")

    client.close()
    print("[deploy] SSH deploy complete.")


# ---------------------------------------------------------------------------
# HA reload — fetches entry IDs via REST, reloads each via WebSocket service call
# ---------------------------------------------------------------------------

def reload_via_websocket(ha_token: str) -> None:
    """Reload all home_tasks config entries.

    Uses the REST API to list entries (avoids the WebSocket
    config_entries/get command that is absent in some HA versions), then
    calls the homeassistant.reload_config_entry service for each entry via
    the WebSocket API.
    """
    import urllib.request as _urlreq

    # 1. Fetch entry list via REST — always available
    rest_url = f"{HA_REST_URL}/api/config/config_entries/entry?domain=home_tasks"
    req = _urlreq.Request(
        rest_url,
        headers={"Authorization": f"Bearer {ha_token}"},
    )
    try:
        with _urlreq.urlopen(req, timeout=10) as resp:
            entries = _json.loads(resp.read())
    except Exception as exc:
        print(f"[reload] Could not list config entries: {exc}")
        print("[reload] Reload manually via HA Settings -> Integrations.")
        return

    print(f"[reload] Found {len(entries)} home_tasks config entries")

    if websocket is None:
        print("[reload] websocket-client not installed — skipping reload")
        return

    import websocket as ws_mod

    print(f"[reload] Connecting to {HA_WS_URL} ...")
    ws = ws_mod.create_connection(HA_WS_URL, timeout=10)

    def recv() -> dict:
        return _json.loads(ws.recv())

    def send(msg: dict) -> None:
        ws.send(_json.dumps(msg))

    # Auth handshake
    hello = recv()
    assert hello["type"] == "auth_required", hello
    send({"type": "auth", "access_token": ha_token})
    auth_ok = recv()
    assert auth_ok["type"] == "auth_ok", f"Auth failed: {auth_ok}"

    # 2. Reload each entry via homeassistant.reload_config_entry service
    for i, entry in enumerate(entries, start=1):
        entry_id = entry["entry_id"]
        title = entry.get("title", entry_id).encode("ascii", "replace").decode()
        send({
            "id": i,
            "type": "call_service",
            "domain": "homeassistant",
            "service": "reload_config_entry",
            "service_data": {"entry_id": entry_id},
        })
        r = recv()
        ok = r.get("success", False)
        print(f"[reload]   {'OK' if ok else 'FAIL'}: {title}")

    ws.close()
    print("[reload] All entries reloaded.")


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# Full HA restart — required for Python code changes to be picked up
# (config_entry reload only re-instantiates entries; Python modules stay cached)
# ---------------------------------------------------------------------------

def restart_ha(ha_token: str) -> None:
    import urllib.request as _urlreq
    import urllib.error as _urlerr

    print("[restart] Triggering HA core restart ...")
    req = _urlreq.Request(
        f"{HA_REST_URL}/api/services/homeassistant/restart",
        data=b"{}",
        headers={
            "Authorization": f"Bearer {ha_token}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        _urlreq.urlopen(req, timeout=8)
    except (TimeoutError, _urlerr.URLError, OSError) as exc:
        # Connection drop is EXPECTED during restart.
        print(f"[restart] Restart triggered (connection drop expected): {exc}")

    # Wait for HA to come back
    print("[restart] Waiting for HA to come back online ...", end="", flush=True)
    deadline = time.time() + 180
    ok_req = _urlreq.Request(
        f"{HA_REST_URL}/api/",
        headers={"Authorization": f"Bearer {ha_token}"},
    )
    while time.time() < deadline:
        time.sleep(3)
        try:
            with _urlreq.urlopen(ok_req, timeout=5) as resp:
                if resp.status == 200:
                    print("\n[restart] HA is back online.")
                    # Give integrations a few seconds to finish loading
                    time.sleep(5)
                    return
        except Exception:
            print(".", end="", flush=True)
    raise RuntimeError("HA did not come back online within 3 minutes")


def main() -> None:
    ap = argparse.ArgumentParser(
        description="Deploy home_tasks to live HA",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Connection params can also be supplied via env vars:\n"
            "  HT_SSH_HOST, HT_SSH_PORT, HT_SSH_USER, HT_SSH_PASSWORD\n"
            "  HT_HA_URL, HT_HA_TOKEN\n"
            "\n"
            "Default post-deploy action is a full HA restart (required for\n"
            "Python code changes).  --reload-only skips the restart and only\n"
            "reloads config entries (sufficient for data-only changes)."
        ),
    )
    ap.add_argument("--host", default=DEFAULT_HOST, help="SSH host (env: HT_SSH_HOST)")
    ap.add_argument("--port", type=int, default=DEFAULT_PORT, help="SSH port (env: HT_SSH_PORT)")
    ap.add_argument("--user", default=DEFAULT_USER, help="SSH user (env: HT_SSH_USER)")
    ap.add_argument("--password", default=DEFAULT_PASSWORD, help="SSH password (env: HT_SSH_PASSWORD)")
    group = ap.add_mutually_exclusive_group()
    group.add_argument(
        "--reload-only", action="store_true",
        help="Reload config entries instead of restarting HA (data-only changes)",
    )
    group.add_argument(
        "--no-restart", action="store_true",
        help="Skip the restart AND the reload — deploy files only",
    )
    args = ap.parse_args()

    missing = [name for name, val in [("--host", args.host), ("--user", args.user), ("--password", args.password)] if not val]
    if missing:
        ap.error(f"Required: {', '.join(missing)}  (set via CLI or env vars HT_SSH_HOST / HT_SSH_USER / HT_SSH_PASSWORD)")

    deploy_via_tar(args.host, args.port, args.user, args.password)

    if args.no_restart:
        print("[deploy] --no-restart set, skipping restart and reload")
        return

    ha_token = os.environ.get(HA_TOKEN_ENV, "")
    if not ha_token:
        print(
            f"[deploy] {HA_TOKEN_ENV} env var not set — skipping restart/reload.\n"
            "         Restart HA manually for Python code changes to take effect."
        )
        return

    time.sleep(1)
    if args.reload_only:
        reload_via_websocket(ha_token)
    else:
        restart_ha(ha_token)


if __name__ == "__main__":
    main()
