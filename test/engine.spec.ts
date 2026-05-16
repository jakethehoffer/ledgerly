import { describe, it, expect } from 'vitest';
import type Stripe from 'stripe';
import { mapEvent } from '../src/engine.js';
import { UnhandledEventError } from '../src/errors.js';

describe('mapEvent', () => {
  it('throws UnhandledEventError for unknown event types', () => {
    const event = {
      id: 'evt_unknown_001',
      type: 'foo.bar.baz',
      data: { object: {} },
    } as unknown as Stripe.Event;

    expect(() => mapEvent(event)).toThrow(UnhandledEventError);
    expect(() => mapEvent(event)).toThrow(/foo\.bar\.baz/);
    expect(() => mapEvent(event)).toThrow(/evt_unknown_001/);
  });
});
