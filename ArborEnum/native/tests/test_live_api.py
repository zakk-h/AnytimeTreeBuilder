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
        tiny = {'feature_names': ['constant'], 'class_names': ['no', 'yes'], 'X': [[0]] * 4, 'y': [0, 1, 0, 1],
                'settings': {'depth_budget': 0, 'lambda_reg': .25, 'allow_abstain': True, 'abstain_cost': .25, 'rashomon_mult': 2}}
        code, tiny_status = call('/api/session', tiny)
        assert code == 202, tiny_status
        tiny_id = tiny_status['session_id']
        deadline = time.monotonic() + 10
        while call('/api/session')[1]['phase'] != 'finished':
            assert time.monotonic() < deadline
            time.sleep(.001)
        tiny_tree = {'uid': 0, 'kind': 'choice'}
        analysis_url = '/api/analyze?session_id=' + tiny_id
        code, analysis = call(analysis_url, {'tree': tiny_tree, 'options': {'maxLeaves': 1}})
        assert code == 200 and analysis['exact'] and analysis['tree_count'] == '3', analysis
        for phase in ('queue_seconds', 'bounds_seconds', 'counting_seconds', 'prediction_seconds', 'importance_seconds', 'total_seconds'):
            assert analysis['timings'][phase] >= 0, analysis['timings']
        assert len(analysis['timings']['features']) == 1
        assert analysis['accuracy'] == {'min': .5, 'max': .5, 'undefined_count': '1'}, analysis
        for row in analysis['disagreement']:
            assert row['counts'] == ['1', '1', '1'] and abs(row['disagreement'] - 2/3) < 1e-12, row
        assert analysis['importance'][0]['min'] == analysis['importance'][0]['max'] == 0
        assert analysis['disagreement_metric'] == 'variation_ratio'
        assert analysis['class_count'] == 2 and analysis['abstention_enabled']
        assert analysis['partial_tree'] == tiny_tree and 'root_budget' in analysis and 'training_settings' in analysis
        code, fixed_abstain = call(analysis_url, {'tree': {'uid': 0, 'kind': 'leaf', 'prediction': -1}})
        assert code == 200 and fixed_abstain['tree_count'] == '1', fixed_abstain
        assert fixed_abstain['leaf_distribution'] == [{'value': 1, 'count': '1', 'probability': 1}]
        assert fixed_abstain['abstention_distribution'] == [{'value': 4, 'count': '1', 'probability': 1, 'proportion_abstained': 1}]
        assert all(row['disagreement'] == 0 for row in fixed_abstain['disagreement'])
        budget_url = '/api/budget?session_id=' + tiny_id
        assert call(budget_url, {'budget': -1})[0] == 400
        assert call(budget_url, {'budget': 1.5})[0] == 400
        before_capacity = call('/api/session')[1]['graph_budget']
        code, changed = call(budget_url, {'budget': 2})
        assert code == 202 and changed['active_budget'] == changed['requested_budget'] == 2, changed
        code, bounded = call(analysis_url, {'tree': tiny_tree})
        assert code == 200 and bounded['tree_count'] == '1', bounded
        code, options = call('/api/node?session_id=' + tiny_id, {'tree': tiny_tree, 'active_uid': 0})
        assert code == 200 and len(options['options']['leaves']) == 1 and options['options']['leaves'][0]['prediction'] == -1, options
        assert call(budget_url, {'budget': before_capacity})[0] == 202
        assert call(analysis_url, {'tree': tiny_tree})[1]['tree_count'] == '3'
        assert call('/api/session')[1]['graph_budget'] == before_capacity
        code, limited = call(analysis_url, {'tree': tiny_tree, 'options': {'maxLeaves': 1, 'maxAbstainedSamples': 0}})
        assert code == 200 and limited['tree_count'] == '2', limited
        assert call(analysis_url, {'tree': tiny_tree, 'options': {'maxLeaves': 0}})[0] == 400
        assert call('/api/cancel-query?session_id=' + tiny_id, {'token': 'cancel-before-arrival'})[0] == 202
        code, cancelled = call(analysis_url, {'tree': tiny_tree, 'analysis_token': 'cancel-before-arrival'})
        assert code == 400 and 'cancelled' in cancelled['error'], cancelled
        assert call('/api/node?session_id=' + tiny_id, {'tree': tiny_tree, 'active_uid': 0})[0] == 200
        code, capped = call('/api/complete?session_id=' + tiny_id, {'tree': tiny_tree, 'active_uid': 0, 'next_uid': 1, 'mode': 'constrained',
                            'constraint': {'mode': 'avoid', 'maxLeaves': 1, 'maxAbstainedSamples': 0}})
        assert code == 200 and capped['leaves'] == 1 and capped['abstained_samples'] == 0 and capped['objective'] == 3, capped
        assert call('/api/session')[1]['full_graph_exports'] == 0
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
