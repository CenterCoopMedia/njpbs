export const MAX_REHEARSAL_TIMING_CASES = 20;

export const isRehearsalTimingOperationId = value => typeof value === 'string' && /^[A-Za-z0-9]{20}$/.test(value);
