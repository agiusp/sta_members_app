#!/usr/bin/env python3
"""Local web server for the app pages (http://127.0.0.1:3000/app/, or PORT).

Same as `python3 -m http.server`, but tells the browser not to cache, so
page changes show up on a normal reload. Local development only.
"""
import functools
import http.server
import os

class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

if __name__ == '__main__':
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    handler = functools.partial(NoCacheHandler, directory=root)
    port = int(os.environ.get('PORT', '3000'))
    print(f'Serving on http://127.0.0.1:{port}/app/  (Ctrl+C to stop)')
    http.server.ThreadingHTTPServer(('127.0.0.1', port), handler).serve_forever()
