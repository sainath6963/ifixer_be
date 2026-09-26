import { ArgumentsHost, Catch, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { Request } from 'express';

interface ErrorDetails {
  message?: string | string[];
  error?: string;
  code?: string;
}

@Catch()
export class HttpExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  constructor(private readonly httpAdapterHost: HttpAdapterHost) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const { httpAdapter } = this.httpAdapterHost;
    const context = host.switchToHttp();
    const request = context.getRequest<Request>();
    const response = context.getResponse<unknown>();

    const statusCode =
      exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    const exceptionResponse =
      exception instanceof HttpException ? exception.getResponse() : undefined;
    const details = this.normalizeDetails(exceptionResponse);

    if (statusCode >= 500) {
      this.logger.error(
        `${request.method} ${request.originalUrl} failed`,
        exception instanceof Error ? exception.stack : undefined,
      );
    }

    httpAdapter.reply(
      response,
      {
        statusCode,
        code: details.code ?? this.defaultCode(statusCode),
        message:
          statusCode === 500 ? 'Internal server error' : (details.message ?? 'Request failed'),
        path: request.originalUrl,
        requestId: request.id,
        timestamp: new Date().toISOString(),
      },
      statusCode,
    );
  }

  private normalizeDetails(response: string | object | undefined): ErrorDetails {
    if (typeof response === 'string') {
      return { message: response };
    }

    if (response && typeof response === 'object') {
      return response;
    }

    return {};
  }

  private defaultCode(statusCode: number): string {
    return HttpStatus[statusCode] ?? 'UNKNOWN_ERROR';
  }
}
