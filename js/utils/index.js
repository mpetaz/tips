/**
 * TipsterAI - Utility Functions: Index
 * 
 * Barrel file che esporta tutte le utility functions.
 * Import singolo: import { normalizeDeep, parsePair } from './utils/index.js';
 */

// Normalize functions
export { normalizeDeep, levenshteinDistance } from './normalize.js';

// Helper functions
export {
    parsePair,
    getRankingColor,
    isMatchStale,
    renderEventIcon,
    formatDateLong,
    getDataHash,
    DEFAULT_LOGO_BASE64
} from './helpers.js';

// Evaluate functions
export { evaluateTipLocally } from './evaluate.js';
