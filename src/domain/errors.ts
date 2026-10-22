/** Errors that are safe to show to the end user / model. */
export class DomainError extends Error {
  constructor(
    public code: 'not_found' | 'forbidden' | 'invalid' | 'conflict' | 'unauthenticated',
    message: string,
  ) {
    super(message);
  }
}

export const notFound = (what: string) => new DomainError('not_found', `${what} not found`);
export const forbidden = (msg = 'You do not have access to this item') => new DomainError('forbidden', msg);
export const invalid = (msg: string) => new DomainError('invalid', msg);
