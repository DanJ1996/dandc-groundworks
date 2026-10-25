import http.server
import functools
import os

# Serve this script's own directory using an absolute path so we never call
# os.getcwd() (which macOS blocks for the iCloud Drive folder).
DIRECTORY = os.path.dirname(__file__)
Handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=DIRECTORY)

# Threaded so a looping <video> range request can't block other responses
# (page fetches, gallery.json, image loads) on a single connection.
with http.server.ThreadingHTTPServer(("", 4321), Handler) as httpd:
    httpd.serve_forever()
