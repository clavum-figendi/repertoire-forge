#!/usr/bin/env python3
"""Production static server, bound to loopback by default."""
import argparse
from http.server import ThreadingHTTPServer,SimpleHTTPRequestHandler
from pathlib import Path
from functools import partial
parser=argparse.ArgumentParser();parser.add_argument('--port',type=int,default=8080);parser.add_argument('--host',default='127.0.0.1');parser.add_argument('--directory',default=str(Path(__file__).resolve().parents[1]/'dist'));args=parser.parse_args()
class Handler(SimpleHTTPRequestHandler):
    extensions_map={**SimpleHTTPRequestHandler.extensions_map,'.wasm':'application/wasm','.webmanifest':'application/manifest+json','.js':'application/javascript'}
    def end_headers(self):
        self.send_header('X-Content-Type-Options','nosniff');self.send_header('Referrer-Policy','no-referrer');self.send_header('Cache-Control','no-cache');super().end_headers()
print('Repertoire Forge at http://%s:%s'%(args.host,args.port),flush=True)
ThreadingHTTPServer((args.host,args.port),partial(Handler,directory=args.directory)).serve_forever()
