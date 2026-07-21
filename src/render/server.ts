import { spawn } from 'node:child_process';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Universal render path: where no webview exists, serve the same HTML from
 * localhost and open a browser. One server per process, re-serving the latest
 * render so a refresh always shows current harness state.
 */
class RenderServer {
  private server: http.Server | null = null;
  private html = '<h1>Harness</h1>';
  private port = 0;

  async serve(html: string, preferredPort = 0): Promise<string> {
    this.html = html;
    if (!this.server) {
      this.server = http.createServer((req, res) => {
        if (req.url === '/health') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('{"ok":true}');
          return;
        }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(this.html);
      });
      await new Promise<void>((resolve, reject) => {
        this.server!.once('error', reject);
        // Loopback only — the harness never exposes the project on the network.
        this.server!.listen(preferredPort, '127.0.0.1', resolve);
      });
      this.port = (this.server.address() as AddressInfo).port;
      this.server.unref();
    }
    return `http://127.0.0.1:${this.port}/`;
  }

  stop(): void {
    this.server?.close();
    this.server = null;
  }
}

export const renderServer = new RenderServer();

export function openBrowser(url: string): boolean {
  try {
    const [cmd, args] =
      process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : process.platform === 'darwin'
          ? ['open', [url]]
          : ['xdg-open', [url]];
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    child.unref();
    return true;
  } catch {
    return false;
  }
}
