import { spawn } from 'node:child_process';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Universal render path: where no webview exists, serve the same HTML from
 * localhost and open a browser. One server per process, re-serving the latest
 * render so a refresh always shows current harness state.
 */
/** What a sketch sends back when the human presses save. */
export interface SketchSubmission {
  ref: string;
  layout: unknown;
}
export type SketchHandler = (s: SketchSubmission) => Promise<{ ok: boolean; message: string }>;

class RenderServer {
  private server: http.Server | null = null;
  private html = '<h1>Harness</h1>';
  private port = 0;
  private onSketch: SketchHandler | null = null;

  /** Installed only while a sketch page is being served — POST is refused otherwise. */
  setSketchHandler(fn: SketchHandler | null): void {
    this.onSketch = fn;
  }

  async serve(html: string, preferredPort = 0): Promise<string> {
    this.html = html;
    if (!this.server) {
      this.server = http.createServer((req, res) => {
        if (req.url === '/health') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('{"ok":true}');
          return;
        }
        if (req.method === 'POST' && req.url === '/sketch') {
          this.handleSketch(req, res);
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

  /**
   * A saved sketch does NOT change the harness. It becomes a proposal with a diff,
   * exactly like a sentence typed in the chat — the mouse is a different way to
   * say the same thing, not a way around the approval.
   */
  private handleSketch(req: http.IncomingMessage, res: http.ServerResponse): void {
    const reply = (code: number, body: unknown): void => {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body));
    };
    if (!this.onSketch) {
      return reply(409, { ok: false, message: 'No sketch is open. Reopen it with harness_sketch.' });
    }

    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      // A layout tree is small. Anything this large is not one.
      if (raw.length > 1_000_000) req.destroy();
    });
    req.on('end', () => {
      let parsed: SketchSubmission;
      try {
        parsed = JSON.parse(raw) as SketchSubmission;
      } catch {
        return reply(400, { ok: false, message: 'That was not JSON.' });
      }
      this.onSketch!(parsed)
        .then((r) => reply(r.ok ? 200 : 400, r))
        .catch((err: Error) => reply(500, { ok: false, message: err.message }));
    });
  }

  stop(): void {
    this.onSketch = null;
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
