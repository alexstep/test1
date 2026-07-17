import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';

interface ValidationError {
  property: string;
  constraints?: Record<string, string>;
  children?: ValidationError[];
}

@Catch(HttpException)
export class HttpExceptionFilter implements ExceptionFilter {
  catch(exception: HttpException, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<FastifyReply>();
    const status = exception.getStatus();
    const exceptionResponse = exception.getResponse();

    let message = 'Internal server error';
    let errors: { field: string; message: string }[] | undefined;

    if (typeof exceptionResponse === 'string') {
      message = exceptionResponse;
    } else if (typeof exceptionResponse === 'object') {
      const resp = exceptionResponse as Record<string, unknown>;
      message = (resp['message'] as string) || exception.message;

      if (Array.isArray(resp['message'])) {
        message = 'Validation failed';
        errors = this.formatValidationErrors(resp['message'] as (string | ValidationError)[]);
      }
    }

    response.code(status).send({
      statusCode: status,
      message,
      ...(errors ? { errors } : {}),
    });
  }

  private formatValidationErrors(messages: (string | ValidationError)[]): { field: string; message: string }[] {
    return messages.map((msg) => {
      if (typeof msg === 'string') {
        return { field: 'unknown', message: msg };
      }
      const constraints = msg.constraints || {};
      return {
        field: msg.property,
        message: Object.values(constraints).join(', '),
      };
    });
  }
}
