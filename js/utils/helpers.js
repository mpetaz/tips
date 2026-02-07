/**
 * TipsterAI - Utility Functions: Helpers
 * 
 * Funzioni helper generiche per parsing, formattazione e calcoli.
 */

/**
 * Parse a score pair string into array of numbers
 * @param {string} str - Score string like "2 - 1" or "45% - 55%"
 * @returns {number[]} - Array of two numbers [home, away]
 * @example parsePair("2 - 1") → [2, 1]
 */
export function parsePair(str) {
    if (!str) return [0, 0];
    return str.split(' - ').map(x => parseInt(x.trim()) || 0);
}

/**
 * Get ranking color based on score value
 * @param {number} score - Score from 0-100
 * @returns {string} - Tailwind color class name
 */
export function getRankingColor(score) {
    if (!score && score !== 0) return 'gray-400';
    if (score >= 80) return 'emerald-500';
    if (score >= 65) return 'yellow-400';
    return 'red-500';
}

/**
 * Check if a match is stale (old/outdated)
 * Currently disabled per user request
 * @param {object} m - Match object
 * @returns {boolean} - Always false (disabled)
 */
export function isMatchStale(m) {
    // DISABILITATO SU RICHIESTA UTENTE PER RIPRISTINARE VISIBILITÀ TOTALE
    return false;
}

/**
 * Render event icon based on event type
 * @param {string} type - Event type (Goal, Card, etc.)
 * @param {string} detail - Event detail
 * @returns {string} - Emoji icon
 */
export function renderEventIcon(type, detail) {
    const t = (type || "").toUpperCase();
    const d = (detail || "").toUpperCase();

    if (t.includes('GOAL')) return '⚽';
    if (t.includes('VAR') || d.includes('VAR')) return '🖥️';
    if (t.includes('SUBST') || t.includes('SOS') || d.includes('SUBSTITUTION')) return '🔄';
    if (t.includes('RED') || d.includes('RED CARD')) return '🟥';
    if (t.includes('YELLOW') || d.includes('YELLOW CARD')) return '🟨';
    if (t.includes('PENALTY')) return '🥅';
    if (t.includes('CORNER')) return '🚩';

    return '⏱️';
}

/**
 * Format date in Italian long format
 * @param {string} dateStr - Date string YYYY-MM-DD
 * @returns {string} - Formatted date like "Oggi", "Ieri", or "16 Gen"
 */
export function formatDateLong(dateStr) {
    const today = new Date().toISOString().split('T')[0];
    const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];

    const date = new Date(dateStr + 'T12:00:00');
    const months = ['Gen', 'Feb', 'Mar', 'Apr', 'Mag', 'Giu', 'Lug', 'Ago', 'Set', 'Ott', 'Nov', 'Dic'];
    const formattedDate = `${date.getDate()} ${months[date.getMonth()]}`;

    if (dateStr === today) return `Oggi (${formattedDate})`;
    if (dateStr === yesterday) return `Ieri (${formattedDate})`;

    return formattedDate;
}

/**
 * Format date in short Italian format (e.g., "16 Gen")
 * @param {string} dateStr - Date string YYYY-MM-DD
 * @returns {string} - Formatted date
 */
export function formatDateShort(dateStr) {
    if (!dateStr) return "-";
    const date = new Date(dateStr + 'T12:00:00');
    const months = ['Gen', 'Feb', 'Mar', 'Apr', 'Mag', 'Giu', 'Lug', 'Ago', 'Set', 'Ott', 'Nov', 'Dic'];
    return `${date.getDate()} ${months[date.getMonth()]}`;
}

/**
 * Get hash of data for anti-flicker caching
 * Ignores volatile timestamps
 * @param {*} data - Any data to hash
 * @returns {string} - Hash string
 */
export function getDataHash(data) {
    if (!data) return 'null';
    try {
        return JSON.stringify(data, (key, value) => {
            if (key === 'updatedAt' || key === 'lastRefresh' || key === 'lastUpdated' || key === 'lastUpdate') return undefined;
            return value;
        });
    } catch (e) {
        return Math.random().toString();
    }
}

/**
 * Default placeholder logo (1x1 transparent GIF)
 */
export const DEFAULT_LOGO_BASE64 = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

// Expose globally for backward compatibility
window.parsePair = parsePair;
window.getRankingColor = getRankingColor;
window.isMatchStale = isMatchStale;
window.renderEventIcon = renderEventIcon;
window.formatDateLong = formatDateLong;
window.formatDateShort = formatDateShort;
window.getDataHash = getDataHash;
window.DEFAULT_LOGO_BASE64 = DEFAULT_LOGO_BASE64;
