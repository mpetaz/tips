/**
 * TipsterAI - Utility Functions: Normalize
 * 
 * Funzioni per la normalizzazione di stringhe, nomi partite e chiavi.
 * Utilizzate sia dal frontend che dal backend per matching consistente.
 */

/**
 * Deep normalization for match keys - identical to Backend!
 * Removes special chars and collapses double letters.
 * @param {string} str - The string to normalize
 * @returns {string} - Normalized string
 * @example normalizeDeep("Al-Shabbab FC") → "alshabfc"
 */
export function normalizeDeep(str) {
    if (!str) return "";
    return str
        .toLowerCase()
        .replace(/[^a-z0-9]/g, "")
        .replace(/(.)\1+/g, "$1");
}

/**
 * Levenshtein distance for fuzzy matching
 * Used for matching API team names with CSV names
 * @param {string} a - First string
 * @param {string} b - Second string
 * @returns {number} - Edit distance between strings
 */
export function levenshteinDistance(a, b) {
    if (!a || !b) return Math.max((a || "").length, (b || "").length);

    const matrix = [];

    for (let i = 0; i <= b.length; i++) {
        matrix[i] = [i];
    }

    for (let j = 0; j <= a.length; j++) {
        matrix[0][j] = j;
    }

    for (let i = 1; i <= b.length; i++) {
        for (let j = 1; j <= a.length; j++) {
            if (b.charAt(i - 1) === a.charAt(j - 1)) {
                matrix[i][j] = matrix[i - 1][j - 1];
            } else {
                matrix[i][j] = Math.min(
                    matrix[i - 1][j - 1] + 1,
                    matrix[i][j - 1] + 1,
                    matrix[i - 1][j] + 1
                );
            }
        }
    }

    return matrix[b.length][a.length];
}

// Expose globally for backward compatibility
window.normalizeDeep = normalizeDeep;
window.levenshteinDistance = levenshteinDistance;
