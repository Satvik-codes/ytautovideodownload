import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Enable CORS for frontend and Render deployments
  app.enableCors({
    origin: (
      origin: string | undefined,
      callback: (err: Error | null, allow?: boolean) => void,
    ) => {
      // Allow requests with no origin (e.g., mobile apps, curl, server-to-server)
      if (!origin) return callback(null, true);

      const frontendUrl = process.env.FRONTEND_URL;
      const allowedOrigins = [
        frontendUrl,
        'http://localhost:5173',
        'http://127.0.0.1:5173',
        'http://localhost:3000',
        'http://127.0.0.1:3000',
      ].filter(Boolean);

      const isAllowed =
        allowedOrigins.includes(origin) ||
        /\.onrender\.com$/.test(origin) ||
        /localhost(:\d+)?$/.test(origin);

      if (isAllowed) {
        callback(null, true);
      } else {
        // Fallback permissive for public video downloader API
        callback(null, true);
      }
    },
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    credentials: true,
  });

  const port = Number(process.env.PORT) || 3000;
  // Critical for Render: Must bind to 0.0.0.0 so external router can reach the container
  await app.listen(port, '0.0.0.0');
  console.log(`Backend server successfully listening on 0.0.0.0:${port}`);
}
await bootstrap();
