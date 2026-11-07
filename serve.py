"""Serve the repo for the demos: python3 serve.py [port]

Same as `python3 -m http.server`, but with a longer connection queue. The 3D
demo loads a dozen modules at once, and the standard server's queue of 5
sometimes drops one, which leaves the page blank.
"""
import http.server, sys

class Server(http.server.ThreadingHTTPServer):
    request_queue_size = 64
    daemon_threads = True

class Handler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass  # keep the terminal quiet

    def end_headers(self):
        # Never cache: while the demo is being changed, a stale page with a new
        # script (or the other way round) leaves it blank.
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
try:
    server = Server(("", port), Handler)
except OSError:
    sys.exit(f"Port {port} is already in use. If the demo server is already running, just open "
             f"http://localhost:{port}/demo3d/ - or pick another port: python3 serve.py {port + 1}")
print(f"Serving on http://localhost:{port}/demo/ and http://localhost:{port}/demo3d/")
server.serve_forever()
