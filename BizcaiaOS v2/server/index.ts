import express, { type ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';
import { authenticate } from './auth.js';
import { pool } from './database.js';
import { apiRouter, requestPath } from './routes.js';
import { operationsRouter } from './operationsRoutes.js';

export const app = express();

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '256kb' }));

app.get('/health', async (_request, response, next) => {
  try {
    await pool.query('select 1');
    response.json({ status: 'ok' });
  } catch (error) {
    next(error);
  }
});

app.use('/api/v1', authenticate, apiRouter);
app.use('/api/v1/ops', authenticate, operationsRouter);

app.use((request, response) => {
  response.status(404).json({
    error: {
      code: 'not_found',
      message: `No endpoint exists at ${requestPath(request)}`,
    },
  });
});

const errorHandler: ErrorRequestHandler = (error, _request, response, _next) => {
  if (error instanceof ZodError) {
    response.status(400).json({
      error: {
        code: 'validation_error',
        message: 'Request validation failed',
        details: error.issues,
      },
    });
    return;
  }

  const errorRecord = error as { code?: unknown; status?: unknown; message?: unknown };
  const databaseCode = typeof errorRecord.code === 'string' ? errorRecord.code : undefined;
  const explicitStatus = typeof errorRecord.status === 'number' ? errorRecord.status : undefined;
  const databaseStatus: Record<string, number> = {
    '42501': 403,
    '23505': 409,
    '23514': 422,
    '22023': 422,
    P0002: 404,
  };
  const status =
    explicitStatus ??
    databaseStatus[databaseCode ?? ''] ??
    500;

  const safeMessage =
    status >= 500
      ? 'An internal server error occurred'
      : String(errorRecord.message ?? 'Request failed');

  if (status >= 500) {
    console.error(error);
  }

  response.status(status).json({
    error: {
      code: databaseCode ?? (status === 401 ? 'unauthorized' : status === 403 ? 'forbidden' : 'request_failed'),
      message: safeMessage,
    },
  });
};

app.use(errorHandler);

if (process.env.NODE_ENV !== 'test') {
  const port = Number(process.env.API_PORT ?? 8787);
  app.listen(port, '0.0.0.0', () => {
    console.log(`BizcaiaOS API listening on http://0.0.0.0:${port}`);
  });
}
