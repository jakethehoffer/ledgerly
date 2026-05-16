export class UnhandledEventError extends Error {
  public readonly eventType: string;
  public readonly eventId: string;
  constructor(eventType: string, eventId: string) {
    super(`No handler registered for event type "${eventType}" (event ${eventId})`);
    this.name = 'UnhandledEventError';
    this.eventType = eventType;
    this.eventId = eventId;
  }
}

export class MissingExpansionError extends Error {
  public readonly field: string;
  public readonly eventId: string;
  constructor(field: string, eventId: string) {
    super(`Expected "${field}" to be an expanded object in event ${eventId}, got string ID`);
    this.name = 'MissingExpansionError';
    this.field = field;
    this.eventId = eventId;
  }
}

/**
 * Require a Stripe nested field to be pre-expanded (an object, not just an ID string).
 */
export function requireExpanded<T>(field: unknown, fieldName: string, eventId: string): T {
  if (field === null || field === undefined || typeof field === 'string') {
    throw new MissingExpansionError(fieldName, eventId);
  }
  return field as T;
}
