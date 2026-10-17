"""Regression check for desktop preview forwarding, both Host header strategies.
Usage: python3 test_preview_proxy.py BACKEND_PORT (requires Playwright and a running service).
"""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from http.client import HTTPConnection
from threading import Thread
from playwright.sync_api import sync_playwright
import sys

backend_port = int(sys.argv[1]) if len(sys.argv) > 1 else 8766
class Proxy(BaseHTTPRequestHandler):
    rewrite_host = False
    def log_message(self, *args): pass
    def forward(self):
        connection = HTTPConnection('127.0.0.1', backend_port, timeout=15)
        headers = dict(self.headers)
        if self.rewrite_host:
            headers['Host'] = f'127.0.0.1:{backend_port}'
        body = self.rfile.read(int(self.headers.get('Content-Length', '0')))
        connection.request(self.command, self.path, body=body, headers=headers)
        response = connection.getresponse()
        payload = response.read()
        self.send_response(response.status)
        for key, value in response.getheaders():
            if key.lower() not in ('connection', 'transfer-encoding', 'content-length'):
                self.send_header(key, value)
        self.send_header('Content-Length', str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)
        connection.close()
    do_GET = forward
    do_POST = forward

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, args=['--no-sandbox'])
    for rewrite in (False, True):
        Proxy.rewrite_host = rewrite
        proxy = ThreadingHTTPServer(('127.0.0.1', 0), Proxy)
        worker = Thread(target=proxy.serve_forever, daemon=True)
        worker.start()
        page = browser.new_page()
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        base = f'http://localhost:{proxy.server_port}'
        try:
            page.goto(base)
            page.get_by_role('button', name='Upload', exact=True).click()
            page.get_by_role('menuitem', name='Upload dataset').click()
            csv = 'x,z,label\n' + ''.join(f'{i},{i%3},{i%2}\n' for i in range(24))
            page.locator('.live-file input').set_input_files({'name': 'proxy.csv', 'mimeType': 'text/csv', 'buffer': csv.encode()})
            page.get_by_label('Maximum depth', exact=True).fill('2')
            page.get_by_label('Runtime limit (seconds)', exact=True).fill('2')
            page.get_by_role('button', name='Start ArborEnum', exact=True).click()
            expected_session = page.request.get(base + '/api/session').json()['session_id']
            page.wait_for_function("(sid) => window.ARBORENUM_CURRENT_BUILDER_PAYLOAD?.graph?.metadata?.session_id === sid", arg=expected_session, timeout=15000)
            assert page.locator('.upload-error:visible').count() == 0
            assert not errors, errors
            print('Browser preview launch passed:', 'rewritten Host' if rewrite else 'preserved Host', base, flush=True)
        finally:
            page.close()
            proxy.shutdown()
            proxy.server_close()
    browser.close()
