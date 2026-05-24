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

    const isSSE =
      req.path.includes('/stream') ||
      (req.headers.accept ?? '').includes('text/event-stream') ||
      res.getHeader('Content-Type') === 'text/event-stream';

    if (isSSE) {
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
    } else {
      res.setHeader('Vary', 'Accept-Encoding');

      const originalEnd = res.end.bind(res);
      const originalWrite = res.write.bind(res);
      const chunks: Buffer[] = [];

      res.write = (chunk: unknown, ...args: unknown[]) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
        return true;
      };

      res.end = (chunk?: unknown, ...args: unknown[]) => {
        if (chunk) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
        }

        const body = Buffer.concat(chunks);

        if (body.length < 1024) {
          return originalEnd(body);
        }

        res.setHeader('Content-Encoding', contentEncoding);
        const compressor = createCompressor();
        const compressed: Buffer[] = [];
        compressor.on('data', (data: Buffer) => compressed.push(data));
        compressor.on('end', () => originalEnd(Buffer.concat(compressed)));
        compressor.end(body);
        return res;
      };

      next();
    }
  };
}
