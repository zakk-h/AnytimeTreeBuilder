"""Real-browser tests for demand-driven native node queries and completions.
Usage: python3 browser_live.py URL CSV (requires Playwright; no active session).
"""
import json
from pathlib import Path
import sys
from playwright.sync_api import sync_playwright


def main():
    base, csv = sys.argv[1:3]
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=['--no-sandbox'])
        page = browser.new_page(viewport={'width': 1600, 'height': 1000})
        errors, requests = [], []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.on('request', lambda request: requests.append((request.url, request.post_data)))
        page.goto(base)
        page.get_by_role('button', name='New enumeration', exact=True).click()
        page.locator('.live-file input').set_input_files(csv)
        page.get_by_label('Maximum depth', exact=True).fill('3')
        page.get_by_label('Runtime limit (seconds)', exact=True).fill('60')
        page.get_by_role('button', name='Start ArborEnum', exact=True).click()
        expected_session = page.request.get(base + '/api/session').json()['session_id']
        page.wait_for_function("(sid) => window.ARBORENUM_CURRENT_BUILDER_PAYLOAD?.graph?.metadata?.session_id === sid", arg=expected_session, timeout=90000)
        def idle():
            page.wait_for_function("!document.querySelector('.native-query-status')", timeout=65000)
            assert page.locator('.upload-error:visible').count() == 0, page.locator('.upload-error:visible').all_text_contents()
        def export_tree():
            with page.expect_download() as event:
                page.get_by_title('Export the current tree', exact=True).click()
            return json.loads(Path(event.value.path()).read_text())
        idle()
        initial = export_tree()
        assert initial['tree']['kind'] == 'choice', 'Initial native view expanded unqueried descendants'
        status = page.request.get(base + '/api/session').json()
        assert status['ready'] and status['full_graph_exports'] == 0
        print('Initial native root query loaded during', status['phase'], flush=True)
        # Reveal one feature group, if its individual split cards are collapsed.
        split = page.locator('.choice-panel .split-choice:not(.choice-card-disabled)')
        if split.count() == 0:
            page.locator('.choice-panel .feature-group-header').first.click()
        page.locator('.choice-panel .split-choice:not(.choice-card-disabled)').first.click()
        idle()
        selected = export_tree()
        assert selected['tree']['kind'] == 'split'
        choices = page.locator('.arborenum-node-choice')
        assert choices.count() == 2
        choices.nth(0).dispatch_event('click')
        choices.nth(1).dispatch_event('click')
        idle()
        assert export_tree()['tree'] == selected['tree'], 'Node navigation changed the selected tree'
        node_requests = [json.loads(body) for url, body in requests if '/api/node?' in url and body]
        assert node_requests[-1]['active_uid'] == selected['tree']['right']['uid'], 'Rapid navigation selected a stale node'
        assert page.evaluate('window.ARBORENUM_CURRENT_BUILDER_PAYLOAD.graph.trie_nodes.length') <= 3 + 2 * page.locator('.choice-panel .split-choice').count() + 100
        # Native constraint bridge is asynchronous and calls the C++ endpoint.
        result = page.evaluate("window.ARBORENUM_NATIVE_CONSTRAINED_COMPLETION({mode:'avoid', forbiddenInternalFeatures:[]})")
        assert result['ok'], result
        idle()
        complete = export_tree()
        partial = complete
        for _ in range(20):
            if complete['complete']: break
            partial = complete
            page.locator('.arborenum-node-choice').first.dispatch_event('click')
            idle()
            page.get_by_role('button', name='Optimal', exact=True).click()
            idle()
            complete = export_tree()
        assert complete['complete'], 'Native optimal completion left choices unfinished'
        page.get_by_role('button', name='☆ Star', exact=True).click()
        page.wait_for_timeout(600)
        viewport = page.locator('.react-flow__viewport').get_attribute('style')
        favorite_count = page.locator('.header-actions').get_by_role('button', name='Favorites').inner_text()
        page.get_by_role('button', name='Update options', exact=True).click()
        idle()
        assert export_tree()['tree'] == complete['tree']
        assert page.locator('.react-flow__viewport').get_attribute('style') == viewport
        assert page.locator('.header-actions').get_by_role('button', name='Favorites').inner_text() == favorite_count
        page.locator('.toolbar-row button').filter(has_text='Undo').evaluate('(button) => button.click()')
        idle()
        assert export_tree()['tree'] == partial['tree'], 'Native queries lost undo history'
        # Random completion must also run on C++, rather than the renderer fragment.
        page.locator('.arborenum-node-choice').first.dispatch_event('click')
        idle()
        page.get_by_role('button', name='Random', exact=True).click()
        idle()
        completion_modes = [json.loads(body)['mode'] for url, body in requests if '/api/complete?' in url and body]
        assert {'optimal', 'random', 'constrained'} <= set(completion_modes), completion_modes
        assert not any('/api/snapshot' in url for url, _ in requests), 'Browser requested a whole graph'
        assert page.request.get(base + '/api/session').json()['full_graph_exports'] == 0
        assert not errors, errors
        print('Path navigation, stale-response protection, native optimal/random/constrained completion, selection/undo/favorites/viewport and zero graph exports passed', flush=True)
        page.reload()
        page.wait_for_function("document.querySelector('.payload-name')?.textContent.includes('native ArborEnum')", timeout=10000)
        assert page.request.get(base + '/api/session').json()['session_id'] == status['session_id']
        stop = page.get_by_role('button', name='Stop', exact=True)
        if stop.count(): stop.click()
        browser.close()

if __name__ == '__main__': main()
