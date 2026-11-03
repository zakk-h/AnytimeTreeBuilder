"""Exercise native path queries and completions over the actual C++ HTTP service.
Usage: python3 test_live_api.py BINARY BUILDER_HTML
"""
import concurrent.futures
import json
import http.cookiejar
from pathlib import Path
import socket
import signal
import random
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request


def main():
    binary, html = map(lambda s: str(Path(s).resolve()), sys.argv[1:3])
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0)); port = sock.getsockname()[1]
    base = f'http://127.0.0.1:{port}'
    client = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
    process = subprocess.Popen([binary, '--ui', html, '--port', str(port)], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, creationflags=getattr(subprocess, 'CREATE_NEW_PROCESS_GROUP', 0))
    def call(path, body=None, headers=None):
        request = urllib.request.Request(base + path, data=None if body is None else json.dumps(body).encode(), headers={'Content-Type': 'application/json', **(headers or {})})
        try:
            with client.open(request, timeout=65) as response:
                data = response.read()
                return response.status, json.loads(data) if data else None
        except urllib.error.HTTPError as error:
            return error.code, json.loads(error.read())
    try:
        deadline = time.monotonic() + 10
        while True:
            try:
                assert call('/api/health')[1]['protocol'] == 2
                break
            except OSError:
                assert process.poll() is None and time.monotonic() < deadline
                time.sleep(.05)
        assert call('/api/session') == (200, None)
        assert call('/api/snapshot')[0] == 410
        for host in ('localhost:62357', '127.0.0.1:62357', '[::1]:62357'):
            assert call('/api/health', headers={'Host': host, 'Origin': 'http://localhost:62357'})[0] == 200
        for headers in ({'Host': 'example.com'}, {'Origin': 'https://example.com'}, {'Host': 'localhost.evil.test:62357'}, {'Origin': 'null'}):
            assert call('/api/health', headers=headers)[0] == 403
        assert call('/api/session', {}, {'Content-Type': 'text/plain'})[0] == 415
        assert call('/api/session', {'settings': {'unknown': 1}})[0] == 400
        # A deliberately broad binary initial solve: query and cancel before
        # its first coarse checkpoint, then keep exploring the retained model.
        # Avoid the tiny cached DAG of a full binary cube on faster machines.
        rng = random.Random(812)
        words = [rng.getrandbits(20) for _ in range(1024)]
        early = {'feature_names': [f'bit{f}' for f in range(20)], 'class_names': ['no', 'yes'],
                 'X': [[(i >> f) & 1 for f in range(20)] for i in words],
                 'y': [i.bit_count() % 2 for i in words],
                 'settings': {'depth_budget': 8, 'lambda_reg': .002, 'rashomon_mult': 2, 'runtime_limit_seconds': 1}}
        code, status = call('/api/session', early)
        assert code == 202, status
        early_id = status['session_id']
        deadline = time.monotonic() + 30
        while not status['ready']:
            assert time.monotonic() < deadline and status['phase'] != 'failed', status
            time.sleep(.001)
            status = call('/api/session')[1]
        assert status['checkpoint'] == 0 and status['phase'] == 'running', status
        early_query = {'tree': {'uid': 0, 'kind': 'choice'}, 'active_uid': 0}
        code, view = call('/api/node?session_id=' + early_id, early_query)
        assert code == 200 and view['checkpoint'] == 0 and view['visited_nodes'] == 1, view
        assert call('/api/stop?session_id=' + early_id, {})[0] == 202
        while status['phase'] not in ('stopped', 'finished'):
            assert time.monotonic() < deadline
            status = call('/api/session')[1]
            time.sleep(.001)
        assert status['phase'] == 'stopped' and status['ready'] and status['checkpoint'] == 0, status
        assert call('/api/complete?session_id=' + early_id, {**early_query, 'next_uid': 1, 'mode': 'optimal'})[0] == 200
        dataset = {'feature_names': ['x', 'z'], 'class_names': ['no', 'yes'], 'X': [[i, (i * 17) % 180] for i in range(180)], 'y': [(i // 11) % 2 for i in range(180)], 'settings': {'depth_budget': 4, 'runtime_limit_seconds': 5, 'rashomon_mult': .2}}
        code, status = call('/api/session', dataset)
        assert code == 202, status
        sid = status['session_id']
        assert call('/api/node?session_id=wrong', {})[0] == 409
        assert call('/api/session', dataset)[0] == 409
        deadline = time.monotonic() + 30
        while not call('/api/session')[1]['ready']:
            assert time.monotonic() < deadline
            time.sleep(.01)
        assert call('/api/meta?session_id=' + sid)[1]['featureRegistry']
        root = {'uid': 0, 'kind': 'choice'}
        query = {'tree': root, 'active_uid': 0}
        code, view = call('/api/node?session_id=' + sid, query)
        assert code == 200 and view['visited_nodes'] == 1 and 'graph' not in view, view
        first_feature = view['options']['splits'][0]['feature']
        selected = {'uid': 0, 'kind': 'split', 'feature': first_feature, 'left': {'uid': 1, 'kind': 'choice'}, 'right': {'uid': 2, 'kind': 'choice'}}
        code, view = call('/api/node?session_id=' + sid, {'tree': selected, 'active_uid': 1})
        assert code == 200 and view['visited_nodes'] == 3 and view['options']['uid'] == 1, view
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as readers:
            results = list(readers.map(lambda _: call('/api/node?session_id=' + sid, query), range(12)))
            assert all(code == 200 and result['visited_nodes'] == 1 for code, result in results)
        for mode in ('optimal', 'random', 'constrained'):
            request = {**query, 'next_uid': 1, 'mode': mode, 'constraint': {'mode': 'avoid', 'forbiddenInternalFeatures': []} if mode == 'constrained' else {}}
            code, result = call('/api/complete?session_id=' + sid, request)
            assert code == 200 and 'tree' in result and 'graph' not in result, result
            code, completed_view = call('/api/node?session_id=' + sid, {'tree': result['tree'], 'active_uid': 0})
            assert code == 200 and not completed_view['options']['splits'], completed_view
        assert call('/api/stop?session_id=' + sid, {})[0] == 202
        deadline = time.monotonic() + 10
        while call('/api/session')[1]['phase'] not in ('stopped', 'finished'):
            assert time.monotonic() < deadline
            time.sleep(.01)
        assert call('/api/node?session_id=' + sid, query)[0] == 200
        assert call('/api/session')[1]['full_graph_exports'] == 0
        # New dynamic-budget/focus session: allow work to finish, then increase
        # the root objective budget without rebuilding or losing the graph.
        tiny = {'feature_names': ['a', 'b'], 'class_names': ['no', 'yes'],
                'X': [[(i >> 1) & 1, i & 1] for i in range(64)],
                'y': [i % 2 for i in range(64)],
                'settings': {'depth_budget': 2, 'lambda_reg': .01,
                             'rashomon_mult': .01, 'second_rashomon_mult': .01,
                             'runtime_limit_seconds': 3}}
        code, fresh = call('/api/session', tiny)
        assert code == 202, fresh
        new_id = fresh['session_id']
        until = time.monotonic() + 20
        while fresh['phase'] != 'finished':
            assert time.monotonic() < until and fresh['phase'] != 'failed', fresh
            time.sleep(.025)
            fresh = call('/api/session')[1]
        q = '/api/node?session_id=' + new_id
        root_query = {'tree': {'uid': 0, 'kind': 'choice'}, 'active_uid': 0}
        code, before = call(q, root_query)
        assert code == 200, before
        target = before['root_budget'] + 1
        code, submitted = call('/api/budget?session_id=' + new_id, {'budget': target})
        assert code == 202 and submitted['requested_root_budget'] == target, submitted
        until = time.monotonic() + 20
        while True:
            state = call('/api/session')[1]
            if state['actual_root_budget'] >= target and state['phase'] == 'finished':
                break
            assert time.monotonic() < until and state['phase'] != 'failed', state
            time.sleep(.025)
        code, grown = call(q, root_query)
        assert code == 200 and grown['root_budget'] >= target, grown
        # Decrease is non-destructive: the requested display cap changes but
        # already computed native solutions remain valid and queryable.
        code, lowered = call('/api/budget?session_id=' + new_id,
                             {'budget': before['root_budget']})
        assert code == 202 and lowered['requested_root_budget'] == before['root_budget']
        assert call(q, root_query)[1]['root_budget'] >= target
        # Both normal completion and superseded focus use cooperative unwind.
        assert call('/api/focus?session_id=' + new_id, root_query)[0] == 202
        assert call('/api/focus?session_id=' + new_id, root_query)[0] == 202
        until = time.monotonic() + 20
        while True:
            state = call('/api/session')[1]
            if not state['focus_requested'] and not state['focus_running']:
                break
            assert time.monotonic() < until and not state['focus_error'], state
            time.sleep(.025)
        assert not state['focus_error'], state
        print('Native HTTP node-path queries, all completion modes, concurrent readers, zero exports, stop retention and preview origins passed')
    finally:
        if os.name == 'nt': process.send_signal(signal.CTRL_BREAK_EVENT)
        else: process.terminate()
        try: output = process.communicate(timeout=15)[0]
        except subprocess.TimeoutExpired:
            process.kill(); process.communicate()
            raise AssertionError('Native service did not shut down cooperatively')
        if process.returncode != 0:
            print(output, file=sys.stderr)
            assert process.returncode == 0
if __name__ == '__main__': main()
