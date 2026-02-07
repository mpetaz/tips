/**
 * TipsterAI - Utility Functions: Evaluate
 * 
 * Funzioni per la valutazione degli esiti dei pronostici.
 * Usata come fallback quando i dati live hub non sono disponibili.
 */

/**
 * Evaluate a betting tip locally based on final score
 * Used as fallback for matches not tracked by API
 * 
 * @param {string} tip - The betting tip (e.g., "Over 2.5", "1X", "Lay The Draw")
 * @param {string} risultato - The final score (e.g., "2-1")
 * @returns {string|null} - 'Vinto', 'Perso', or null if can't evaluate
 */
export function evaluateTipLocally(tip, risultato, isFinished = true) {
    if (!tip || !risultato) return null;

    const parts = risultato.split('-').map(s => parseInt(s.trim()));
    if (parts.length !== 2 || isNaN(parts[0]) || isNaN(parts[1])) return null;

    const gH = parts[0];  // Home goals
    const gA = parts[1];  // Away goals
    const total = gH + gA;
    const t = String(tip).toLowerCase().trim();

    // --- TRADING SPECIFICO: Pattern esatti valutati PRIMA dei generici ---

    // "Back Under X" = vinci se total < X
    if (t.includes("back under 3.5") || t.includes("lay over 3.5")) {
        if (total >= 4) return 'Perso';
        return isFinished ? 'Vinto' : 'Live (Green)';
    }
    if (t.includes("back under 2.5") || t.includes("lay over 2.5")) {
        if (total >= 3) return 'Perso';
        return isFinished ? 'Vinto' : 'Live (Green)';
    }
    if (t.includes("back under 1.5") || t.includes("lay over 1.5")) {
        if (total >= 2) return 'Perso';
        return isFinished ? 'Vinto' : 'Live (Green)';
    }

    // "Back Over X" = vinci se total >= X
    if (t.includes("back over 2.5") || t.includes("lay under 2.5")) {
        if (total >= 3) return 'Vinto';
        if (total > 0) return 'Cash-out';
        return 'Perso';
    }
    if (t.includes("back over 3.5") || t.includes("lay under 3.5")) {
        if (total >= 4) return 'Vinto';
        if (total > 0) return 'Cash-out';
        return 'Perso';
    }

    // Lay the Draw
    if (t.includes("lay the draw") || t.includes("lay draw") || t.includes("laythedraw")) {
        if (gH !== gA) return 'Vinto';
        if (total >= 2) return 'Cash-out';
        return 'Perso';
    }

    // Over/Under logic (standard)
    if (t.includes("+0.5") || t.includes("over 0.5") || t.match(/\bo\s?0\.5/)) return total >= 1 ? 'Vinto' : 'Perso';
    if (t.includes("+1.5") || t.includes("over 1.5") || t.match(/\bo\s?1\.5/)) return total >= 2 ? 'Vinto' : 'Perso';
    if (t.includes("+2.5") || t.includes("over 2.5") || t.match(/\bo\s?2\.5/)) return total >= 3 ? 'Vinto' : 'Perso';
    if (t.includes("+3.5") || t.includes("over 3.5") || t.match(/\bo\s?3\.5/)) return total >= 4 ? 'Vinto' : 'Perso';

    if (t.includes("-0.5") || t.includes("under 0.5") || t.match(/\bu\s?0\.5/)) {
        if (total >= 1) return 'Perso';
        return isFinished ? 'Vinto' : 'Live (Green)';
    }
    if (t.includes("-1.5") || t.includes("under 1.5") || t.match(/\bu\s?1\.5/)) {
        if (total >= 2) return 'Perso';
        return isFinished ? 'Vinto' : 'Live (Green)';
    }
    if (t.includes("-2.5") || t.includes("under 2.5") || t.match(/\bu\s?2\.5/)) {
        if (total >= 3) return 'Perso';
        return isFinished ? 'Vinto' : 'Live (Green)';
    }
    if (t.includes("-3.5") || t.includes("under 3.5") || t.match(/\bu\s?3\.5/)) {
        if (total >= 4) return 'Perso';
        return isFinished ? 'Vinto' : 'Live (Green)';
    }

    // BTTS / No Goal
    if (t === "gg" || t.includes("btts") || t === "gol" || t === "goal") {
        return (gH > 0 && gA > 0) ? 'Vinto' : 'Perso';
    }
    if (t === "ng" || t === "no gol" || t === "no goal" || t.includes("no goal")) {
        if (gH > 0 && gA > 0) return 'Perso';
        return isFinished ? 'Vinto' : 'Live (Green)';
    }

    // 1X2 / Double Chance
    const cleanT = t.replace(/[^a-z0-9]/g, "");
    if (cleanT === "1") return gH > gA ? 'Vinto' : 'Perso';
    if (cleanT === "2") return gA > gH ? 'Vinto' : 'Perso';
    if (cleanT === "x") return gH === gA ? 'Vinto' : 'Perso';
    if (cleanT === "1x" || cleanT === "x1") return gH >= gA ? 'Vinto' : 'Perso';
    if (cleanT === "x2" || cleanT === "2x") return gA >= gH ? 'Vinto' : 'Perso';
    if (cleanT === "12" || cleanT === "21") return gH !== gA ? 'Vinto' : 'Perso';

    return null;
}

// Expose globally for backward compatibility
window.evaluateTipLocally = evaluateTipLocally;
