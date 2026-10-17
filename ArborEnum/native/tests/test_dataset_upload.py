"""CSV conversion and dataset switching against the real GUI and C++ service.
Usage: python3 test_dataset_upload.py BINARY BUILDER_HTML (requires Playwright).
"""
import json
from pathlib import Path
import socket
import subprocess
import sys
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
                with urllib.request.urlopen(base + '/api/health', timeout=1): break
            except OSError:
                assert process.poll() is None and time.monotonic() < deadline
                time.sleep(.05)
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True, args=['--no-sandbox'])
            page = browser.new_page(viewport={'width': 1600, 'height': 1000})
            errors, uploads = [], []
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.on('request', lambda request: uploads.append(json.loads(request.post_data)) if request.method == 'POST' and request.url.endswith('/api/session') else None)
            def select_csv(text):
                page.locator('.live-file input').set_input_files({'name': 'dataset.csv', 'mimeType': 'text/csv', 'buffer': text.encode()})
            def loaded(sid):
                page.wait_for_function('(sid) => window.ARBORENUM_CURRENT_BUILDER_PAYLOAD?.graph?.metadata?.session_id === sid', arg=sid)
                page.wait_for_function("!document.querySelector('.native-query-status')")
                assert page.locator('.react-flow__node-arborenum').count() > 0
                assert page.locator('.choice-panel').count() == 1
            def blank():
                assert page.locator('.react-flow__node-arborenum').count() == 0
                assert page.locator('.choice-panel').count() == 0
                assert page.evaluate('window.ARBORENUM_CURRENT_BUILDER_PAYLOAD.graph.trie_nodes.length') == 0
            page.goto(base)
            page.get_by_role('button', name='Upload', exact=True).click()
            page.get_by_role('menuitem', name='Upload dataset').click()
            select_csv('old_feature,label\n1,no\n2,yes\n3,no\n4,yes\n')
            blank()
            page.get_by_label('Maximum depth', exact=True).fill('2')
            page.get_by_label('Rashomon multiplier', exact=True).fill('1')
            page.get_by_role('button', name='Start ArborEnum', exact=True).click()
            loaded('1')
            # Hold replies in the browser, deliberately ignoring fetch aborts,
            # to exercise stale-reply protection as well as the loading UI.
            page.evaluate("""() => {
              const original = window.fetch.bind(window);
              const rules = [['Old', '/api/node?session_id=1'], ['Meta', '/api/meta?session_id=2'], ['Node', '/api/node?session_id=2']];
              window.fetch = (input, init) => {
                for (const [name, path] of rules) if (String(input).includes(path) && !window['released' + name]) {
                  window['pending' + name] = true;
                  return new Promise(resolve => { window['release' + name] = async () => {
                    window['released' + name] = true;
                    resolve(await original(input, {...init, signal: undefined}));
                  }; });
                }
                return original(input, init);
              };
            }""")
            page.get_by_role('button', name='Update options', exact=True).click()
            page.wait_for_function('window.pendingOld')
            page.get_by_role('button', name='Upload', exact=True).click()
            page.get_by_role('menuitem', name='Upload dataset').click()
            mixed = 'score,MaxDelq2PublicRecLast12M_-9,segment,label\n66,FALSE,alpha,no\n59,TRUE,β,yes\n73,true,unknown!,yes\n10,false,alpha,no\n'
            select_csv(mixed)
            blank()
            page.evaluate('window.releaseOld()')
            page.wait_for_timeout(600) # An old-session status poll must not restore its view.
            blank()
            page.get_by_role('button', name='Start ArborEnum', exact=True).click()
            page.wait_for_function('window.pendingMeta')
            blank()
            page.evaluate('window.releaseMeta()')
            page.wait_for_function('window.pendingNode')
            blank() # Metadata readiness must not show an empty or previous tree.
            page.evaluate('window.releaseNode()')
            loaded('2')
            assert uploads[-1]['feature_names'] == ['score', 'MaxDelq2PublicRecLast12M_-9', 'segment = "alpha"', 'segment = "unknown!"', 'segment = "β"'], uploads[-1]
            assert uploads[-1]['X'] == [[66, 0, 1, 0, 0], [59, 1, 0, 0, 1], [73, 1, 0, 1, 0], [10, 0, 1, 0, 0]]
            names = page.evaluate('window.ARBORENUM_CURRENT_BUILDER_PAYLOAD.meta.featureRegistry.map(f => f.originalName)')
            assert 'old_feature' not in names and 'MaxDelq2PublicRecLast12M_-9' in names, names
            page.get_by_role('button', name='Upload', exact=True).click()
            page.get_by_role('menuitem', name='Upload dataset').click()
            select_csv('broken,label\n1,yes,extra\n')
            page.get_by_role('alert').filter(has_text='different numbers').first.wait_for()
            blank()
            select_csv('score,label\n,no\n')
            page.get_by_role('button', name='Start ArborEnum', exact=True).click()
            page.get_by_role('alert').filter(has_text='is missing').first.wait_for()
            blank()
            select_csv(mixed)
            page.get_by_role('button', name='Start ArborEnum', exact=True).click()
            loaded('3')
            assert not errors, errors
            browser.close()
        print('CSV booleans/categories reached C++; upload cleared old views; stale replies, readiness, validation and retry passed')
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
