import express from 'express';
import { initializeDatabase, closeDatabase } from '../database/schema.js';
import { initializeRedis, closeRedis } from '../database/cache.js';
import { initializeScheduler, stopScheduler } from '../fetchers/scheduler.js';
import apiRoutes from './routes.js';

const app = express();
const PORT = parseInt(process.env.API_PORT || '8080');

// Middleware
app.use(express.json());

// CORS (if needed)
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') {
    res.sendStatus(200);
  } else {
    next();
  }
});

// API Routes
app.use(apiRoutes);

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Serve static files (if needed for UI)
app.use(express.static('../public'));

let server: any;

export async function startServer(): Promise<void> {
  try {
    // Initialize database
    console.log('Initializing database...');
    await initializeDatabase();

    // Initialize Redis
    console.log('Initializing Redis...');
    await initializeRedis();

    // Initialize data fetchers
    console.log('Initializing data fetcher scheduler...');
    await initializeScheduler();

    // Start HTTP server
    server = app.listen(PORT, () => {
      console.log(`API server running on http://localhost:${PORT}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

export async function stopServer(): Promise<void> {
  try {
    console.log('Stopping server...');

    if (server) {
      await new Promise<void>((resolve, reject) => {
        server.close((err?: any) => {
          if (err) reject(err);
          else resolve();
        });
      });
    }

    await stopScheduler();
    await closeRedis();
    await closeDatabase();

    console.log('Server stopped');
  } catch (error) {
    console.error('Error stopping server:', error);
  }
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down gracefully...');
  await stopServer();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('SIGINT received, shutting down gracefully...');
  await stopServer();
  process.exit(0);
});
