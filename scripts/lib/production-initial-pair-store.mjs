import { createInitialPairStore } from './initial-pair-store.mjs';
export const createProductionInitialPairStore = options => createInitialPairStore({ ...options, environment: 'production' });
