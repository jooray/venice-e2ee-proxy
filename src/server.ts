import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import type { ProxyConfig } from './config.js';
import { SessionManager } from './session-manager.js';
import { ProxyHandler } from './proxy.js';
import { logger } from './logger.js';

/**
 * Create and configure the Express server.
 */
export function createServer(config: ProxyConfig) {
  const app = express();
  const sessionManager = new SessionManager(config);
  const proxyHandler = new ProxyHandler(config, sessionManager);

  // Parse JSON bodies (large limit for long conversations); keep raw bytes for endpoint passthru
  app.use(
    express.json({
      limit: '10mb',
      verify: (req, _res, buf) => {
        (req as Request & { rawBody?: Buffer }).rawBody = buf;
      },
    })
  );

  // Request logging middleware
  app.use((req: Request, _res: Response, next: NextFunction) => {
    logger.info(`${req.method} ${req.path}`);
    next();
  });

  // Health check
  app.get('/health', (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      version: '1.0.0',
      verify_attestation: config.verify_attestation,
      enable_dcap: config.enable_dcap,
      endpoint_passthru: config.endpoint_passthru,
      e2ee_allow_tools: config.e2ee_allow_tools,
    });
  });

  // Main proxy endpoint - OpenAI compatible
  app.post('/v1/chat/completions', async (req: Request, res: Response) => {
    try {
      await proxyHandler.handleChatCompletions(req, res);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`Unhandled error: ${message}`);
      if (!res.headersSent) {
        res.status(500).json({ error: { message: 'Internal proxy error', type: 'proxy_error' } });
      }
    }
  });

  // Also support /chat/completions (without /v1 prefix)
  app.post('/chat/completions', async (req: Request, res: Response) => {
    try {
      await proxyHandler.handleChatCompletions(req, res);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`Unhandled error: ${message}`);
      if (!res.headersSent) {
        res.status(500).json({ error: { message: 'Internal proxy error', type: 'proxy_error' } });
      }
    }
  });

  app.get('/v1/models', async (req: Request, res: Response) => {
    try {
      await proxyHandler.handleModels(req, res);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`Unhandled error: ${message}`);
      if (!res.headersSent) {
        res.status(500).json({ error: { message: 'Internal proxy error', type: 'proxy_error' } });
      }
    }
  });

  app.get('/models', async (req: Request, res: Response) => {
    try {
      await proxyHandler.handleModels(req, res);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`Unhandled error: ${message}`);
      if (!res.headersSent) {
        res.status(500).json({ error: { message: 'Internal proxy error', type: 'proxy_error' } });
      }
    }
  });

  // Optional: forward any other path to Venice unchanged; otherwise 404
  app.use(async (req: Request, res: Response, next: NextFunction) => {
    if (!config.endpoint_passthru) {
      next();
      return;
    }
    try {
      await proxyHandler.handleVeniceEndpointPassthru(req, res);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`Unhandled passthru error: ${message}`);
      if (!res.headersSent) {
        res.status(500).json({ error: { message: 'Internal proxy error', type: 'proxy_error' } });
      }
    }
  });

  app.use((_req: Request, res: Response) => {
    res.status(404).json({
      error: {
        message:
          'Not found. Available endpoints: POST /v1/chat/completions, GET /v1/models, GET /health',
        type: 'invalid_request_error',
      },
    });
  });

  return { app, sessionManager };
}
