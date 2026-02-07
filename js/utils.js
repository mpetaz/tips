/**
 * Tipster-AI Utilities
 * 
 * Helper functions for data formatting, parsing, and fuzzy matching.
 */

// ==================== DATE UTILS ====================

/**
 * Format date from YYYY-MM-DD to DD/MM/YYYY
 */
function formatDateIT(dateString) {
    if (!dateString) return '';
    const [year, month, day] = dateString.split('-');
    return `${day}/${month}/${year}`;
}

/**
 * Parse date from DD/MM/YYYY to YYYY-MM-DD
 */
function parseDateIT(dateStringIT) {
    if (!dateStringIT) return '';
    const [day, month, year] = dateStringIT.split('/');
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
}

// ==================== NUMBER & DATA PARSING ====================

/**
 * Parse Italian-style odds (e.g., "1,35" -> 1.35)
 */
function parseQuota(quotaStr) {
    if (!quotaStr) return null;
    const cleaned = quotaStr.toString().replace(',', '.');
    return parseFloat(cleaned);
}

/**
 * Convert probability to odds
 */
function probabilityToOdds(prob) {
    if (prob <= 0 || prob >= 1) return 1.01;
    return Math.round((1 / prob) * 100) / 100;
}

/**
 * Get display name for tip codes
 */
function getTipDisplayName(tipCode) {
    const names = {
        '+1.5': 'OVER 1.5',
        '+2.5': 'OVER 2.5',
        '+3.5': 'OVER 3.5',
        '-1.5': 'UNDER 1.5',
        '-2.5': 'UNDER 2.5',
        '-3.5': 'UNDER 3.5'
    };
    return names[tipCode] || tipCode;
}

// ==================== TEXT & MATCHING UTILS ====================

/**
 * Extract team names from match string (e.g., "Milan - Inter" -> { home: "Milan", away: "Inter" })
 */
function parseTeams(partita) {
    if (!partita) return null;
    const parts = partita.split(/\s*[-–]\s*/);
    if (parts.length < 2) return null;
    return { home: parts[0].trim(), away: parts.slice(1).join(' - ').trim() };
}

/**
 * Extract goals from result string (e.g., "3-1" -> { home: 3, away: 1 })
 */
function parseResult(risultato) {
    if (!risultato) return null;
    const match = risultato.match(/(\d+)\s*[-–]\s*(\d+)/);
    if (!match) return null;
    return { home: parseInt(match[1]), away: parseInt(match[2]) };
}

/**
 * Basic Levenshtein distance for fuzzy matching
 */
function levenshteinDistance(a, b) {
    if (a.length === 0) return b.length;
    if (b.length === 0) return a.length;

    const matrix = [];

    // increment along the first column of each row
    for (let i = 0; i <= b.length; i++) {
        matrix[i] = [i];
    }

    // increment each column in the first row
    for (let j = 0; j <= a.length; j++) {
        matrix[0][j] = j;
    }

    // Fill in the rest of the matrix
    for (let i = 1; i <= b.length; i++) {
        for (let j = 1; j <= a.length; j++) {
            if (b.charAt(i - 1) === a.charAt(j - 1)) {
                matrix[i][j] = matrix[i - 1][j - 1];
            } else {
                matrix[i][j] = Math.min(
                    matrix[i - 1][j - 1] + 1, // substitution
                    Math.min(
                        matrix[i][j - 1] + 1, // insertion
                        matrix[i - 1][j] + 1  // deletion
                    )
                );
            }
        }
    }

    return matrix[b.length][a.length];
}

/**
 * Fuzzy match a team name against a list of candidates
 */
function fuzzyMatchTeam(teamName, candidates, threshold = 0.70) { // 70% threshold
    if (!teamName || !candidates || candidates.length === 0) return null;

    const normalizedInput = normalizeTeamName(teamName).toLowerCase();
    let bestMatch = null;
    let bestScore = 0;

    for (const candidate of candidates) {
        const normalizedCandidate = normalizeTeamName(candidate).toLowerCase();

        // Exact match
        if (normalizedInput === normalizedCandidate) return candidate;

        // Levenshtein similarity
        const distance = levenshteinDistance(normalizedInput, normalizedCandidate);
        const maxLength = Math.max(normalizedInput.length, normalizedCandidate.length);
        const score = 1 - (distance / maxLength);

        if (score > bestScore && score >= threshold) {
            bestScore = score;
            bestMatch = candidate;
        }
    }

    return bestMatch;
}

// ==================== CSV UTILS ====================

/**
 * Standard CSV Parser wrapper (assumes PapaParse is loaded)
 */
function parseCSVSafe(text) {
    if (typeof Papa === 'undefined') {
        console.error("PapaParse library not found!");
        return [];
    }
    const result = Papa.parse(text, {
        header: true,
        skipEmptyLines: true,
        transformHeader: (h) => h.trim().replace(/['"]/g, '') // Clean headers
    });
    return result.data;
}

// Export for global usage
window.formatDateIT = formatDateIT;
window.parseDateIT = parseDateIT;
window.parseQuota = parseQuota;
window.probabilityToOdds = probabilityToOdds;
window.getTipDisplayName = getTipDisplayName;
window.parseTeams = parseTeams;
window.parseResult = parseResult;
window.levenshteinDistance = levenshteinDistance;
window.fuzzyMatchTeam = fuzzyMatchTeam;
window.parseCSVSafe = parseCSVSafe;
