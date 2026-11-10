import { createPairQualificationStore } from './pair-qualification-store.mjs';
export const createRehearsalQualificationStore = options => createPairQualificationStore({ ...options, environment: 'development' });
