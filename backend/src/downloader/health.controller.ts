import { Controller, Get } from '@nestjs/common';
import { WarpService, WarpStatus } from './warp.service.js';

@Controller('api')
export class HealthController {
  constructor(private readonly warpService: WarpService) {}

  @Get('health')
  async health(): Promise<{ status: string; warp: WarpStatus }> {
    return { status: 'ok', warp: await this.warpService.getStatus() };
  }
}
