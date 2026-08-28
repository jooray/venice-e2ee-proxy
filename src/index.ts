import 'dotenv/config';
import { loadConfig } from './config.js';
import { createServer } from './server.js';
import { setLogLevel } from './logger.js';
import { logger } from './logger.js';

// Load configuration
const config = loadConfig();
setLogLevel(config.log_level);

// Create and start server
const { app, sessionManager } = createServer(config);

const server = app.listen(config.port, config.host, () => {
  logger.info(`Venice E2EE Proxy listening on http://${config.host}:${config.port}`);
  logger.info(`Venice API: ${config.venice_base_url}`);
  logger.info(`Attestation verification: ${config.verify_attestation ? 'enabled' : 'DISABLED'}`);
  logger.info(`DCAP verification: ${config.enable_dcap ? 'enabled' : 'disabled'}`);
  logger.info(
    `GPU attestation: ${config.verify_gpu_attestation ? 'enabled (fails closed)' : 'disabled'}` +
    (config.verify_gpu_attestation && config.verify_gpu_token_signatures
      ? ', NVIDIA token signatures verified'
      : '')
  );
  logger.info(`Session TTL: ${config.session_ttl / 1000}s`);
  logger.info('');
  logger.info('Usage:');
  logger.info(`  curl http://${config.host}:${config.port}/v1/chat/completions \\`);
  logger.info('    -H "Content-Type: application/json" \\');
  logger.info('    -d \'{"model": "e2ee-glm-5-2-p", "messages": [{"role": "user", "content": "Hello!"}]}\'');
});

// Graceful shutdown
function shutdown(signal: string) {
  logger.info(`Received ${signal}, shutting down gracefully...`);
  sessionManager.destroy();
  server.close(() => {
    logger.info('Server closed');
    process.exit(0);
  });

  // Force exit after 5 seconds
  setTimeout(() => {
    logger.warn('Forced shutdown after timeout');
    process.exit(1);
  }, 5000);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// Export for testing
export { app, sessionManager, config };
