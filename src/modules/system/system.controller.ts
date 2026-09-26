import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

@ApiTags('system')
@Controller()
export class SystemController {
  constructor(private readonly config: ConfigService) {}

  @Get()
  @ApiOperation({ summary: 'API metadata' })
  metadata(): {
    name: string;
    version: string;
    environment: string;
  } {
    return {
      name: 'Rich Culture API',
      version: '0.1.0',
      environment: this.config.getOrThrow<string>('NODE_ENV'),
    };
  }
}
