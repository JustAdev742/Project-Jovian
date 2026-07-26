import { FastifyReply } from 'fastify';

/**
 * Standard Epic Games error response format.
 * The Fortnite client parses these — wrong format = crash.
 */
export interface EpicError {
  errorCode: string;
  errorMessage: string;
  messageVars: string[];
  numericErrorCode: number;
  originatingService: string;
  intent: string;
}

export function sendEpicError(
  reply: FastifyReply,
  statusCode: number,
  errorCode: string,
  errorMessage: string,
  numericErrorCode: number = 0
): void {
  const error: EpicError = {
    errorCode,
    errorMessage,
    messageVars: [],
    numericErrorCode,
    originatingService: 'com.epicgames.account.public',
    intent: 'prod',
  };

  reply.status(statusCode).send(error);
}

/** Common error shortcuts */
export const Errors = {
  notFound: (reply: FastifyReply, message: string = 'Resource not found') =>
    sendEpicError(reply, 404, 'errors.com.epicgames.common.not_found', message, 1004),

  unauthorized: (reply: FastifyReply, message: string = 'Authentication failed') =>
    sendEpicError(reply, 401, 'errors.com.epicgames.common.authentication.authentication_failed', message, 1032),

  invalidToken: (reply: FastifyReply) =>
    sendEpicError(reply, 401, 'errors.com.epicgames.common.oauth.invalid_token', 'The token is invalid or has expired.', 1014),

  invalidRequest: (reply: FastifyReply, message: string = 'Invalid request') =>
    sendEpicError(reply, 400, 'errors.com.epicgames.common.invalid_payload', message, 1040),

  serverError: (reply: FastifyReply, message: string = 'Internal server error') =>
    sendEpicError(reply, 500, 'errors.com.epicgames.common.server_error', message, 1000),

  throttled: (reply: FastifyReply) =>
    sendEpicError(reply, 429, 'errors.com.epicgames.common.throttled', 'Too many requests', 1041),

  operationNotFound: (reply: FastifyReply, operation: string) =>
    sendEpicError(reply, 404, 'errors.com.epicgames.fortnite.operation_not_found', `Operation ${operation} not found`, 16035),
};
