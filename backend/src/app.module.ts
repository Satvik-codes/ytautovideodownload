import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ServeStaticModule } from '@nestjs/serve-static';
import * as path from 'path';
import * as fs from 'fs';
import { DownloaderModule } from './downloader/downloader.module.js';

const clientDistCandidates = [
  path.resolve(process.cwd(), 'client'),
  path.resolve(process.cwd(), '../frontend/dist'),
  path.resolve(process.cwd(), 'dist/client'),
];
const clientDistPath = clientDistCandidates.find((dir) => fs.existsSync(dir));

const moduleImports: any[] = [
  ConfigModule.forRoot({
    isGlobal: true,
    envFilePath: '.env',
  }),
  DownloaderModule,
];

if (clientDistPath) {
  moduleImports.push(
    ServeStaticModule.forRoot({
      rootPath: clientDistPath,
      exclude: ['/api/{*any}'],
    }),
  );
}

@Module({
  imports: moduleImports,
})
export class AppModule {}
