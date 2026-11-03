"""Measure native enumeration time spent servicing realistic 2-second node polls.

Usage: python3 benchmark_node_polling.py BINARY BUILDER_HTML
The percentage is measured handler time / elapsed session time, not a
paired controlled wall-time slowdown benchmark.
"""
import http.cookiejar
import json
from pathlib import Path
import random
import socket
import subprocess
import sys
import time
import urllib.request


def main():
    binary, html = (str(Path(path).resolve()) for path in sys.argv[1:3])
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    base = f'http://127.0.0.1:{port}'
    client = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))

    def request(path, payload=None):
        data = json.dumps(payload).encode() if payload is not None else None
        headers = {'Content-Type': 'application/json'} if payload is not None else {}
        with client.open(urllib.request.Request(base + path, data=data, headers=headers), timeout=20) as res:
            return json.load(res)

    process = subprocess.Popen([binary, '--ui', html, '--port', str(port)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        deadline = time.monotonic() + 10
        while True:
            try:
                request('/api/health')
                break
            except OSError:
                assert time.monotonic() < deadline and process.poll() is None
                time.sleep(.05)

        rng = random.Random(812)
        words = [rng.getrandbits(20) for _ in range(1024)]
        data = {
            'feature_names': [f'bit{f}' for f in range(20)],
            'class_names': ['no', 'yes'],
            'X': [[(i >> f) & 1 for f in range(20)] for i in words],
            'y': [i.bit_count() % 2 for i in words],
            'settings': {
                'depth_budget': 8, 'lambda_reg': .002, 'rashomon_mult': 2,
                'runtime_limit_seconds': 20,
            },
        }
        status = request('/api/session', data)
        sid = status['session_id']
        deadline = time.monotonic() + 30
        while not status['ready']:
            assert time.monotonic() < deadline and status['phase'] != 'failed', status
            time.sleep(.05)
            status = request('/api/session')
        # Query at the same frequency as the fast auto-refresh phase.
        start = time.monotonic()
        durations = []
        while time.monotonic() - start < 10:
            target = start + 2 * (len(durations) + 1)
            time.sleep(max(0, target - time.monotonic()))
            if time.monotonic() - start >= 11:
                break
            before = time.monotonic()
            try:
                view = request('/api/node?session_id=' + sid, {
                    'tree': {'uid': 0, 'kind': 'choice'}, 'active_uid': 0,
                })
                assert view['visited_nodes'] == 1
            except Exception as exc:
                print('Benchmark query was unavailable:', exc)
                break
            durations.append(time.monotonic() - before)
        status = request('/api/session')
        handler = status['node_query_handler_seconds']
        elapsed = status['elapsed_seconds']
        print(f'POLLING BENCHMARK: queries={len(durations)}, mean_http_latency_ms={1000 * sum(durations) / max(len(durations), 1):.3f}, '
              f'native_query_handler_ms={1000 * handler:.3f}, elapsed_seconds={elapsed:.3f}, '
              f'handler_fraction_percent={100 * handler / elapsed:.5f}, phase={status["phase"]}')
        assert durations, 'Benchmark did not issue a successful node query'
        assert handler >= 0
    finally:
        process.terminate()
        try:
            process.wait(timeout=15)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()


if __name__ == '__main__':
    main()
