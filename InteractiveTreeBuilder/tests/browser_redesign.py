"""Unified uploads, long feature names, measured layout and responsive UI.
Usage: python3 browser_redesign.py BINARY HTML [SCREENSHOT_DIRECTORY]
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
    screenshots = Path(sys.argv[3]) if len(sys.argv) > 3 else None
    if screenshots: screenshots.mkdir(parents=True, exist_ok=True)
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
            errors = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.goto(base)
            upload = page.get_by_role('button', name='Upload', exact=True)
            upload.click()
            dataset = page.get_by_role('menuitem', name='Upload dataset')
            dataset.wait_for()
            assert dataset.is_enabled()
            assert page.get_by_role('button', name='New enumeration', exact=True).count() == 0
            page.keyboard.press('ArrowDown')
            assert page.get_by_role('menuitem', name='Upload graph').evaluate('(e) => e === document.activeElement')
            page.keyboard.press('Escape')
            assert upload.evaluate('(e) => e === document.activeElement')
            upload.click(); dataset.click()
            page.get_by_role('dialog').wait_for()
            assert page.get_by_label('Proxy mode', exact=True).input_value() == 'binarized'
            if screenshots: page.screenshot(path=str(screenshots / 'ui-enumeration.png'))
            page.keyboard.press('Escape')
            assert page.get_by_role('dialog').count() == 0
            assert upload.evaluate('(e) => e === document.activeElement')

            spaced = 'Average outstanding revolving credit balance across all active accounts over the previous twelve months, adjusted for seasonal variation and recently opened accounts'
            unbroken = 'MaxDelinquencyPublicRecordLastTwelveMonths_' + 'VeryLongFeatureNameWithoutSpaces_' * 7
            graph = {
                'root_trie_id': 0,
                'trie_nodes': [
                    {'id': 0, 'budget': 10, 'min_objective': 2, 'subproblem_size': 100, 'leaf_ids': [0], 'split_ids': [0, 1]},
                    {'id': 1, 'budget': 10, 'min_objective': 1, 'subproblem_size': 60, 'leaf_ids': [1], 'split_ids': []},
                    {'id': 2, 'budget': 10, 'min_objective': 1, 'subproblem_size': 40, 'leaf_ids': [2], 'split_ids': []},
                ],
                'split_nodes': [{'id': i, 'parent_trie_id': 0, 'feature': i, 'left_trie_id': 1, 'right_trie_id': 2, 'min_objective': 2} for i in range(2)],
                'leaf_nodes': [{'id': i, 'parent_trie_id': 0 if i == 0 else i, 'prediction': i % 2, 'loss': 10 if i == 0 else 1, 'subproblem_size': 100 if i == 0 else 60 if i == 1 else 40} for i in range(3)],
            }
            payload = {'graph': graph, 'meta': {'root_n': 100, 'gamma': 1, 'featureRegistry': [
                {'internalFeature': i, 'originalFeature': i, 'originalName': name, 'threshold': .5, 'kind': 'binary_threshold', 'continuousGroup': None} for i, name in enumerate((spaced, unbroken))]}}
            upload.click()
            with page.expect_file_chooser() as chooser:
                page.get_by_role('menuitem', name='Upload graph').click()
            chooser.value.set_files({'name': 'Credit portfolio.graph.json', 'mimeType': 'application/json', 'buffer': json.dumps(payload).encode()})
            page.wait_for_function("(name) => window.ARBORENUM_CURRENT_BUILDER_PAYLOAD?.meta?.featureRegistry?.[0]?.originalName === name", arg=spaced)
            for name in (spaced, unbroken):
                card = page.locator('.split-choice').filter(has_text=name)
                assert card.count() == 1
                assert card.locator('.choice-card-main').evaluate('(e) => e.scrollWidth <= e.clientWidth + 1')
            page.get_by_role('button', name='Customize', exact=True).click()
            assert page.locator('.settings-popover').evaluate('(e) => e.scrollWidth <= e.clientWidth + 1')
            page.get_by_role('button', name='Done', exact=True).click()
            page.get_by_role('button', name='Constrained', exact=True).click()
            page.locator('.constraint-modal').wait_for()
            assert page.locator('.constraint-check-row').filter(has_text=unbroken).count() == 1
            assert page.locator('.constraint-modal').evaluate('(e) => e.scrollWidth <= e.clientWidth + 1')
            page.locator('.constraint-close').click()
            if screenshots: page.screenshot(path=str(screenshots / 'ui-options.png'))
            def choose(name):
                page.locator('.split-choice').filter(has_text=name).click()
                page.wait_for_function("document.querySelectorAll('.arborenum-node-leaf').length === 2")
                page.wait_for_timeout(800)
                title = page.locator('.arborenum-node-split .node-title')
                assert name in title.inner_text() and '…' not in title.inner_text()
                assert title.evaluate('(e) => e.scrollWidth <= e.clientWidth + 1')
                parent = page.locator('.arborenum-node-split').bounding_box()
                for child in page.locator('.arborenum-node-leaf').all():
                    assert child.bounding_box()['y'] > parent['y'] + parent['height'] + 5
            choose(unbroken)
            page.locator('.arborenum-node-split').click()
            choose(spaced)
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
            if screenshots: page.screenshot(path=str(screenshots / 'ui-redesign-desktop.png'))
            page.get_by_role('button', name='☆ Star', exact=True).click()
            page.get_by_title('Browse favorite trees').click()
            page.locator('.starred-overlay').wait_for()
            page.keyboard.press('Escape')
            with page.expect_download(): page.get_by_title('Export the current tree').click()
            page.set_viewport_size({'width': 390, 'height': 844})
            page.wait_for_timeout(1500)
            canvas = page.locator('.flow-stage').bounding_box()
            root = page.locator('.arborenum-node-split').bounding_box()
            assert canvas['x'] <= root['x'] and root['x'] + root['width'] <= canvas['x'] + canvas['width']
            assert canvas['y'] <= root['y'] and root['y'] + root['height'] <= canvas['y'] + canvas['height']
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
            assert page.locator('.panel').evaluate('(e) => e.scrollWidth <= e.clientWidth + 1')
            page.get_by_role('button', name='Customize', exact=True).click()
            assert page.locator('.settings-popover').evaluate('(e) => e.scrollWidth <= e.clientWidth + 1')
            page.get_by_role('button', name='Done', exact=True).click()
            upload.click()
            popover = page.locator('.upload-popover').bounding_box()
            assert popover['x'] >= 0 and popover['x'] + popover['width'] <= 390
            page.keyboard.press('Escape')
            assert page.locator('.metric').nth(2).locator('b').evaluate('(e) => e.scrollWidth <= e.clientWidth + 1')
            if screenshots: page.screenshot(path=str(screenshots / 'ui-redesign-mobile.png'), full_page=True)
            assert not errors, errors
            browser.close()
        print('Unified upload, keyboard navigation, graph import, full long labels, nonoverlapping nodes, favorites/export and mobile layout passed')
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
