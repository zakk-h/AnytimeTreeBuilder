"""Run a moved, standalone desktop binary with no external HTML or Node runtime.
Usage: python3 test_desktop.py BINARY EXPECTED_HTML
"""
import hashlib
import http.cookiejar
import json
import os
from pathlib import Path
import queue
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request


def stop(process):
    if process.poll() is None:
        if os.name == 'nt': process.send_signal(signal.CTRL_BREAK_EVENT)
        else: process.terminate()
    try: process.wait(timeout=15)
    except subprocess.TimeoutExpired:
        process.kill(); process.wait()
        raise AssertionError('Application did not shut down cooperatively')
    assert process.returncode == 0, process.returncode


def start(binary, cwd, args, env):
    process = subprocess.Popen([str(binary), *args], cwd=cwd, env=env,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
        creationflags=getattr(subprocess, 'CREATE_NEW_PROCESS_GROUP', 0))
    lines = queue.Queue()
    def read():
        for line in process.stdout: lines.put(line)
    threading.Thread(target=read, daemon=True).start()
    deadline = time.monotonic() + 15
    output = []
    while time.monotonic() < deadline:
        try: line = lines.get(timeout=.2)
        except queue.Empty:
            assert process.poll() is None, ''.join(output)
            continue
        output.append(line)
        if line.startswith('Interactive Tree Builder: '):
            return process, line.strip().split('Interactive Tree Builder: ', 1)[1]
    process.kill(); process.wait()
    raise AssertionError('No local URL printed: ' + ''.join(output))


def main():
    binary, html = (Path(arg).resolve() for arg in sys.argv[1:3])
    expected = html.read_bytes()
    with tempfile.TemporaryDirectory(prefix='Anytime Tree Builder ') as tmp:
        directory = Path(tmp)
        moved = directory / binary.name
        shutil.copy2(binary, moved)
        env = dict(os.environ, RENDER_EXTERNAL_HOSTNAME='must-be-ignored.example')
        first, base = start(moved, tmp, ['--no-browser'], env)
        second = None
        try:
            second, second_base = start(moved, tmp, ['--no-browser'], env)
            assert base != second_base and base.startswith('http://127.0.0.1:')
            client = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
            def call(path, body=None, headers=None):
                request = urllib.request.Request(base + path,
                    data=None if body is None else json.dumps(body).encode(),
                    headers={'Content-Type': 'application/json', **(headers or {})})
                with client.open(request, timeout=30) as reply: return json.load(reply)
            with client.open(base, timeout=10) as reply:
                assert hashlib.sha256(reply.read()).digest() == hashlib.sha256(expected).digest(), 'Embedded UI differs from the current production build'
            try: call('/api/health', headers={'Host': 'must-be-ignored.example'})
            except urllib.error.HTTPError as error: assert error.code == 403
            else: raise AssertionError('Desktop app accepted a non-loopback host')
            assert call('/api/health')['protocol'] == 2
            dataset = {'feature_names': ['workingday'], 'class_names': ['no', 'yes'],
                       'X': [[0], [0], [1], [1]], 'y': [0, 0, 1, 1],
                       'settings': {'depth_budget': 2, 'runtime_limit_seconds': 2}}
            sid = call('/api/session', dataset)['session_id']
            deadline = time.monotonic() + 15
            while not call('/api/session')['ready']:
                assert time.monotonic() < deadline
                time.sleep(.02)
            query = {'tree': {'uid': 0, 'kind': 'choice'}, 'active_uid': 0}
            view = call('/api/node?session_id=' + sid, query)
            assert view['options']['splits'], view
            completion = call('/api/complete?session_id=' + sid, {**query, 'next_uid': 1, 'mode': 'optimal'})
            assert completion['tree']['kind'] == 'split', completion
            assert call('/api/session')['full_graph_exports'] == 0
        finally:
            stop(first)
            if second: stop(second)

        if sys.platform.startswith('linux'):
            # Default double-click behavior opens the exact chosen local port.
            # A fixture opener avoids starting a real browser in automated tests.
            helpers = directory / 'helpers'; helpers.mkdir()
            capture = directory / 'opened-url.txt'
            opener = helpers / 'xdg-open'
            opener.write_text('#!/bin/sh\nprintf "%s" "$1" > "$ATB_OPEN_CAPTURE"\n')
            opener.chmod(0o755)
            env.update(PATH=str(helpers) + os.pathsep + '/usr/bin:/bin', ATB_OPEN_CAPTURE=str(capture))
            process, url = start(moved, tmp, [], env)
            try:
                deadline = time.monotonic() + 10
                while not capture.exists():
                    assert time.monotonic() < deadline
                    time.sleep(.02)
                assert capture.read_text() == url
            finally: stop(process)
        invalid = subprocess.run([str(moved), '--port', '8765garbage'], cwd=tmp, capture_output=True, text=True)
        assert invalid.returncode != 0 and 'Invalid port' in invalid.stderr
    print('Standalone embedded UI, free ports, browser launch, loopback-only access, native enumeration/completion and cooperative shutdown passed')


if __name__ == '__main__': main()
