import { parseInitialPairsPacket } from './initial-pairs-packet.mjs';
export const parseDevelopmentInitialPairsPacket = raw => parseInitialPairsPacket(raw, 'development');
