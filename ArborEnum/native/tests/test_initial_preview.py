"""Verify that the actual GUI displays a root before the initial solve returns.
Usage: python3 test_initial_preview.py BINARY BUILDER_HTML (requires Playwright).
"""
from pathlib import Path
import random
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
from playwright.sync_api import sync_playwright


def main():
    binary, html = (str(Path(arg).resolve()) for arg in sys.argv[1:3])
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0)); port = sock.getsockname()[1]
    base = f'http://127.0.0.1:{port}'
    process = subprocess.Popen([binary, '--ui', html, '--port', str(port)], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    try:
        deadline = time.monotonic() + 10
        while True:
            try:
                with urllib.request.urlopen(base + '/api/health', timeout=1):
                    break
            except OSError:
                assert process.poll() is None and time.monotonic() < deadline
                time.sleep(.05)
        with tempfile.TemporaryDirectory() as tmp, sync_playwright() as p:
            csv = Path(tmp) / 'initial.csv'
            # Random masks avoid the very small cached DAG of a full binary
            # cube, keeping the initial pass active beyond the UI's 500 ms poll.
            rng = random.Random(812)
            words = [rng.getrandbits(20) for _ in range(1024)]
            csv.write_text(','.join([f'bit{f}' for f in range(20)] + ['label']) + '\n' +
                           '\n'.join(','.join([str((i >> f) & 1) for f in range(20)] + [str(i.bit_count() % 2)]) for i in words))
            browser = p.chromium.launch(headless=True, args=['--no-sandbox'])
            page = browser.new_page(viewport={'width': 1600, 'height': 1000})
            errors, requests = [], []
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.on('request', lambda request: requests.append(request.url))
            page.goto(base)
            page.get_by_role('button', name='Upload', exact=True).click()
            page.get_by_role('menuitem', name='Upload dataset').click()
            page.locator('.live-file input').set_input_files(str(csv))
            page.get_by_label('Maximum depth', exact=True).fill('8')
            page.get_by_label('Leaf penalty', exact=True).fill('.002')
            page.get_by_label('Rashomon multiplier', exact=True).fill('2')
            with page.expect_response(lambda r: '/api/node?' in r.url, timeout=30000) as reply:
                page.get_by_role('button', name='Start ArborEnum', exact=True).click()
            view = reply.value.json()
            assert reply.value.status == 200 and view['checkpoint'] == 0, view
            page.wait_for_function('(sid) => window.ARBORENUM_CURRENT_BUILDER_PAYLOAD?.graph?.metadata?.session_id === sid', arg=view['session_id'])
            page.wait_for_function("!document.querySelector('.native-query-status')")
            assert page.locator('.arborenum-node-choice').count() == 1
            status = page.request.get(base + '/api/session').json()
            assert status['ready'] and status['checkpoint'] == 0 and status['phase'] == 'running', status
            page.get_by_role('button', name='Stop', exact=True).click()
            deadline = time.monotonic() + 10
            while status['phase'] == 'running':
                assert time.monotonic() < deadline
                time.sleep(.01)
                status = page.request.get(base + '/api/session').json()
            assert status['ready'] and status['phase'] == 'stopped' and status['checkpoint'] == 0, status
            assert not errors, errors
            assert not any('/api/snapshot' in url for url in requests)
            browser.close()
        print('GUI root displayed and queried before the initial checkpoint; Stop retained the feasible native root')
    finally:
        process.terminate()
        try: output = process.communicate(timeout=15)[0]
        except subprocess.TimeoutExpired:
            process.kill(); process.communicate()
            raise AssertionError('Native service did not shut down cooperatively')
        if process.returncode != 0:
            print(output, file=sys.stderr)
            assert process.returncode == 0


if __name__ == '__main__': main()
