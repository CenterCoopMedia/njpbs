import { createRequire } from 'node:module';
// One CJS module identity keeps native WeakMap proofs and canonical target
// objects together. Scoped TS require plus plain native require duplicates them.
createRequire(new URL('../../site/package.json', import.meta.url))('tsx/cjs/api').register();
export const initialPairNative = (filename, parentURL) => createRequire(parentURL)(filename);
