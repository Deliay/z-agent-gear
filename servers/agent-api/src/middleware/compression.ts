import type express from 'express';
import { createBrotliCompress, createGzip } from 'node:zlib';

export function compressionMiddleware(): express.RequestHandler {
  return (req, res, next) => {
    const acceptEncoding = req.headers['accept-encoding'] || '';
    const useBrotli = acceptEncoding.includes('br');
    const useGzip = acceptEncoding.includes('gzip');

    if (!useBrotli && !useGzip) {
      next();
      return;
    }

    const contentEncoding = useBrotli ? 'br' : 'gzip';
    const createCompressor = () => (useBrotli ? createBrotliCompress() : createGzip());

    // Only compress actual SSE streams. NOTE: the request's Accept header
    // must NOT be used for this decision — MCP Streamable HTTP clients send
    // `Accept: application/json, text/event-stream` on ordinary JSON-RPC
    // POSTs, and compressing those one-shot responses truncated the gzip
    // stream (stale Content-Length), which hung MCP client handshakes.
    const isSSE =
      req.path.includes('/stream') ||
      res.getHeader('Content-Type') === 'text/event-stream';

    if (!isSSE) {
      next();
      return;
    }

    const compressor = createCompressor();

    res.setHeader('Content-Encoding', contentEncoding);
    res.setHeader('Vary', 'Accept-Encoding');

    const originalWrite = res.write.bind(res);
    const originalEnd = res.end.bind(res);

    compressor.on('data', (chunk: Buffer) => originalWrite(chunk));
    compressor.on('end', () => originalEnd());

    res.write = function (chunk: unknown, ...args: unknown[]) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
      compressor.write(buf);
      compressor.flush();
      return true;
    };

    res.end = function (chunk?: unknown, ...args: unknown[]) {
      if (chunk) {
        compressor.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
      }
      compressor.end();
      return res;
    };

    next();
  };
}
