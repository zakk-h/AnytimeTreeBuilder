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
        code, analysis = call(analysis_url, {'tree': tiny_tree, 'options': {'maxLeaves': 1}, 'analysis_token': 'progress-test'})
        assert code == 200 and analysis['exact'] and analysis['tree_count'] == '3', analysis
        # Imported graph analysis shares the native DP, with and without CSV data.
        imported = {'graph': {'root_trie_id': 7,
            'trie_nodes': [{'id': 7, 'budget': 10, 'subproblem_size': 4, 'leaf_ids': [4,5,6], 'split_ids': []}],
            'split_nodes': [], 'leaf_nodes': [
                {'id': 4, 'parent_trie_id': 7, 'prediction': 0, 'loss': 3, 'subproblem_size': 4},
                {'id': 5, 'parent_trie_id': 7, 'prediction': 1, 'loss': 3, 'subproblem_size': 4},
                {'id': 6, 'parent_trie_id': 7, 'prediction': -1, 'loss': 2, 'subproblem_size': 4}]},
            'meta': {'root_n': 4, 'gamma': 1, 'eta_defer': .25, 'use_deferral': True, 'featureRegistry': []}}
        imported_tree = {'uid': 0, 'kind': 'choice', 'graphTrieId': 7}
        imported_body = {'payload': imported, 'tree': imported_tree, 'token': 'import-test'}
        code, imported_result = call('/api/analyze-graph', imported_body)
        assert code == 200 and imported_result['tree_count'] == '3', imported_result
        assert imported_result['accuracy'] == analysis['accuracy']
        assert imported_result['abstention_distribution'][-1]['value'] == 4
        imported_body['dataset'] = {k: v for k, v in tiny.items() if k != 'settings'}
        code, imported_result = call('/api/analyze-graph', imported_body)
        assert code == 200, imported_result
        for field in ('tree_count', 'accuracy', 'leaf_distribution', 'abstention_distribution', 'disagreement', 'importance'):
            assert imported_result[field] == analysis[field], (field, imported_result[field], analysis[field])
        imported_body['tree'] = {'uid': 0, 'kind': 'leaf', 'graphTrieId': 7, 'leafId': 6, 'prediction': -1}
        code, fixed_result = call('/api/analyze-graph', imported_body)
        assert code == 200 and fixed_result['tree_count'] == '1' and fixed_result['accuracy']['undefined_count'] == '1', fixed_result
        imported_body['dataset']['y'] = [0,0,0,0]
        assert call('/api/analyze-graph', imported_body)[0] == 400
        imported_body.pop('dataset')
        imported_body['tree']['leafId'] = 999
        assert call('/api/analyze-graph', imported_body)[0] == 400
        # Parent budgets must constrain child combinations, including fixed leaves.
        branch_graph = {'graph': {'root_trie_id': 0, 'trie_nodes': [
            {'id': 0, 'budget': 3, 'subproblem_size': 4, 'leaf_ids': [], 'split_ids': [0]},
            {'id': 1, 'budget': 3, 'subproblem_size': 2, 'leaf_ids': [0,1], 'split_ids': []},
            {'id': 2, 'budget': 3, 'subproblem_size': 2, 'leaf_ids': [2,3], 'split_ids': []}],
            'split_nodes': [{'id': 0, 'parent_trie_id': 0, 'feature': 0, 'left_trie_id': 1, 'right_trie_id': 2}],
            'leaf_nodes': [{'id': i, 'parent_trie_id': 1+i//2, 'prediction': i%2, 'loss': 1+i%2, 'subproblem_size': 2} for i in range(4)]},
            'meta': {'root_n': 4, 'gamma': 1}}
        branch_tree = {'uid': 0, 'graphTrieId': 0, 'kind': 'choice'}
        branch_body = {'payload': branch_graph, 'tree': branch_tree, 'token': 'branch-test'}
        code, branch_result = call('/api/analyze-graph', branch_body)
        assert code == 200 and branch_result['tree_count'] == '3', branch_result
        assert branch_result['leaf_distribution'] == [{'value': 2, 'count': '3', 'probability': 1.0}]
        branch_body['tree'] = {'uid': 0, 'graphTrieId': 0, 'kind': 'split', 'feature': 0, 'splitId': 0,
            'left': {'uid': 1, 'graphTrieId': 1, 'kind': 'leaf', 'leafId': 1, 'prediction': 1},
            'right': {'uid': 2, 'graphTrieId': 2, 'kind': 'choice'}}
        code, branch_result = call('/api/analyze-graph', branch_body)
        assert code == 200 and branch_result['tree_count'] == '1', branch_result
        assert branch_result['accuracy']['min'] == .75
        branch_graph['graph']['trie_nodes'][0]['budget'] = 4
        for leaf in branch_graph['graph']['leaf_nodes']:
            leaf['loss'] = 2
        branch_graph['meta']['featureRegistry'] = [{'internalFeature': 0, 'originalFeature': 0, 'originalName': 'a', 'threshold': .5}]
        branch_body['tree'] = branch_tree
        branch_body['dataset'] = {'feature_names': ['a'], 'class_names': ['no','yes'], 'X': [[0],[0],[1],[1]], 'y': [0,1,0,1]}
        code, branch_result = call('/api/analyze-graph', branch_body)
        assert code == 200 and branch_result['tree_count'] == '4', branch_result
        assert branch_result['accuracy']['min'] == branch_result['accuracy']['max'] == .5
        assert all(row['disagreement'] == .5 for row in branch_result['disagreement'])
        assert branch_result['importance'][0]['min'] == branch_result['importance'][0]['max'] == 0
        branch_body.pop('dataset')
        branch_graph['graph']['split_nodes'][0]['left_trie_id'] = 0
        branch_body['tree'] = branch_tree
        assert call('/api/analyze-graph', branch_body)[0] == 400
        progress_url = '/api/analysis-progress?session_id=' + tiny_id
        assert call(progress_url, {'token': ''})[0] == 400
        code, progress = call(progress_url, {'token': 'progress-test'})
        assert code == 200 and progress['stage'] == 4 and progress['completed_features'] == progress['feature_count'] == 1, progress
        assert call(progress_url, {'token': 'another-analysis'})[1]['stage'] == -1
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
        # Learned proxy thresholds must not seed a continuous-only graph.
        # Refinement must recover it even when the initial leaf exceeds the bound.
        cold = {'feature_names': ['continuous'], 'class_names': ['no', 'yes'],
                'X': [[i] for i in range(80)], 'y': [int(i >= 20) for i in range(80)],
                'settings': {'depth_budget': 1, 'lambda_reg': .005, 'runtime_limit_seconds': 10}}
        for rounds in (0, -1):
            cold['settings']['max_refinement_rounds'] = rounds
            code, cold_status = call('/api/session', cold)
            assert code == 202, cold_status
            cold_id = cold_status['session_id']
            deadline = time.monotonic() + 15
            while cold_status['phase'] not in ('finished', 'failed'):
                assert time.monotonic() < deadline, cold_status
                time.sleep(.005)
                cold_status = call('/api/session')[1]
            assert cold_status['phase'] == ('finished' if rounds == -1 else 'failed') and cold_status['ready'] == (rounds == -1), cold_status
            if rounds == -1:
                code, cold_meta = call('/api/meta?session_id=' + cold_id)
                assert code == 200 and cold_meta['warm_start']['initial_threshold_ids'] == [], cold_meta
                assert cold_meta['warm_start']['proxy_threshold_ids'], cold_meta
                code, cold_view = call('/api/node?session_id=' + cold_id, {'tree': tiny_tree, 'active_uid': 0})
                assert code == 200 and cold_view['options']['splits'], cold_view
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
