// Web server for the Playwright run: `next start` on an internal port behind a thin
// proxy on the public port. The proxy
//   - counts requests until Next has finished answering them, even when the browser
//     aborted them (a reload or navigation cancels fetches without the browser ever
//     reporting it), and serves that count at GET /__e2e/inflight — test teardown waits
//     for 0 before deleting any row, so no route handler can be mid-request;
//   - copies the server's stderr to E2E_SERVER_LOG (set in playwright.config.ts), so
//     tests and globalTeardown fail on any server-side error.
// Usage: node tests/e2e/webServer.mjs <public port>
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const publicPort = Number(process.argv[2] ?? 3005);
const appPort = publicPort + 10;
const logPath = process.env.E2E_SERVER_LOG;
if (!logPath) throw new Error('E2E_SERVER_LOG is not set — start this through playwright.config.ts');

const log = createWriteStream(logPath, { flags: 'w' });
// Server stdout (startup banner, and request timings when TT_TIMING=1) is kept for evidence.
const outLog = createWriteStream(logPath.replace(/\.log$/, '') + '.stdout.log', { flags: 'w' });
const server = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'start', '-p', String(appPort)], {
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', (chunk) => {
  process.stdout.write(chunk);
  outLog.write(chunk);
});
server.stderr.on('data', (chunk) => {
  process.stderr.write(chunk);
  log.write(chunk);
});
server.on('exit', (code, signal) => {
  log.end();
  outLog.end();
  process.exit(code ?? (signal ? 1 : 0));
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.kill(signal));
}

let inFlight = 0;

const proxy = http.createServer((req, res) => {
  if (req.url === '/__e2e/inflight') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ inFlight }));
    return;
  }

  inFlight += 1;
  let counted = true;
  const done = () => {
    if (counted) {
      counted = false;
      inFlight -= 1;
    }
  };

  const upstream = http.request(
    { host: '127.0.0.1', port: appPort, method: req.method, path: req.url, headers: req.headers },
    (response) => {
      // Counted until Next has sent the whole response, whether or not the browser is still listening.
      response.on('end', done);
      response.on('close', done);
      response.on('error', done);
      if (res.destroyed) {
        // The browser already went away: drain Next's response so it can finish.
        response.resume();
        return;
      }
      res.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(res);
      // A browser that goes away mid-response stops the pipe; keep draining so Next's
      // response still reaches its end (a paused stream never would).
      res.on('close', () => {
        if (!response.readableEnded) {
          response.unpipe(res);
          response.resume();
        }
      });
    },
  );
  upstream.on('error', (err) => {
    done();
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
    res.end(`e2e proxy: ${err.message}`);
  });
  req.pipe(upstream);
});

// Listen publicly only once Next answers, so Playwright never starts tests against a cold server.
async function waitForNext() {
  for (;;) {
    const ok = await new Promise((resolve) => {
      const probe = http.get({ host: '127.0.0.1', port: appPort, path: '/' }, (r) => {
        r.resume();
        resolve(true);
      });
      probe.on('error', () => resolve(false));
    });
    if (ok) return;
    await new Promise((r) => setTimeout(r, 250));
  }
}

await waitForNext();
proxy.listen(publicPort);
