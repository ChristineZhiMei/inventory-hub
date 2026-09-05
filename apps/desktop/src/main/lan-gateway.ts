import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export interface LanGatewayOptions {
  bindHost: string;
  lanOrigin: string;
  serviceOrigin: string;
  webOrigin: string;
  tlsCertPath: string;
  tlsKeyPath: string;
}

export class LanHttpsGateway {
  private server: HttpsServer | null = null;

  constructor(private readonly options: LanGatewayOptions) {}

  async start(): Promise<void> {
    if (this.server) return;
    const target = new URL(this.options.lanOrigin);
    const server = createHttpsServer(
      {
        cert: readFileSync(this.options.tlsCertPath),
        key: readFileSync(this.options.tlsKeyPath),
        minVersion: "TLSv1.2",
      },
      (request, response) => this.proxy(request, response),
    );
    server.on("clientError", (_error, socket) => socket.end("HTTP/1.1 400 Bad Request\r\n\r\n"));
    await listen(server, this.options.bindHost, Number(target.port));
    this.server = server;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private proxy(request: IncomingMessage, response: ServerResponse): void {
    const path = request.url ?? "/";
    if (request.method === "POST" && path.split("?")[0] === "/api/v1/setup") {
      response.writeHead(403, securityHeaders("application/json; charset=utf-8"));
      response.end(JSON.stringify({ error: { code: "DESKTOP_ONLY", message: "首次设置只能在电脑桌面端完成" } }));
      return;
    }

    const target = new URL(path.startsWith("/api/") ? this.options.serviceOrigin : this.options.webOrigin);
    const headers = copyHeaders(request.headers);
    headers.host = target.host;
    headers["x-forwarded-for"] = request.socket.remoteAddress ?? "";
    headers["x-forwarded-host"] = new URL(this.options.lanOrigin).host;
    headers["x-forwarded-proto"] = "https";
    const upstream = httpRequest(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        method: request.method,
        path,
        headers,
      },
      (upstreamResponse) => {
        const responseHeaders = copyHeaders(upstreamResponse.headers);
        secureSetCookies(responseHeaders);
        Object.assign(responseHeaders, securityHeaders(responseHeaders["content-type"]));
        response.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders);
        upstreamResponse.pipe(response);
      },
    );
    upstream.on("error", () => {
      if (!response.headersSent) response.writeHead(502, securityHeaders("text/plain; charset=utf-8"));
      response.end("Inventory Hub 本地服务暂不可用");
    });
    request.on("aborted", () => upstream.destroy());
    request.pipe(upstream);
  }
}

export class LanCertificatePortal {
  private server: ReturnType<typeof createHttpServer> | null = null;

  constructor(
    private readonly options: {
      bindHost: string;
      installOrigin: string;
      appOrigin: string;
      caCertPath: string;
      caFingerprint: string;
    },
  ) {}

  async start(): Promise<void> {
    if (this.server) return;
    const origin = new URL(this.options.installOrigin);
    const server = createHttpServer((request, response) => this.respond(request, response));
    server.on("clientError", (_error, socket) => socket.end("HTTP/1.1 400 Bad Request\r\n\r\n"));
    await listen(server, this.options.bindHost, Number(origin.port));
    this.server = server;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private respond(request: IncomingMessage, response: ServerResponse): void {
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { ...portalHeaders("text/plain; charset=utf-8"), Allow: "GET, HEAD" });
      response.end("Method Not Allowed");
      return;
    }
    const path = new URL(request.url ?? "/", this.options.installOrigin).pathname;
    if (path === "/inventory-hub-ca.cer") {
      const certificate = readFileSync(this.options.caCertPath);
      response.writeHead(200, {
        ...portalHeaders("application/x-x509-ca-cert"),
        "Content-Disposition": 'attachment; filename="inventory-hub-ca.cer"',
        "Content-Length": String(certificate.byteLength),
      });
      if (request.method === "HEAD") response.end();
      else response.end(certificate);
      return;
    }
    if (path === "/healthz") {
      response.writeHead(200, portalHeaders("text/plain; charset=utf-8"));
      response.end("ok");
      return;
    }
    if (path !== "/" && path !== "/install") {
      response.writeHead(404, portalHeaders("text/plain; charset=utf-8"));
      response.end("Not Found");
      return;
    }

    const html = certificateInstallPage(this.options.appOrigin, this.options.caFingerprint);
    response.writeHead(200, {
      ...portalHeaders("text/html; charset=utf-8"),
      "Content-Length": String(Buffer.byteLength(html)),
    });
    if (request.method === "HEAD") response.end();
    else response.end(html);
  }
}

function certificateInstallPage(appOrigin: string, fingerprint: string): string {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>安装 Inventory Hub 证书</title><style>
:root{color-scheme:light dark;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}body{margin:0;background:#f5f7fb;color:#172033}.card{box-sizing:border-box;max-width:620px;margin:8vh auto;padding:28px;border:1px solid #d8deea;border-radius:20px;background:#fff;box-shadow:0 12px 40px #1f29371a}h1{font-size:24px;margin:0 0 18px}p,li{line-height:1.65}.button{display:block;margin:24px 0;padding:14px 18px;border-radius:12px;background:#1677ff;color:#fff;text-decoration:none;text-align:center;font-weight:650}.fingerprint{overflow-wrap:anywhere;padding:12px;border-radius:10px;background:#f0f3f8;font:12px ui-monospace,monospace}@media(max-width:680px){.card{margin:0;min-height:100vh;border:0;border-radius:0;padding:24px 20px}}@media(prefers-color-scheme:dark){body{background:#0e131d;color:#eef3ff}.card{background:#171e2a;border-color:#30394a}.fingerprint{background:#222b3a}}
</style></head><body><main class="card"><h1>安装 Inventory Hub 局域网证书</h1><ol><li>下载并安装下方公开 CA 证书。</li><li>在系统证书设置中确认信任；iPhone/iPad 还需开启“证书信任设置”中的完全信任。</li><li>核对证书 SHA-256 指纹后，再打开 Inventory Hub。</li></ol><a class="button" href="/inventory-hub-ca.cer">下载并安装证书</a><p>SHA-256 指纹</p><div class="fingerprint">${escapeHtml(fingerprint)}</div><a class="button" href="${escapeHtml(appOrigin)}">打开 Inventory Hub</a><p>此页面只提供公开证书，不包含服务器或签发机构私钥。</p></main></body></html>`;
}

function securityHeaders(contentType: string | string[] | undefined): Record<string, string> {
  const isHtml = typeof contentType === "string" && contentType.includes("text/html");
  return {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    ...(isHtml
      ? {
          "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' ws: wss:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
        }
      : {}),
  };
}

function portalHeaders(contentType: string): Record<string, string> {
  return {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'self'; style-src 'unsafe-inline'; img-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  };
}

function copyHeaders(headers: IncomingMessage["headers"]): Record<string, string | string[]> {
  const copy: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!HOP_BY_HOP_HEADERS.has(name.toLocaleLowerCase()) && value !== undefined) copy[name] = value;
  }
  return copy;
}

function secureSetCookies(headers: Record<string, string | string[]>): void {
  const value = headers["set-cookie"];
  if (!value) return;
  const secure = (cookie: string) => /(?:^|;)\s*Secure(?:;|$)/i.test(cookie) ? cookie : `${cookie}; Secure`;
  headers["set-cookie"] = Array.isArray(value) ? value.map(secure) : secure(value);
}

function listen(server: HttpsServer | ReturnType<typeof createHttpServer>, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen({ host, port, exclusive: true }, () => {
      server.off("error", onError);
      resolve();
    });
  });
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}
