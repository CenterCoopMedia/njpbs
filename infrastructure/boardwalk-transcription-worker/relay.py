"""Keep the GPU worker's credential in memory and supervise its SSH lifetime."""
import argparse
import json
from pathlib import Path
import re
import signal
import subprocess
import threading


def run(config):
    argv = config['argv']
    if not isinstance(argv, list) or not argv or any(not isinstance(arg, str) for arg in argv):
        raise ValueError('Invalid worker command')
    # This file is an operator-owned service configuration, never a staff input.
    credential_command = config.get('credential_command')
    if (not isinstance(credential_command, list) or not credential_command
            or any(not isinstance(arg, str) or not arg for arg in credential_command)):
        raise ValueError('Invalid credential command')
    credential = subprocess.run(
        credential_command, capture_output=True, text=True, timeout=30, check=True,
    ).stdout.splitlines()[0]
    if not re.fullmatch(r'[A-Za-z0-9]{48}', credential):
        raise ValueError('Worker credential unavailable')
    stop = threading.Event()
    for signum in (signal.SIGINT, signal.SIGTERM):
        signal.signal(signum, lambda *_: stop.set())
    child = subprocess.Popen(argv, stdin=subprocess.PIPE, text=True)
    try:
        child.stdin.write(json.dumps({'token': credential}) + '\n')
        child.stdin.flush()
        credential = None
        print('Worker relay connected', flush=True)
        while child.poll() is None and not stop.wait(1):
            pass
    finally:
        # EOF stops the remote worker and its owned GPU child before SSH exits.
        try:
            child.stdin.close()
        except OSError:
            pass
        try:
            child.wait(timeout=45)
        except subprocess.TimeoutExpired:
            child.terminate()
            try:
                child.wait(timeout=10)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()
    return 0 if stop.is_set() else (child.returncode or 1)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', type=Path, required=True)
    args = parser.parse_args()
    try:
        result = run(json.loads(args.config.read_text()))
    except Exception:
        # Exceptions from credential retrieval can contain captured secret data.
        print('Worker relay unavailable', flush=True)
        result = 1
    raise SystemExit(result)
