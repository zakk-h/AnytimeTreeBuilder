"""Check the size users actually see, rather than only CSS font sizes.
Usage: python3 browser_readability.py BINARY HTML [SCREENSHOT_DIRECTORY]
"""
import json
from pathlib import Path
import socket
import subprocess
import sys
import time
import urllib.request
from playwright.sync_api import sync_playwright


def short_name_payload():
    names = ['hr ≤ 8.5', 'workingday', 'hr ≤ 22.5']
    tries, splits, leaves = [], [], []
    for i in range(15):
        n = 800 // (2 ** ((i + 1).bit_length() - 1))
        tries.append({'id': i, 'budget': 100, 'min_objective': 1, 'subproblem_size': n,
                      'leaf_ids': [i], 'split_ids': [i] if i < 7 else []})
        leaves.append({'id': i, 'parent_trie_id': i, 'prediction': i % 2, 'loss': 8, 'subproblem_size': n})
        if i < 7:
            splits.append({'id': i, 'parent_trie_id': i, 'feature': i % len(names),
                           'left_trie_id': 2*i+1, 'right_trie_id': 2*i+2, 'min_objective': 2})
    return {'graph': {'root_trie_id': 0, 'trie_nodes': tries, 'split_nodes': splits, 'leaf_nodes': leaves},
            'meta': {'root_n': 800, 'gamma': 1, 'featureRegistry': [
                {'internalFeature': i, 'originalFeature': i, 'originalName': name, 'threshold': .5,
                 'kind': 'binary_threshold', 'continuousGroup': None} for i, name in enumerate(names)]}}


def main():
    binary, html = (str(Path(arg).resolve()) for arg in sys.argv[1:3])
    screenshots = Path(sys.argv[3]) if len(sys.argv) > 3 else None
    if screenshots: screenshots.mkdir(parents=True, exist_ok=True)
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0)); port = sock.getsockname()[1]
    base = f'http://127.0.0.1:{port}'
    process = subprocess.Popen([binary, '--ui', html, '--port', str(port)], stdout=subprocess.DEVNULL)
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
            page.get_by_role('button', name='Upload', exact=True).click()
            with page.expect_file_chooser() as chooser:
                page.get_by_role('menuitem', name='Upload graph').click()
            chooser.value.set_files({'name': 'Short feature names.json', 'mimeType': 'application/json',
                                     'buffer': json.dumps(short_name_payload()).encode()})
            page.wait_for_function("document.querySelector('.payload-name')?.textContent.includes('Short feature')")
            # The root's first split, then left branch, then right branch and
            # one deeper split reproduce the size of the user's example tree.
            for uid, count in [(0, 3), (1, 5), (2, 7), (3, 9)]:
                if uid:
                    page.locator(f'.react-flow__node[data-id="{uid}"]').click()
                page.locator('.split-choice').first.click()
                page.wait_for_function('(n) => document.querySelectorAll(".arborenum-node").length === n', arg=count)
                page.wait_for_timeout(700)
            labels = page.locator('.node-title').evaluate_all('''items => items.map(el => {
                const css = getComputedStyle(el), box = el.getBoundingClientRect();
                return {text: el.textContent, font: parseFloat(css.fontSize),
                        screenFont: parseFloat(css.fontSize) * box.width / el.offsetWidth,
                        overflow: el.scrollWidth > el.clientWidth + 1,
                        cardWidth: el.closest('.arborenum-node').offsetWidth};
            })''')
            assert all(label['font'] >= 56 and label['screenFont'] >= 30 for label in labels), labels
            assert all(not label['overflow'] and label['cardWidth'] < 420 for label in labels), labels
            assert page.locator('.choice-card-main').first.evaluate('el => parseFloat(getComputedStyle(el).fontSize)') >= 24
            assert page.locator('.choice-card-sub').first.evaluate('el => parseFloat(getComputedStyle(el).fontSize)') >= 16
            # Every card must fit within the fitted viewport; every shared level
            # must retain a real gap after all measured widths are applied.
            boxes = page.locator('.arborenum-node').evaluate_all('items => items.map(el => { const r=el.getBoundingClientRect(); return {x:r.x,y:r.y,w:r.width,h:r.height}; })')
            canvas = page.locator('.flow-stage').bounding_box()
            for box in boxes:
                assert canvas['x'] - 1 <= box['x'] and box['x'] + box['w'] <= canvas['x'] + canvas['width'] + 1, (box, canvas)
                assert canvas['y'] - 1 <= box['y'] and box['y'] + box['h'] <= canvas['y'] + canvas['height'] + 1, (box, canvas)
            for a in boxes:
                for b in boxes:
                    if a['x'] < b['x'] and abs(a['y'] - b['y']) < 1:
                        assert a['x'] + a['w'] + 10 < b['x'], (a, b)
            if screenshots: page.screenshot(path=str(screenshots / 'ui-readable-short-names.png'))
            page.set_viewport_size({'width': 2048, 'height': 1100})
            page.wait_for_timeout(900)
            if screenshots: page.screenshot(path=str(screenshots / 'ui-readable-wide.png'))
            # Renaming an already displayed split must remeasure its width,
            # reduce the font for the long name, then grow again on reset.
            page.get_by_role('button', name='Customize', exact=True).click()
            name_input = page.get_by_placeholder('hr ≤ 8.5', exact=True)
            long_name = 'Maximum revolving credit balance across every account during the previous twelve months adjusted for seasonal changes'
            name_input.fill(long_name)
            page.get_by_role('button', name='Done', exact=True).click()
            page.wait_for_timeout(800)
            renamed = page.locator('.arborenum-node-split .node-title').filter(has_text=long_name)
            assert renamed.count() == 2
            assert renamed.first.evaluate('el => parseFloat(getComputedStyle(el).fontSize)') < 56
            assert renamed.first.evaluate('el => el.scrollWidth <= el.clientWidth + 1')
            page.get_by_role('button', name='Customize', exact=True).click()
            name_input.fill('')
            page.get_by_role('button', name='Done', exact=True).click()
            page.wait_for_timeout(800)
            assert page.locator('.arborenum-node-split .node-title').first.evaluate('el => parseFloat(getComputedStyle(el).fontSize)') == 64
            assert not errors, errors
            browser.close()
        print('Short node labels remain at least 30px on screen, options/objectives are enlarged, and mixed-width cards fit without overlap')
    finally:
        process.terminate()
        assert process.wait(timeout=15) == 0


if __name__ == '__main__': main()
