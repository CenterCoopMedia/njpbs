import { createInitialPairStore } from './initial-pair-store.mjs';
export const createDevelopmentInitialPairStore = options => createInitialPairStore({ ...options, environment: 'development' });
