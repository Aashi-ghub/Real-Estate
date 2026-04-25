import type { JsonValue } from "@real-estate/types";

export class ExternalServiceError extends Error {
  public readonly retryable: boolean;
  public readonly statusCode: number | undefined;
  public readonly responseBody: JsonValue | undefined;

  constructor(message: string, options: { retryable: boolean; statusCode?: number; responseBody?: JsonValue }) {
    super(message);
    this.name = "ExternalServiceError";
    this.retryable = options.retryable;
    this.statusCode = options.statusCode;
    this.responseBody = options.responseBody;
  }
}
