import { runInitialPairs } from './initial-pairs.mjs';
import { parseInitialPairsPacket } from './initial-pairs-packet.mjs';
export const parseProductionInitialPairsPacket = raw => parseInitialPairsPacket(raw, 'production');
export const runProductionInitialPairs = options => runInitialPairs({ ...options, environment: 'production' });
