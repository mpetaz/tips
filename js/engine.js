console.log('%c[Elite Engine 4.0] Logic Loaded | Professional First Active', 'color: #00ff00; font-weight: bold; background: #000; padding: 5px;');
// ==================== CONFIGURATION & CONSTANTS ====================
// Now using global STRATEGY_CONFIG from js/config.js

// 🔥 FIX v4.5: League DNA extracted from historical data (Avg Goals, H-Adv, Volatility)
const LEAGUE_DNA = {
    'eredivisie': { avg: 3.27, hAdv: 0.14, entropy: 1.25, vLevel: 'BALLERINA' }, // Volatile
    'bundesliga': { avg: 3.27, hAdv: 0.28, entropy: 1.15, vLevel: 'ALTA' },
    '3. liga': { avg: 3.27, hAdv: 0.28, entropy: 1.15, vLevel: 'ALTA' },
    'premier league': { avg: 2.77, hAdv: 0.40, entropy: 1.10, vLevel: 'MEDIA' },
    'la liga': { avg: 2.56, hAdv: 0.31, entropy: 1.00, vLevel: 'STABILE' },
    'serie a': { avg: 2.39, hAdv: 0.05, entropy: 0.85, vLevel: 'SOLIDA' }, // Reliable
    'serie b': { avg: 2.50, hAdv: 0.35, entropy: 0.80, vLevel: 'SOLIDA' },
    'championship': { avg: 2.60, hAdv: 0.29, entropy: 1.10, vLevel: 'MEDIA' },
    'portugal': { avg: 2.88, hAdv: 0.26, entropy: 1.05, vLevel: 'MEDIA' },
    'ligat ha\'al': { avg: 3.01, hAdv: 0.25, entropy: 1.00, vLevel: 'MEDIA' },
    'k league 2': { avg: 2.30, hAdv: 0.41, entropy: 0.90, vLevel: 'STABILE' }
};

// 🔥 FIX v4.4: Dynamic Goal Factors calculated from dbCompleto
let DYNAMIC_GOAL_FACTORS = null;

/**
 * Calculates dynamic goal factors from historical data
 * Call this once when dbCompleto is loaded
 * @param {Array} dbCompleto - Historical match database
 * @returns {Object} League -> GoalFactor mapping
 */
function calculateDynamicGoalFactors(dbCompleto) {
    if (!dbCompleto || dbCompleto.length < 100) {
        console.warn('[Engine v4.4] Not enough data for dynamic factors, using static');
        return LEAGUE_GOAL_FACTORS;
    }

    const leagueGoals = {};
    let globalTotalGoals = 0;
    let globalTotalMatches = 0;

    // Calculate average goals per league
    dbCompleto.forEach(m => {
        if (!m.risultato || !m.lega) return;
        const res = m.risultato.match(/(\d+)-(\d+)/);
        if (!res) return;

        const goals = parseInt(res[1]) + parseInt(res[2]);
        const legaNorm = (m.lega || '').toLowerCase().trim();

        // Extract league name (remove country prefix like "EU-ITA ")
        const leagueKey = legaNorm.replace(/^eu-[a-z]{3}\s*/i, '').replace(/\[.*?\]/g, '').trim();

        if (!leagueGoals[leagueKey]) {
            leagueGoals[leagueKey] = { totalGoals: 0, matches: 0 };
        }
        leagueGoals[leagueKey].totalGoals += goals;
        leagueGoals[leagueKey].matches++;
        globalTotalGoals += goals;
        globalTotalMatches++;
    });

    const globalAvg = globalTotalMatches > 0 ? globalTotalGoals / globalTotalMatches : 2.5;
    const dynamicFactors = {};

    Object.entries(leagueGoals).forEach(([league, stats]) => {
        if (stats.matches >= 20) { // Minimum 20 matches for reliable factor
            const leagueAvg = stats.totalGoals / stats.matches;
            dynamicFactors[league] = Math.round((leagueAvg / globalAvg) * 100) / 100; // Factor = league avg / global avg
        }
    });

    console.log(`[Engine v4.4] Dynamic Goal Factors calculated from ${globalTotalMatches} matches:`, dynamicFactors);
    return dynamicFactors;
}

/**
 * Gets goal factor for a league (dynamic first, then static fallback)
 * @param {string} leagueNorm - Normalized league name
 * @returns {number} Goal factor (1.0 = average)
 */
function getGoalFactor(leagueNorm) {
    const cleanLega = leagueNorm.replace(/^eu-[a-z]{3}\s*/i, '').replace(/\[.*?\]/g, '').toLowerCase().trim();

    // 🔥 1. Check LEAGUE_DNA (v4.5)
    for (const [league, dna] of Object.entries(LEAGUE_DNA)) {
        if (cleanLega.includes(league) || league.includes(cleanLega)) {
            return dna.avg / 2.72; // Normalized to our global baseline
        }
    }

    // 🔥 2. Try dynamic factor (v4.4 fallback)
    if (DYNAMIC_GOAL_FACTORS) {
        for (const [league, factor] of Object.entries(DYNAMIC_GOAL_FACTORS)) {
            if (cleanLega.includes(league) || league.includes(cleanLega)) {
                return factor;
            }
        }
    }

    return 1.0; // Default
}

/**
 * ENTROPY FACTORS: High entropy = Chaotic/Unpredictable (Eredivisie), 
 * Low entropy = Disciplined/Strategic (Serie A, Serie B).
 * Used to add "jitter" to the Monte Carlo simulation.
 */
const LEAGUE_ENTROPY_FACTORS = {
    'eredivisie': 1.25,
    'bundesliga': 1.15,
    'premier league': 1.10,
    'ligue 1': 1.00,
    'la liga': 0.95,
    'serie a': 0.85,
    'serie b': 0.80,
    'portugal': 1.05,
    'championship': 1.10
};

const STANDINGS_BLACKLIST_KEYWORDS = [
    'cup', 'coppa', 'trofeo', 'trophy', 'champions', 'europa', 'conference', 'fa', 'copa',
    'super cup', 'supercoppa', 'qualifiers', 'play-off', 'friendlies', 'friendly', 'international'
];

// 🔥 FIX v4.4: Optimal Rho calculated from historical data
let OPTIMAL_RHO = null;

/**
 * Calculates optimal Dixon-Coles Rho from historical data
 * The Rho parameter corrects for correlation in low-scoring matches (0-0, 1-0, 0-1, 1-1)
 * @param {Array} dbCompleto - Historical match database
 * @returns {number} Optimal Rho (typically between -0.20 and 0)
 */
function calculateOptimalRho(dbCompleto) {
    if (!dbCompleto || dbCompleto.length < 500) {
        console.warn('[Engine v4.4] Not enough data for Rho optimization, using default -0.11');
        return -0.11;
    }

    let lowScoreCount = 0;
    let totalMatches = 0;

    // Count low-scoring matches (0-0, 1-0, 0-1, 1-1)
    dbCompleto.forEach(m => {
        if (!m.risultato) return;
        const res = m.risultato.match(/(\d+)-(\d+)/);
        if (!res) return;

        const hg = parseInt(res[1]);
        const ag = parseInt(res[2]);
        totalMatches++;

        if ((hg === 0 && ag === 0) || (hg === 1 && ag === 0) ||
            (hg === 0 && ag === 1) || (hg === 1 && ag === 1)) {
            lowScoreCount++;
        }
    });

    // Expected low-score frequency under pure Poisson with avg lambda ~1.3 (typical)
    // P(0-0) + P(1-0) + P(0-1) + P(1-1) ≈ 0.27 under Poisson(1.3, 1.1)
    const expectedLowScore = 0.27;
    const actualLowScore = lowScoreCount / totalMatches;

    // Rho adjustment: If actual is higher than expected, Rho should be more negative
    // Formula: Rho = (expected - actual) * adjustment_factor
    // Clamped between -0.20 and 0
    const rhoDiff = (expectedLowScore - actualLowScore) * 1.5;
    const optimalRho = Math.max(-0.20, Math.min(0, -0.11 + rhoDiff));

    console.log(`[Engine v4.4] Rho Analysis: ${totalMatches} matches, ${lowScoreCount} low-score (${(actualLowScore * 100).toFixed(1)}%), Expected: ${(expectedLowScore * 100).toFixed(1)}%`);
    console.log(`[Engine v4.4] Calculated Optimal Rho: ${optimalRho.toFixed(3)}`);

    return Math.round(optimalRho * 1000) / 1000;
}

/**
 * Gets the Dixon-Coles Rho value (optimal if calculated, else config/default)
 * @returns {number} Rho value
 */
function getDixonColesRho() {
    if (OPTIMAL_RHO !== null) return OPTIMAL_RHO;
    if (typeof STRATEGY_CONFIG !== 'undefined' && STRATEGY_CONFIG.ENGINE?.DIXON_COLES_RHO) {
        return STRATEGY_CONFIG.ENGINE.DIXON_COLES_RHO;
    }
    return -0.11; // Default
}

// DIXON_COLES_RHO and MIN_VALUE_EDGE are now in STRATEGY_CONFIG

/**
 * Calculates the Value Edge between AI probability and Betfair odds
 * @param {number} aiProbability - AI calculated probability (0-100)
 * @param {number} betfairOdds - Betfair decimal odds (e.g., 2.50)
 * @returns {object} { valueEdge, roi, impliedProb, hasProfitableEdge }
 */
function calculateValueEdge(aiProbability, betfairOdds) {
    if (!betfairOdds || betfairOdds <= 1) {
        return { valueEdge: 0, roi: 0, impliedProb: 100, hasProfitableEdge: false };
    }

    const impliedProb = (1 / betfairOdds) * 100;
    const valueEdge = aiProbability - impliedProb;
    const roi = (valueEdge / impliedProb) * 100; // ROI percentage
    const minEdge = (typeof STRATEGY_CONFIG !== 'undefined') ? STRATEGY_CONFIG.TRADING.MIN_VALUE_EDGE : 3;
    const hasProfitableEdge = valueEdge >= minEdge;

    return {
        valueEdge: Math.round(valueEdge * 10) / 10,
        roi: Math.round(roi * 10) / 10,
        impliedProb: Math.round(impliedProb * 10) / 10,
        hasProfitableEdge
    };
}

/**
 * Calculates exponential time weight for a match based on its age.
 * @param {string} matchDateStr - ISO date string of the match
 * @returns {number} weight between 0.1 and 1.0
 */
function calculateTimeWeight(matchDateStr) {
    if (!matchDateStr) return 0.5;
    const matchDate = new Date(matchDateStr);
    const now = new Date();
    const diffDays = Math.max(0, Math.floor((now - matchDate) / (1000 * 60 * 60 * 24)));

    // Decay factor k = 0.0127 ensures weight is ~0.1 after 180 days (6 months)
    const k = 0.0127;
    const weight = Math.exp(-k * diffDays);

    return Math.max(0.1, weight);
}

function normalizeLega(lega) {
    if (!lega) return '';
    return lega.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Normalizza i nomi delle squadre rimuovendo accenti e caratteri speciali
 * per migliorare il matching tra CSV tip e risultati
 * Gestisce: europei, turchi, polacchi, e altri caratteri speciali
 * Es: "Rrogozhinë" → "Rrogozhine", "Ağrı" → "Agri", "Łódź" → "Lodz"
 */
function normalizeTeamName(name) {
    if (!name) return '';

    // Mappa di sostituzione per caratteri speciali comuni
    const charMap = {
        // Turco
        'ş': 's', 'Ş': 'S',
        'ı': 'i', 'İ': 'I',
        'ğ': 'g', 'Ğ': 'G',
        'ç': 'c', 'Ç': 'C',
        'ö': 'o', 'Ö': 'O',
        'ü': 'u', 'Ü': 'U',
        // Polacco
        'ł': 'l', 'Ł': 'L',
        'ź': 'z', 'Ź': 'Z',
        'ż': 'z', 'Ż': 'Z',
        'ą': 'a', 'Ą': 'A',
        'ę': 'e', 'Ę': 'E',
        'ć': 'c', 'Ć': 'C',
        'ń': 'n', 'Ń': 'N',
        'ó': 'o', 'Ó': 'O',
        'ś': 's', 'Ś': 'S',
        // Altri comuni
        'æ': 'ae', 'Æ': 'AE',
        'œ': 'oe', 'Œ': 'OE',
        'ß': 'ss',
        'ð': 'd', 'Ð': 'D',
        'þ': 'th', 'Þ': 'TH'
    };

    // Sostituisci caratteri speciali
    let normalized = name;
    for (const [char, replacement] of Object.entries(charMap)) {
        normalized = normalized.split(char).join(replacement);
    }

    // NFD decomposition per accenti standard (é, è, ë, etc.)
    normalized = normalized
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, ''); // Remove diacritics

    return normalized.trim();
}

/**
 * Calculates ELO ratings for all teams based on historical matches.
 * Processes matches chronologically to build dynamic strength ratings.
 * @param {Array} allMatchesHistory 
 * @returns {Map} teamName -> rating
 */
function calculateELORatings(allMatchesHistory) {
    if (!allMatchesHistory || allMatchesHistory.length === 0) return new Map();

    const ratings = new Map();
    const K = 32; // Standard sensitivity

    // Filter matches with results and sort chronologically
    const sortedMatches = allMatchesHistory
        .filter(m => m.risultato && m.risultato.includes('-') && m.partita && m.data)
        .sort((a, b) => new Date(a.data) - new Date(b.data));

    console.log(`[ELO Engine] Calculating ratings from ${sortedMatches.length} matches...`);

    sortedMatches.forEach(match => {
        const teams = match.partita.split(' - ');
        if (teams.length !== 2) return;

        const home = teams[0].trim();
        const away = teams[1].trim();

        const res = match.risultato.match(/(\d+)\s*-\s*(\d+)/);
        if (!res) return;

        const hg = parseInt(res[1]);
        const ag = parseInt(res[2]);

        const rH = ratings.get(home) || 1500;
        const rA = ratings.get(away) || 1500;

        // Expected outcome
        const expectedH = 1 / (1 + Math.pow(10, (rA - rH) / 400));
        const expectedA = 1 - expectedH;

        // Actual outcome
        let scoreH = 0.5;
        if (hg > ag) scoreH = 1;
        else if (ag > hg) scoreH = 0;
        const scoreA = 1 - scoreH;

        // Update ratings
        ratings.set(home, rH + K * (scoreH - expectedH));
        ratings.set(away, rA + K * (scoreA - expectedA));
    });

    console.log(`[ELO Engine] Ratings calculated for ${ratings.size} teams.`);
    return ratings;
}


// ==================== STATISTICAL ANALYSIS ====================

function analyzeLeaguePerformance(dbCompleto) {
    if (!dbCompleto || dbCompleto.length === 0) return {};

    const leagueStats = {};

    dbCompleto.forEach(match => {
        const lega = (match.lega || '').toLowerCase().trim();
        if (!lega) return;

        if (!leagueStats[lega]) {
            leagueStats[lega] = {
                totalMatches: 0,
                over25Count: 0,
                under25Count: 0,
                tips: {}
            };
        }

        leagueStats[lega].totalMatches++;

        const risultato = match.risultato || '';
        const golMatch = risultato.match(/(\d+)\s*-\s*(\d+)/);

        let golTotali = 0;
        if (golMatch) {
            const golCasa = parseInt(golMatch[1]);
            const golTrasferta = parseInt(golMatch[2]);
            golTotali = golCasa + golTrasferta;

            if (golTotali > 2.5) leagueStats[lega].over25Count++;
            else leagueStats[lega].under25Count++;
        }

        const tip = (match.tip || '').trim();
        if (tip) {
            if (!leagueStats[lega].tips[tip]) {
                leagueStats[lega].tips[tip] = { total: 0, success: 0 };
            }

            leagueStats[lega].tips[tip].total++;

            let success = false;
            if (golMatch && golTotali > 0) {
                if (tip.startsWith('+')) {
                    const soglia = parseFloat(tip.substring(1));
                    success = golTotali > soglia;
                } else if (tip.startsWith('-')) {
                    const soglia = parseFloat(tip.substring(1));
                    success = golTotali < soglia;
                }
            }

            if (success) leagueStats[lega].tips[tip].success++;
        }
    });

    Object.keys(leagueStats).forEach(lega => {
        const stats = leagueStats[lega];
        stats.over25Percentage = (stats.over25Count / stats.totalMatches * 100).toFixed(0);
        stats.under25Percentage = (stats.under25Count / stats.totalMatches * 100).toFixed(0);

        Object.keys(stats.tips).forEach(tip => {
            const tipStats = stats.tips[tip];
            tipStats.successRate = (tipStats.success / tipStats.total * 100).toFixed(0);
        });
    });

    return leagueStats;
}

function analyzeTeamStats(teamName, isHome, tip, dbCompleto, teamId = null) {
    if (!dbCompleto || dbCompleto.length === 0) {
        return { color: 'black', stats: '', count: 0, total: 0, percentage: 0, penalty: 0, scoreValue: 0, details: '', season: { avgScored: 1.5, avgConceded: 1.0 }, currForm: { avgScored: 1.5, avgConceded: 1.0, matchCount: 0 } };
    }

    const teamNorm = teamName.toLowerCase().trim();

    // v3.5.0 NUOVA LOGICA: Calcolo preciso score + penalità
    const isOverUnder = tip.startsWith('+') || tip.startsWith('-');

    let relevantMatches = [];

    // Filtra match ultimi 6 mesi con risultato
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);

    const matchFilter = row => {
        if (!row.risultato || row.risultato.trim() === '') return false;
        const matchDate = new Date(row.data || '2000-01-01');
        // If 'ALL' tip (for Monte Carlo), take all history, otherwise filter by date if needed
        if (tip !== 'ALL' && matchDate < sixMonthsAgo) return false;

        // 🏁 LOGICA IBRIDA "CERTIFICATA" (Swiss Watch)
        if (row.homeId || row.awayId) {
            // Se la riga storica ha ID, usiamo SOLO gli ID (Precisione Totale)
            if (!teamId) return false;
            const rowHId = String(row.homeId);
            const rowAId = String(row.awayId);
            const targetId = String(teamId);
            return (rowHId === targetId || rowAId === targetId);
        } else {
            // Se la riga storica NON ha ID (Dati vecchi/CSV), usiamo il Nome Esatto
            // NON usiamo fuzzy o "includes", solo uguaglianza perfetta
            const t1 = (row.partita || '').split(' - ')[0]?.toLowerCase().trim() || '';
            const t2 = (row.partita || '').split(' - ').slice(1).join(' - ')?.toLowerCase().trim() || '';
            return (t1 === teamNorm || t2 === teamNorm);
        }
    };

    const allTeamMatches = dbCompleto.filter(matchFilter);
    allTeamMatches.sort((a, b) => new Date(b.data || '2000-01-01') - new Date(a.data || '2000-01-01'));

    // Calc Goals Stats (Season Average with Time Decay)
    let weightedScored = 0;
    let weightedConceded = 0;
    let totalWeight = 0;
    let wins = 0, draws = 0, losses = 0;

    allTeamMatches.forEach(m => {
        // Determine if target team is home or away in THIS historical match
        let isTeamHome = false;
        if (teamId && (m.homeId || m.awayId)) {
            isTeamHome = String(m.homeId) === String(teamId);
        } else {
            const team1 = (m.partita || '').split(' - ')[0]?.toLowerCase().trim() || '';
            isTeamHome = team1 === teamNorm;
        }

        const res = m.risultato.match(/(\d+)-(\d+)/);
        if (res) {
            const hg = parseInt(res[1]);
            const ag = parseInt(res[2]);
            const weight = calculateTimeWeight(m.data);

            weightedScored += (isTeamHome ? hg : ag) * weight;
            weightedConceded += (isTeamHome ? ag : hg) * weight;
            totalWeight += weight;

            // Stats 1X2 per Draw Rate reale
            const teamG = isTeamHome ? hg : ag;
            const oppG = isTeamHome ? ag : hg;
            if (teamG > oppG) wins++;
            else if (teamG === oppG) draws++;
            else losses++;
        }
    });

    const seasonStats = {
        avgScored: totalWeight > 0 ? weightedScored / totalWeight : 1.3,
        avgConceded: totalWeight > 0 ? weightedConceded / totalWeight : 1.2,
        matches: allTeamMatches.length,
        totalWeight: totalWeight,
        wins: wins,
        draws: draws,
        losses: losses
    };

    if (tip === 'ALL') {
        // Return rich stats strictly for Monte Carlo
        // 🔥 FIX v4.4: Current Form (Last 5) NOW with Time Decay
        const recent = allTeamMatches.slice(0, 5);
        let weightedRecScored = 0, weightedRecConceded = 0;
        let totalFormWeight = 0;
        let outcomes = [];

        recent.forEach(m => {
            const team1 = (m.partita || '').split(' - ')[0]?.toLowerCase().trim() || '';
            const isTeamHome = team1 === teamNorm;
            const res = m.risultato.match(/(\d+)-(\d+)/);
            if (res) {
                const hg = parseInt(res[1]);
                const ag = parseInt(res[2]);
                const teamG = isTeamHome ? hg : ag;
                const oppG = isTeamHome ? ag : hg;

                // 🔥 Apply time decay to each form match
                const formWeight = calculateTimeWeight(m.data);
                weightedRecScored += teamG * formWeight;
                weightedRecConceded += oppG * formWeight;
                totalFormWeight += formWeight;

                // Capture outcome
                if (teamG > oppG) outcomes.push('W');
                else if (teamG === oppG) outcomes.push('D');
                else outcomes.push('L');
            }
        });

        const currForm = {
            avgScored: totalFormWeight > 0 ? weightedRecScored / totalFormWeight : seasonStats.avgScored,
            avgConceded: totalFormWeight > 0 ? weightedRecConceded / totalFormWeight : seasonStats.avgConceded,
            matchCount: recent.length,
            outcomes: outcomes // 🔥 ["W", "D", "L", "W", "W"]
        };

        return { season: seasonStats, currForm: currForm };
    }


    if (isOverUnder) {
        // OVER/UNDER: Tutti i match della squadra (ultimi 9)
        relevantMatches = allTeamMatches.slice(0, 9);
    } else {
        // 1X2/DC: Match casa o trasferta (ultimi 5)
        let locationMatches = allTeamMatches.filter(row => {
            const team1 = (row.partita || '').split(' - ')[0]?.toLowerCase().trim() || '';
            const team2 = (row.partita || '').split(' - ').slice(1).join(' - ')?.toLowerCase().trim() || '';
            if (isHome) return team1 === teamNorm;
            else return team2 === teamNorm;
        });
        relevantMatches = locationMatches.slice(0, 5); // Solo ultimi 5 per 1X2/DC
    }

    // Minimo match richiesti
    const minMatches = isOverUnder ? 5 : 3;
    if (relevantMatches.length < minMatches) {
        return {
            color: 'gray',
            stats: `(${relevantMatches.length})`,
            count: 0,
            total: relevantMatches.length,
            percentage: 0,
            penalty: 0,
            scoreValue: 0,
            details: `Dati insufficienti (min ${minMatches})`
        };
    }

    let successCount = 0;
    let penalty = 0;
    let detailsArray = [];

    relevantMatches.forEach(match => {
        const risultato = match.risultato || '';
        const golMatch = risultato.match(/(\d+)\s*-\s*(\d+)/);

        if (!golMatch) return;

        const golCasa = parseInt(golMatch[1]);
        const golTrasferta = parseInt(golMatch[2]);
        const golTotali = golCasa + golTrasferta;

        const team1 = (match.partita || '').split(' - ')[0]?.toLowerCase().trim() || '';
        const isTeamHome = team1 === teamNorm;

        let success = false;

        if (tip.startsWith('+')) {
            // OVER: conta gol totali > soglia
            const soglia = parseFloat(tip.substring(1));
            success = golTotali > soglia;

            // Penalità -5 per ogni 0-0
            if (golCasa === 0 && golTrasferta === 0) {
                penalty += 5;
                detailsArray.push(`0-0 (-5 pen)`);
            }

        } else if (tip.startsWith('-')) {
            // UNDER: conta gol totali < soglia
            const soglia = parseFloat(tip.substring(1));
            success = golTotali < soglia;

            // Penalità -5 per ogni 4+ gol (se Under 3.5)
            if (soglia <= 3.5 && golTotali >= 4) {
                penalty += 5;
                detailsArray.push(`${golCasa}-${golTrasferta} 4+ gol (-5 pen)`);
            }

        } else if (tip === '1') {
            // Casa vince (Tip 1)
            if (isHome && isTeamHome) {
                // Casa FAVORITA: conta vittorie
                success = golCasa > golTrasferta;
            } else if (!isHome && !isTeamHome) {
                // Trasferta SFAVORITA: conta sconfitte
                success = golTrasferta < golCasa;
            }

        } else if (tip === 'X') {
            // Pareggio (Tip X)
            // Entrambe contano pareggi
            success = golCasa === golTrasferta;

        } else if (tip === '2') {
            // Trasferta vince (Tip 2)
            if (!isHome && !isTeamHome) {
                // Trasferta FAVORITA: conta vittorie
                success = golTrasferta > golCasa;
            } else if (isHome && isTeamHome) {
                // Casa SFAVORITA: conta sconfitte
                success = golCasa < golTrasferta;
            }

        } else if (tip === '1X') {
            // Casa o Pareggio (Tip 1X)
            if (isHome && isTeamHome) {
                // Casa FAVORITA: conta non-sconfitte (V+P)
                success = golCasa >= golTrasferta;
            } else if (!isHome && !isTeamHome) {
                // Trasferta SFAVORITA: conta sconfitte + pareggi (NON vittorie)
                // Logica: vogliamo che NON vinca
                success = golTrasferta <= golCasa;
            }

        } else if (tip === '12') {
            // Casa o Trasferta (no pareggio) (Tip 12)
            // Entrambe contano SOLO vittorie
            const isVittoria = (isHome && isTeamHome && golCasa > golTrasferta) ||
                (!isHome && !isTeamHome && golTrasferta > golCasa);
            success = isVittoria;

            // Penalità -5 per ogni pareggio
            if (golCasa === golTrasferta) {
                penalty += 5;
                detailsArray.push(`${golCasa}-${golTrasferta} pareggio (-5 pen)`);
            }

        } else if (tip === 'X2') {
            // Pareggio o Trasferta (Tip X2)
            if (!isHome && !isTeamHome) {
                // Trasferta FAVORITA: conta non-sconfitte (V+P)
                success = golTrasferta >= golCasa;
            } else if (isHome && isTeamHome) {
                // Casa SFAVORITA: conta sconfitte + pareggi (NON vittorie)
                // Logica: vogliamo che NON vinca
                success = golCasa <= golTrasferta;
            }
        }

        if (success) successCount++;
    });

    // Calcola percentuale ESATTA
    const percentage = relevantMatches.length > 0 ? (successCount / relevantMatches.length) * 100 : 0;

    // Score value = percentuale - penalità
    const scoreValue = Math.max(0, Math.round(percentage - penalty));

    // Colore basato su score finale
    let color = 'black';
    if (relevantMatches.length >= minMatches) {
        if (scoreValue >= 70) color = 'green';
        else if (scoreValue >= 50) color = 'yellow';
        else color = 'red';
    }

    // Details string
    const details = detailsArray.length > 0 ? detailsArray.join(', ') : '';

    return {
        color: color,
        stats: `(${successCount}/${relevantMatches.length})`,
        count: successCount,
        total: relevantMatches.length,
        percentage: Math.round(percentage),
        penalty: penalty,
        scoreValue: scoreValue,
        details: details
    };
}

// Analizza tasso pareggi storico per una squadra
function analyzeDrawRate(teamName, allMatches, teamId = null) {
    if (!teamName || !allMatches) return { rate: 0, total: 0, draws: 0 };

    const teamLower = teamName.toLowerCase().trim();

    // Trova partite storiche della squadra (ultimi 30 match con risultato)
    const matchesSquadra = allMatches.filter(m => {
        if (!m.risultato || m.risultato.trim() === '') return false;

        // 🏁 LOGICA IBRIDA "CERTIFICATA"
        if (m.homeId || m.awayId) {
            if (!teamId) return false;
            const targetId = String(teamId);
            return (String(m.homeId) === targetId || String(m.awayId) === targetId);
        } else {
            // Fallback su nome ESATTO per storia vecchia (senza ID)
            const partitaLower = (m.partita || '').toLowerCase();
            const [t1, t2] = partitaLower.split(' - ').map(t => t.trim());
            return (t1 === teamLower || t2 === teamLower);
        }
    }).slice(0, 30); // Max 30 match

    if (matchesSquadra.length === 0) return { rate: 0, total: 0, draws: 0 };

    // Conta pareggi
    const pareggi = matchesSquadra.filter(m => {
        const ris = m.risultato.split('-').map(n => parseInt(n.trim()));
        if (ris.length !== 2 || isNaN(ris[0]) || isNaN(ris[1])) return false;
        return ris[0] === ris[1]; // Es. "1-1", "0-0", "2-2"
    });

    const rate = (pareggi.length / matchesSquadra.length) * 100;

    return {
        rate: Math.round(rate),
        total: matchesSquadra.length,
        draws: pareggi.length
    };
}


// ==================== SCORING ALGORITHMS ====================

function calculateScore05HT(partita, dbCompleto) {
    let score = 0;

    // Estrai HT prob
    let htProb = 0;
    if (partita.info_ht && partita.info_ht.trim() !== '') {
        const htMatch = partita.info_ht.match(/(\d+)%/);
        if (htMatch) htProb = parseInt(htMatch[1]);
    }

    // PESO 1: HT Probability (50% del score)
    if (htProb >= 85) score += 50;
    else if (htProb >= 80) score += 45;
    else if (htProb >= 75) score += 40;
    else if (htProb >= 70) score += 35;
    else if (htProb >= 65) score += 25;

    // PESO 2: Prolificità squadre Over 1.5 (30% del score)
    const teams = partita.partita.split(' - ');
    if (teams.length === 2 && dbCompleto && dbCompleto.length > 0) {
        const teamHome = teams[0].trim();
        const teamAway = teams[1].trim();

        const homeStats = analyzeTeamStats(teamHome, true, '+1.5', dbCompleto, partita.homeId);
        const awayStats = analyzeTeamStats(teamAway, false, '+1.5', dbCompleto, partita.awayId);

        if (homeStats.total >= 5 && awayStats.total >= 5) {
            const homePerc = (homeStats.count / homeStats.total) * 100;
            const awayPerc = (awayStats.count / awayStats.total) * 100;
            const avgPerc = (homePerc + awayPerc) / 2;

            if (avgPerc >= 75) score += 30;
            else if (avgPerc >= 65) score += 25;
            else if (avgPerc >= 55) score += 20;
            else if (avgPerc >= 45) score += 15;
            else score += 10;
        }
    }

    // PESO 3: Orario favorevole (20% del score - bonus)
    if (partita.time) {
        const [hours] = partita.time.split(':').map(Number);
        if (hours >= 17 && hours <= 22) score += 20; // Orario prime time
        else if (hours >= 14 && hours <= 23) score += 10; // Orario buono
    }

    return {
        teamBonus: score,
        totalScore: Math.min(100, score),
        quotaValid: true,
    };
}

/**
 * Crea una strategia Lay The Draw (LTD) professionale
 * @param {object} match - Dati della partita
 * @param {number} avgDrawRate - Tasso pareggi medio (storico)
 * @param {object} homeDrawRate - Dettagli pareggi casa
 * @param {object} awayDrawRate - Dettagli pareggi trasferta
 * @param {boolean} isConvergent - Se AI e Storico concordano (Diamond Signal)
 */
function createLayTheDrawStrategy(match, avgDrawRate, homeDrawRate, awayDrawRate, isConvergent = false) {
    // ==================== LIQUIDITY CHECK ====================
    // Liquidity check removed as per user request
    // =========================================================

    const prob = match.probabilita;
    const tip = match.tip;

    // Range ingresso: 2.50 - 4.50 (allargato per maggiore copertura)
    const entryRange = ['2.50', '4.50'];

    // ANALISI DETTAGLIATA PER REASONING
    let reasoning = [];

    // Base: segno probabile
    const tipLabel = tip === '1' ? `vittoria ${match.partita.split(' - ')[0]}` :
        tip === '2' ? `vittoria ${match.partita.split(' - ')[1]}` :
            'segno (no pareggio)';

    if (isConvergent) {
        reasoning.push(`🔥 <strong>DIAMOND SIGNAL</strong>: Convergenza AI + Storico Squadre`);
    } else {
        reasoning.push(`Alta probabilità ${tipLabel} (${prob}%)`);
    }

    // Analisi dettagliata pareggi
    if (avgDrawRate <= 15) {
        reasoning.push(`squadre che pareggiano raramente (solo ${avgDrawRate.toFixed(0)}% dei match)`);
    } else if (avgDrawRate <= 22) {
        reasoning.push(`basso tasso pareggi storico (${avgDrawRate.toFixed(0)}%)`);
    }

    // Info lega se rilevante
    const legaNorm = normalizeLega(match.lega).toLowerCase();
    if (legaNorm.includes('premier') || legaNorm.includes('bundesliga') || legaNorm.includes('serie a')) {
        reasoning.push('top campionato con pochi pareggi tattici');
    }

    return {
        ...match,
        _originalTip: match.tip,
        _originalQuota: match.quota,
        strategy: 'LAY_THE_DRAW',
        tradingInstruction: {
            action: 'Lay The Draw',
            entry: {
                range: [parseFloat(entryRange[0]), parseFloat(entryRange[1])],
                timing: 'Primi 10-15 min'
            },
            exit: {
                target: 1.60,
                timing: 'Dopo 1° gol (Cash-out)'
            },
            stopLoss: {
                trigger: 2.00,
                timing: 'Se 0-0 al 65-70 min'
            }
        },
        // CONFIDENCE basato su probabilità reale per ranking equilibrato
        confidence: Math.min(95, (match.probabilita || 70) + (isConvergent ? 10 : 5)),
        reasoning: reasoning.join(' + '),
        badge: {
            text: 'Trading Lay The Draw',
            color: 'bg-blue-100 text-blue-700 border-blue-300'
        }
    };
}

function calculateScore(partita, legheSet, tipsSet, leaguePerformance = {}, dbCompleto = null) {
    // v3.5.0 - SCORE DA SCOREVALUE: usa direttamente score calcolato da analyzeTeamStats

    let score = 0;
    const tipNorm = (partita.tip || '').trim().toUpperCase();
    const mercato = (partita.mercato || '').toLowerCase().trim();

    // Se non ho DB, score 0
    if (!dbCompleto || dbCompleto.length === 0 || !partita.partita) {
        return {
            teamBonus: 0,
            totalScore: 0,
            quotaValid: true
        };
    }

    const teams = partita.partita.split(' - ');
    if (teams.length !== 2) {
        return {
            teamBonus: 0,
            totalScore: 0,
            quotaValid: true
        };
    }

    const teamHome = teams[0].trim();
    const teamAway = teams[1].trim();

    // Analizza statistiche squadre
    const homeStats = analyzeTeamStats(teamHome, true, tipNorm, dbCompleto, partita.homeId);
    const awayStats = analyzeTeamStats(teamAway, false, tipNorm, dbCompleto, partita.awayId);

    // ========== OVER/UNDER (+1.5, +2.5, -2.5, etc) ==========
    if (tipNorm.startsWith('+') || tipNorm.startsWith('-')) {
        // Usa scoreValue DIRETTO da analyzeTeamStats
        // Media dei due score
        const avgScore = (homeStats.scoreValue + awayStats.scoreValue) / 2;
        score = Math.round(avgScore);

        // BOOST HT se disponibile (solo per OVER)
        if (tipNorm.startsWith('+') && partita.info_ht && partita.info_ht.trim() !== '') {
            const probMatch = partita.info_ht.match(/(\d+)%/);
            if (probMatch) {
                const htProb = parseInt(probMatch[1]);
                if (htProb >= 75) score += 15;
                else if (htProb >= 65) score += 10;
                else if (htProb >= 55) score += 5;
            }
        }

        // PENALITÀ HT alto (solo per UNDER)
        if (tipNorm.startsWith('-') && partita.info_ht && partita.info_ht.trim() !== '') {
            const probMatch = partita.info_ht.match(/(\d+)%/);
            if (probMatch) {
                const htProb = parseInt(probMatch[1]);
                if (htProb >= 75) score -= 15;
                else if (htProb >= 65) score -= 10;
            }
        }

        return {
            teamBonus: score,
            totalScore: Math.max(0, Math.min(100, score)),
            quotaValid: true
        };
    }

    // ========== 1X2 / Doppia Chance ==========
    // Usa scoreValue DIRETTO da analyzeTeamStats
    const avgScore = (homeStats.scoreValue + awayStats.scoreValue) / 2;
    score = Math.round(avgScore);

    return {
        teamBonus: score,
        totalScore: Math.max(0, Math.min(100, score)),
        quotaValid: true
    };
}


// ==================== TRADING STRATEGIES ====================

// Estrai probabilità HT da info_ht
function extractHTProb(info_ht) {
    if (!info_ht || info_ht.trim() === '') return 0;
    const htMatch = info_ht.match(/(\d+)%/);
    return htMatch ? parseInt(htMatch[1]) : 0;
}

// ═══════════════════════════════════════════════════════════════════════
// 🧠 TRADING STRATEGIES 3.0
// ═══════════════════════════════════════════════════════════════════════

function createBackOver25Strategy(match, htProb, allMatches) {
    // La liquidità è già filtrata a monte in admin.html dalla "Lista Sacra"

    const prob = match.probabilita;
    const quota = match.quota;

    // Stima quota Over 2.5 con Poisson semplificato
    const probOver25Estimated = (prob >= 80) ? prob * 0.70 : prob * 0.65;
    const quotaOver25Suggested = 1 / (probOver25Estimated / 100);

    // Range trading: ±12% dalla quota centrale
    const entryRange = [
        (quotaOver25Suggested * 0.88).toFixed(2),
        (quotaOver25Suggested * 1.12).toFixed(2)
    ];

    // ANALISI DETTAGLIATA PER REASONING
    const teams = match.partita.split(' - ');
    let reasoning = [];

    // Base: probabilità originale
    if (match.tip === '+1.5') {
        reasoning.push(`Over 1.5 molto probabile (${prob}%)`);
    } else {
        reasoning.push(`Over 2.5 probabile (${prob}%)`);
    }

    // Analisi HT se disponibile
    if (htProb >= 85) {
        reasoning.push(`gol quasi certo nel 1°T (${htProb}%) - OTTIMO per trading live`);
    } else if (htProb >= 75) {
        reasoning.push(`alta probabilità gol 1°T (${htProb}%)`);
    } else if (htProb >= 65) {
        reasoning.push(`buona prob gol 1°T (${htProb}%)`);
    }

    return {
        ...match,
        _originalTip: match.tip || 'N/A',
        _originalQuota: match.quota || 'N/A',
        strategy: 'BACK_OVER_25',
        tradingInstruction: {
            action: 'Back Over 2.5',
            entryRange: ['@1.80-2.30 (Live)'],
            exitTarget: '60 min / 1 Gol',
            timing: 'Pre-match / Live',
            entry: {
                range: [1.80, 2.30],
                timing: 'Primi 15-20 min'
            },
            exit: {
                target: 1.15,
                timing: 'Dopo 1° gol (Cash-out)'
            },
            stopLoss: {
                trigger: 1.20,
                timing: 'Se 0-0 al 70 min'
            }
        },
        confidence: forcedConfidence || Math.min(95, Math.max(prob, match.score || 0)),
        reasoning: reasoning.length > 0 ? reasoning.join(' + ') : `Analisi Over 2.5 (${prob}%)`,
        badge: {
            text: 'Trading Back Over 2.5',
            color: 'bg-indigo-600 text-white border-indigo-700 shadow-sm'
        }
    };
}

// Helper: Crea strategia HT SNIPER (0.5 HT Live)
function createHTSniperStrategy(match, htProb, forcedConfidence = null) {
    return {
        ...match,
        _originalTip: match.tip || 'N/A',
        _originalQuota: match.quota || 'N/A',
        strategy: 'HT_SNIPER',
        tradingInstruction: {
            action: 'Back Over 0.5 HT',
            entry: {
                range: [1.50, 2.00],
                timing: 'Minuto 15-20'
            },
            exit: {
                target: 1.10,
                timing: 'Dopo gol 1°T (Cash-out)'
            },
            stopLoss: {
                trigger: 1.01,
                timing: 'Fine 1° Tempo'
            }
        },
        confidence: forcedConfidence || Math.min(95, htProb),
        reasoning: `ALTA PROBABILITÀ GOL 1°T (${htProb}%). Se 0-0 al minuto 20, la quota diventa di estremo valore.`,
        badge: {
            text: '🎯 HT SNIPER',
            color: 'bg-red-600 text-white border-red-700 shadow-sm animate-pulse'
        }
    };
}

// Helper: Crea strategia SECOND HALF SURGE (0.5 ST)
function createSecondHalfSurgeStrategy(match, allMatches, forcedConfidence = null) {
    const prob = match.magicStats?.prob || match.probabilita || 65;
    return {
        ...match,
        _originalTip: match.tip || 'N/A',
        _originalQuota: match.quota || 'N/A',
        strategy: 'SECOND_HALF_SURGE',
        tradingInstruction: {
            action: 'Back Over 0.5 ST',
            entry: {
                range: [1.60, 2.00],
                timing: 'Minuto 55-65'
            },
            exit: {
                target: 1.10,
                timing: 'Dopo gol 2°T (Cash-out)'
            },
            stopLoss: {
                trigger: 1.01,
                timing: 'Minuto 85'
            }
        },
        confidence: forcedConfidence || Math.min(95, prob),
        reasoning: `Match ad alta intensità statistica. Ottimo per sfruttare il calo delle quote nel secondo tempo tra il minuto 60 e 80.`,
        badge: {
            text: '🔥 SEC HALF SURGE',
            color: 'bg-orange-600 text-white border-orange-700 shadow-sm'
        }
    };
}

// Helper: Crea strategia LAY THE DRAW
function createLayTheDrawStrategy(match, avgHistDraw, homeDrawRate, awayDrawRate, isHighProb = false, forcedConfidence = null) {
    const mcDrawProb = match.magicStats?.drawProb || match.magicStats?.draw || 30;
    return {
        ...match,
        _originalTip: match.tip || 'N/A',
        _originalQuota: match.quota || 'N/A',
        strategy: 'LAY_THE_DRAW',
        tradingInstruction: {
            action: 'Lay The Draw',
            entry: {
                range: [3.40, 4.50],
                timing: 'Live @ 15-20 min'
            },
            exit: {
                target: 2.00,
                timing: 'Dopo gol favorito'
            },
            stopLoss: {
                trigger: 2.00,
                timing: 'Se 0-0 al 70 min'
            }
        },
        confidence: forcedConfidence || Math.min(95, 100 - mcDrawProb),
        reasoning: `Alta probabilità segno (no pareggio) (${Math.round(100 - mcDrawProb)}%) + basso tasso pareggi storico (${avgHistDraw.toFixed(0)}%) + top campionato con pochi pareggi.`,
        badge: {
            text: '🎲 LAY THE DRAW',
            color: 'bg-blue-600 text-white border-blue-700 shadow-sm'
        }
    };
}

function createBackOver25Strategy(match, htProb, allMatches, forcedConfidence = null) {
    const magicData = match.magicStats;
    const prob = magicData?.over25 || magicData?.over25Prob || 0;

    const reasoning = [];
    if (prob >= 60) reasoning.push(`Over 2.5 molto probabile (${prob}%)`);
    if (htProb >= 70) reasoning.push(`alta probabilità gol 1°T (${htProb}%)`);

    const teams = match.partita.split(' - ');
    if (teams.length === 2) {
        const league = window.normalizeLega(match.lega).toLowerCase();
        const highGoalLeagues = ['premier', 'eredivisie', 'bundesliga', 'championship', 'belgio', 'islanda'];
        if (highGoalLeagues.some(l => league.includes(l))) {
            reasoning.push('campionato ad alto tasso gol');
        }
    }

    return {
        ...match,
        _originalTip: match.tip || 'N/A',
        _originalQuota: match.quota || 'N/A',
        strategy: 'BACK_OVER_25',
        tradingInstruction: {
            action: 'Back Over 2.5',
            entryRange: ['@1.80-2.30 (Live)'],
            exitTarget: '60 min / 1 Gol',
            timing: 'Pre-match / Live',
            entry: {
                range: [1.80, 2.30],
                timing: 'Primi 15-20 min'
            },
            exit: {
                target: 1.15,
                timing: 'Dopo 1° gol (Cash-out)'
            },
            stopLoss: {
                trigger: 1.20,
                timing: 'Se 0-0 al 70 min'
            }
        },
        confidence: forcedConfidence || Math.min(95, Math.max(prob, match.score || 0)),
        reasoning: reasoning.length > 0 ? reasoning.join(' + ') : `Analisi Over 2.5 (${prob}%)`,
        badge: {
            text: 'Trading Back Over 2.5',
            color: 'bg-indigo-600 text-white border-indigo-700 shadow-sm'
        }
    };
}

// Helper: Crea strategia UNDER 3.5 TRADING (Scalping)
function createUnder35TradingStrategy(match, forcedConfidence = null) {
    return {
        ...match,
        _originalTip: match.tip || 'N/A',
        _originalQuota: match.quota || 'N/A',
        strategy: 'UNDER_35_SCALPING',
        tradingInstruction: {
            action: 'Under 3.5 Scalping',
            entry: {
                range: [1.30, 1.60],
                timing: 'Live (Primi 5-10 min)'
            },
            exit: {
                target: 1.15,
                timing: 'Dopo 15-20 min senza gol'
            },
            stopLoss: {
                trigger: 2.50,
                timing: 'Dopo il 1° gol subito'
            }
        },
        confidence: forcedConfidence || Math.min(95, match.probabilita || 70),
        reasoning: `Sistema difensivo solido rilevato. Scalping Under 3.5 con uscita programmata o stop loss a fine primo tempo.`,
        badge: {
            text: '🛡️ UNDER SCALPING',
            color: 'bg-emerald-600 text-white border-emerald-700 shadow-sm'
        }
    };
}

// Funzione principale: Trasforma partita in strategia trading
// TRADING 3.0: Puro calcolo statistico + VALUE EDGE con odds Betfair
// @param {object} match - Match data including betfairOdds if available
// @param {array} allMatches - Historical matches for stats calculation
function transformToTradingStrategy(match, allMatches) {
    const prob = match.probabilita || 0;
    const htProb = extractHTProb(match.info_ht);
    const magicData = match.magicStats;
    const score = magicData?.score || match.score || 0;

    // Extract Bookmaker odds from match (Bet365 via API-Football)
    const bookmakerOdds = {
        home: parseFloat(match.quota1) || null,
        draw: parseFloat(match.quotaX) || null,
        away: parseFloat(match.quota2) || null,
        dc1X: parseFloat(match.bookmaker1X) || null,
        dcX2: parseFloat(match.bookmakerX2) || null,
        dc12: parseFloat(match.bookmaker12) || null,
        over15: parseFloat(match.bookmakerOver15) || null,
        under35: parseFloat(match.bookmakerUnder35) || null,
        gg: parseFloat(match.bookmakerGG) || null,
        ng: parseFloat(match.bookmakerNG) || null
    };

    // ════════════════════════════════════════════════════════════════
    // TRADING 3.0 + VALUE EDGE: Calcola strategie CON verifica valore
    // PRIORITÀ: OVER 2.5 > SECOND HALF > LTD > UNDER 3.5 > HT SNIPER (fallback)
    // ════════════════════════════════════════════════════════════════

    // DEBUG: Log magicData and Betfair odds
    if (!magicData || Object.keys(magicData).length === 0) {
        console.warn(`[Trading 3.0] ⚠️ magicData ASSENTE per ${match.partita}`);
    }

    // 🔍 DEBUG: Mostra valori usati per la selezione + ODDS BETFAIR
    console.log(`[Trading 3.0 DEBUG] === ${match.partita} ===`);
    console.log(`  📊 score: ${score}, prob: ${prob}, htProb: ${htProb}`);
    console.log(`  🎲 magicData:`, magicData ? JSON.stringify({
        over25Prob: magicData.over25Prob,
        htGoalProb: magicData.htGoalProb,
        drawProb: magicData.drawProb
    }) : 'NULL');
    console.log(`  💰 Bookmaker Odds (Bet365):`, JSON.stringify(bookmakerOdds));

    // 🔍 ANALISI ELITE (ELO & MOTIVAZIONE)
    const eloDiff = magicData?.eloDiff || 0;
    const badges = magicData?.motivationBadges || [];
    const hasMotivation = badges.length > 0;
    const isDirectClash = badges.includes('⚔️ Scontro Diretto');
    const isTitleRace = badges.includes('🏆 Corsa Titolo');
    const isRelegationFight = badges.includes('🆘 Lotta Salvezza');

    const strategies = [];

    // ─── STRATEGIA 1: BACK OVER 2.5 ───
    const over25Prob = magicData?.over25 ? magicData.over25 : (magicData?.over25Prob || 0);
    const cfgOver25 = STRATEGY_CONFIG.TRADING.STRATEGIES.BACK_OVER_25;

    // ⚠️ Over 2.5 rimosso (mercato troppo improbabile)
    // Manteniamo il calcolo per Trading 3.0 legacy ma con quote bookmaker generiche
    const over25Edge = { valueEdge: 0, hasProfitableEdge: true };

    let over25Confidence = Math.round(over25Prob + (over25Prob >= 50 ? 15 : 10));

    if (hasMotivation) over25Confidence += 5;
    if (Math.abs(eloDiff) > 200) over25Confidence += 5;

    // RELAX ELITE: Se abbiamo motivazione forte o ELO gap, accettiamo anche edge marginali (fino a -5%)
    const minEdgeAllowed = (hasMotivation || Math.abs(eloDiff) > 200) ? -5 : 0;
    const over25Passes = over25Prob >= (cfgOver25.minProb || 40) &&
        over25Confidence >= (cfgOver25.minConfidence || 50) &&
        (over25Edge.valueEdge >= minEdgeAllowed);

    if (over25Passes) {
        // PRIORITÀ ELITE: +15 Bonus per strategie Professionali (v2)
        const finalConfidence = Math.min(98, over25Confidence + 15);
        strategies.push({
            type: 'BACK_OVER_25',
            confidence: finalConfidence,
            data: { over25Prob, prob, valueEdge: over25Edge.valueEdge, badges, eloDiff },
            create: () => {
                const s = createBackOver25Strategy(match, htProb, allMatches, finalConfidence);
                s.reasoning = `Analisi Magia AI (${over25Prob}%). ` +
                    (hasMotivation ? `Focus su motivazione speciale (${badges.join(', ')}). ` : '') +
                    (Math.abs(eloDiff) > 150 ? `Gap tecnico ELO significativo (${eloDiff}).` : '');
                return s;
            }
        });
    }

    // ─── STRATEGIA 5: HT SNIPER (Elite Refined) ───
    const htGoalProb = magicData?.htGoalProb || htProb;
    // REQUISITI ELITE: Probabilità più alta (72%) OPPURE 65% + Motivazione
    const htSniperPasses = (htProb >= 72 || (htProb >= 65 && hasMotivation));

    const htSniperCandidate = htSniperPasses ? {
        type: 'HT_SNIPER',
        // SUPPRESSION ELITE v2: -25 Penalità per HT Sniper if professional alternative exists
        confidence: Math.min(95, Math.round(Math.max(htProb, htGoalProb)) + (isTitleRace ? 5 : 0)) - 25,
        data: { htProb, htGoalProb, badges },
        create: (overrideConf) => {
            const finalConf = overrideConf || (Math.min(95, Math.round(Math.max(htProb, htGoalProb)) + (isTitleRace ? 5 : 0)) - 25);
            const s = createHTSniperStrategy(match, htProb, finalConf);
            s.reasoning = `Focus Over 0.5 HT (${htProb}%). ` +
                (hasMotivation ? `Spinta da obiettivi classifica: ${badges.join(', ')}.` : 'Match con alta intensità iniziale prevista.');
            return s;
        }
    } : null;

    // ─── STRATEGIA 3: LAY THE DRAW (REVISED WITH BETFAIR ODDS) ───
    // LTD funziona quando:
    // 1. AI pensa che il pareggio sia possibile ma NON probabile (25-38%)
    // 2. Betfair quota il pareggio ALTO (@3.40+) = c'è margine per il lay
    const teams = match.partita.split(' - ');
    if (teams.length === 2) {
        const homeDrawRate = analyzeDrawRate(teams[0].trim(), allMatches, match.teamIdHome);
        const awayDrawRate = analyzeDrawRate(teams[1].trim(), allMatches, match.teamIdAway);
        const avgHistDraw = (homeDrawRate.rate + awayDrawRate.rate) / 2;
        const mcDrawProb = magicData?.drawProb || magicData?.draw || 30;
        const drawOdds = bookmakerOdds.draw || 3.50;

        // NUOVA LOGICA ELITE: LTD è meno affidabile negli scontri diretti "biscotto"
        const isBiscottoRisk = isDirectClash && mcDrawProb > 33;
        const ltdDrawProbOk = mcDrawProb >= 22 && mcDrawProb <= 38 && !isBiscottoRisk;
        const ltdOddsOk = drawOdds >= 3.40;
        const ltdHistOk = avgHistDraw < 35;
        const ltdPasses = ltdDrawProbOk && ltdOddsOk && ltdHistOk;

        if (ltdPasses) {
            const oddsBonus = Math.min(15, (drawOdds - 3.0) * 5);
            // PRIORITÀ ELITE: +15 Bonus per strategie Professionali (v2)
            let finalConfidence = Math.round(100 - mcDrawProb + oddsBonus) + 15;
            if (isRelegationFight) finalConfidence += 5; // Più tensione = meno pareggi

            strategies.push({
                type: 'LAY_THE_DRAW',
                confidence: Math.min(95, finalConfidence),
                data: { mcDrawProb, avgHistDraw, homeDrawRate, awayDrawRate, drawOdds, badges },
                create: () => {
                    const s = createLayTheDrawStrategy(match, avgHistDraw, homeDrawRate, awayDrawRate, mcDrawProb < 28 && avgHistDraw < 28, Math.min(95, finalConfidence));
                    s.reasoning = `Analisi LTD (Pareggio AI: ${Math.round(mcDrawProb)}%). ` +
                        (isRelegationFight ? "Tensione salvezza riduce rischio pareggio stallo." : "Margine di valore su odds Betfair.");
                    return s;
                }
            });
        }
    }

    // ─── STRATEGIA 2: SECOND HALF SURGE (O0.5 2T) ───
    if (prob >= 65 && prob < 90) {
        let finalConfidence = Math.round(prob * 0.8 + 15) + 10; // +10 Bonus Professionale (v2)
        if (hasMotivation) finalConfidence += 5;

        strategies.push({
            type: 'SECOND_HALF_SURGE',
            confidence: Math.min(95, finalConfidence),
            data: { prob, badges },
            create: () => {
                const s = createSecondHalfSurgeStrategy(match, allMatches, Math.min(95, finalConfidence));
                s.reasoning = `Prevista spinta nel 2° tempo (${prob}%). ` +
                    (hasMotivation ? `Obiettivi classifica (${badges.join(', ')}) spingono alla vittoria.` : "");
                return s;
            }
        });
    }

    // ─── STRATEGIA 6 (NUOVA): ELITE SURGE (High-Gap Trading) ───
    if (Math.abs(eloDiff) > 250) {
        const favoriteBadge = eloDiff > 0 ? "Home Favorite" : "Away Favorite";
        strategies.push({
            type: 'ELITE_SURGE',
            confidence: Math.min(97, 85 + (Math.abs(eloDiff) / 50)),
            data: { eloDiff, badges },
            create: (overrideConf) => ({
                strategy: 'ELITE_SURGE',
                label: 'ELITE SURGE (BACK)',
                action: eloDiff > 0 ? 'BACK 1' : 'BACK 2',
                entryRange: ['Live @ 1.80+'],
                exitTarget: '60 min / 1 Gol',
                timing: 'In-Play (0-15 min)',
                confidence: overrideConf || Math.min(97, 85 + (Math.abs(eloDiff) / 50)),
                reasoning: `Gap tecnico ELO massivo (${Math.round(Math.abs(eloDiff))}). Attesa dominanza del favorito.`
            })
        });
    }

    // ─── STRATEGIA 4: UNDER 3.5 SCALPING ───
    const under35Prob = 100 - (magicData?.over25 ? magicData.over25 : (magicData?.over25Prob || 50)) + 15;
    if (under35Prob >= 60 && !hasMotivation) { // Meno under se c'è motivazione (partita aperta)
        const confidence = Math.round(under35Prob * 0.7 + 15);
        strategies.push({
            type: 'UNDER_35_SCALPING',
            confidence: Math.min(90, confidence),
            data: { under35Prob },
            create: (overrideConf) => {
                const finalConf = overrideConf || Math.min(90, Math.round(under35Prob * 0.7 + 15));
                const s = createUnder35TradingStrategy(match, finalConf);
                s.reasoning = `Match a basso ritmo previsto (${Math.round(under35Prob)}%). Assenza di spinte motivazionali forti.`;
                return s;
            }
        });
    }

    // ════════════════════════════════════════════════════════════════
    // SELEZIONE: Scegli la strategia con CONFIDENCE più alta
    // HT SNIPER solo come FALLBACK se non ci sono altre strategie
    // ════════════════════════════════════════════════════════════════

    // ELITE DIVERSITY: Se abbiamo già una strategia professionale solida (>65%), 
    // l'HT Sniper non deve nemmeno essere proposto per evitare "rumore" e over-selection.
    const hasSolidProfessional = strategies.some(s =>
        ['BACK_OVER_25', 'LAY_THE_DRAW', 'ELITE_SURGE', 'SECOND_HALF_SURGE'].includes(s.type) && s.confidence > 65
    );

    if (strategies.length === 0 && htSniperCandidate) {
        strategies.push(htSniperCandidate);
    } else if (strategies.length > 0 && htSniperCandidate && !hasSolidProfessional) {
        // Aggiungiamo HT Sniper solo se NON abbiamo già una professionale solida
        strategies.push(htSniperCandidate);
    }

    if (strategies.length === 0) {
        console.log(`[Trading 3.0] ❌ ${match.partita}: Nessuna strategia qualificata`);
        return null;
    }

    // Ordina per confidence decrescente con Professional First Rule
    strategies.sort((a, b) => {
        const isAProf = ['BACK_OVER_25', 'LAY_THE_DRAW', 'ELITE_SURGE', 'SECOND_HALF_SURGE'].includes(a.type);
        const isBProf = ['BACK_OVER_25', 'LAY_THE_DRAW', 'ELITE_SURGE', 'SECOND_HALF_SURGE'].includes(b.type);

        // Professional First: Se una professionale ha confidende > 70%, vince su HT Sniper non-eccelso
        if (isAProf && !isBProf && a.confidence >= 70 && b.confidence < 90) return -1;
        if (!isAProf && isBProf && b.confidence >= 70 && a.confidence < 90) return 1;

        return b.confidence - a.confidence;
    });

    const bestStrategy = strategies[0];

    // 🔍 DEBUG ELITE: Log finale per l'utente sui pesi del ranking
    console.log(`[Elite Debug] Rank Finale per ${match.partita}:`);
    strategies.forEach((s, idx) => {
        const isProf = ['BACK_OVER_25', 'LAY_THE_DRAW', 'ELITE_SURGE', 'SECOND_HALF_SURGE'].includes(s.type);
        console.log(`  ${idx + 1}. ${s.type} | Conf: ${s.confidence}% | Professional: ${isProf}`);
    });
    console.log(`  🏆 Vincitore: ${bestStrategy.type} (${bestStrategy.confidence}%)`);

    // Crea e ritorna la strategia vincente - PASSA LA CONFIDENCE PESATA
    const result = bestStrategy.create(bestStrategy.confidence);
    if (result) {
        // LIMITA A MAX 3 STRATEGIE per evitare "sempre le solite 2"
        const topStrategies = strategies.slice(0, 3);

        result._allPossibleStrategies = topStrategies.map(s => {
            const stratObj = s.create();
            // Merge metadata with the full strategy object
            return {
                ...stratObj, // Include instructions, badges, etc.
                type: s.type,
                confidence: s.confidence,
                label: stratObj?.badge?.text || stratObj?.tradingInstruction?.action || s.type,
                reasoning: stratObj?.reasoning || ''
            };
        });
        return result;
    }
    return null;
}

/**
 * NEW: Calculate ALL qualified strategies for a match (not just the best one)
 */
function calculateAllTradingStrategies(match, allMatches) {
    const prob = match.probabilita || 0;
    const htProb = extractHTProb(match.info_ht);
    const magicData = match.magicStats;
    const score = magicData?.score || match.score || 0;
    const teams = (match.partita || "").split(' - ');

    const qualified = [];

    // ANALISI ELITE
    const badges = magicData?.motivationBadges || [];
    const hasMotivation = badges.length > 0;
    const isDirectClash = badges.includes('⚔️ Scontro Diretto');
    const isTitleRace = badges.includes('🏆 Corsa Titolo');
    const isRelegationFight = badges.includes('🆘 Lotta Salvezza');

    // 1. BACK OVER 2.5
    const over25Prob = magicData?.over25 ? magicData.over25 : (magicData?.over25Prob || 0);
    if (over25Prob >= 45 || score >= 60) {
        const conf = Math.min(98, Math.round((over25Prob * 0.6) + (score * 0.4)) + 15 + (hasMotivation ? 5 : 0));
        const s = createBackOver25Strategy(match, htProb, allMatches, conf);
        if (s) {
            qualified.push({
                type: 'BACK_OVER_25',
                strategy: 'BACK_OVER_25',
                confidence: conf,
                entryRange: s.tradingInstruction?.entry || null,
                exitTarget: s.tradingInstruction?.exit || null,
                reasoning: s.reasoning || null,
                tradingInstruction: s.tradingInstruction
            });
        }
    }

    // 2. LAY THE DRAW
    if (teams.length === 2) {
        const homeDrawRate = analyzeDrawRate(teams[0].trim(), allMatches, match.teamIdHome);
        const awayDrawRate = analyzeDrawRate(teams[1].trim(), allMatches, match.teamIdAway);
        const avgHistDraw = (homeDrawRate.rate + awayDrawRate.rate) / 2;
        const mcDrawProb = magicData?.drawProb || magicData?.draw || 30;
        const isBiscottoRisk = isDirectClash && mcDrawProb > 33;

        if ((mcDrawProb < 35 || avgHistDraw < 35) && !isBiscottoRisk) {
            let conf = Math.round(100 - ((mcDrawProb * 0.7) + (avgHistDraw * 0.3))) + 15;
            if (isRelegationFight) conf += 5;

            const s = createLayTheDrawStrategy(match, avgHistDraw, homeDrawRate, awayDrawRate, mcDrawProb < 25 && avgHistDraw < 28, Math.min(95, conf));
            if (s) {
                qualified.push({
                    type: 'LAY_THE_DRAW',
                    strategy: 'LAY_THE_DRAW',
                    confidence: Math.min(95, conf),
                    entryRange: s.tradingInstruction?.entry || null,
                    exitTarget: s.tradingInstruction?.exit || null,
                    reasoning: s.reasoning || null,
                    tradingInstruction: s.tradingInstruction
                });
            }
        }
    }

    // 3. SECOND HALF SURGE
    if (score >= 55 && prob >= 50) {
        const conf = Math.min(95, Math.round((score * 0.5) + (prob * 0.3) + 15) + 10);
        const s = createSecondHalfSurgeStrategy(match, allMatches, conf);
        if (s) {
            qualified.push({
                type: 'SECOND_HALF_SURGE',
                strategy: 'SECOND_HALF_SURGE',
                confidence: conf,
                entryRange: s.tradingInstruction?.entry || null,
                exitTarget: s.tradingInstruction?.exit || null,
                reasoning: s.reasoning || null,
                tradingInstruction: s.tradingInstruction
            });
        }
    }

    // 4. UNDER 3.5 SCALPING
    const under35Prob = 100 - (over25Prob || 50) + 15;
    if (under35Prob >= 60 && !hasMotivation) {
        const conf = Math.min(90, Math.round(under35Prob * 0.7 + 15));
        const s = createUnder35TradingStrategy(match, conf);
        if (s) {
            qualified.push({
                type: 'UNDER_35_SCALPING',
                strategy: 'UNDER_35_SCALPING',
                confidence: conf,
                entryRange: s.tradingInstruction?.entry || null,
                exitTarget: s.tradingInstruction?.exit || null,
                reasoning: s.reasoning || null,
                tradingInstruction: s.tradingInstruction
            });
        }
    }

    // 5. HT SNIPER (Sempre per ultimo per sorpasso professional)
    const htGoalProb = magicData?.htGoalProb || htProb;
    if (htProb >= 65 || htGoalProb >= 60) {
        const conf = Math.min(95, Math.round(Math.max(htProb, htGoalProb)) + (isTitleRace ? 5 : 0)) - 25;
        const s = createHTSniperStrategy(match, htProb, conf);
        if (s) {
            qualified.push({
                type: 'HT_SNIPER',
                strategy: 'HT_SNIPER',
                confidence: conf,
                entryRange: s.tradingInstruction?.entry || null,
                exitTarget: s.tradingInstruction?.exit || null,
                reasoning: s.reasoning || null,
                tradingInstruction: s.tradingInstruction
            });
        }
    }

    // Sort: Professional First Rule
    qualified.sort((a, b) => {
        const profTypes = ['BACK_OVER_25', 'LAY_THE_DRAW', 'ELITE_SURGE', 'SECOND_HALF_SURGE'];
        const isAProf = profTypes.includes(a.type);
        const isBProf = profTypes.includes(b.type);

        // Se una professionale ha almeno il 60%, batte HT Sniper a meno che non sia > 90%
        if (isAProf && !isBProf && a.confidence >= 60 && b.confidence < 90) return -1;
        if (!isAProf && isBProf && b.confidence >= 60 && a.confidence < 90) return 1;

        return b.confidence - a.confidence;
    });

    return qualified;
}


function generateTradingBadge(match, is05HT = false, team1Stats = null, team2Stats = null) {
    const tip = (match.tip || '').trim().toUpperCase();
    const score = match.magicStats?.score || match.score || 0;

    // Estrai HT prob se disponibile
    let htProb = 0;
    if (match.info_ht && match.info_ht.trim() !== '') {
        const htMatch = match.info_ht.match(/(\d+)%/);
        if (htMatch) htProb = parseInt(htMatch[1]);
    }

    let tradingBadge = null;

    // SPECIALE: Filtro BEST 0.5 HT → Badge dinamico basato su prolificità
    if (is05HT && htProb >= 70 && score >= 50 && team1Stats && team2Stats) {
        // Calcola prolificità media squadre per Over 2.5
        const team1Over25 = team1Stats.total >= 5 ? (team1Stats.count / team1Stats.total) * 100 : 0;
        const team2Over25 = team2Stats.total >= 5 ? (team2Stats.count / team2Stats.total) * 100 : 0;
        const avgProlificita = (team1Over25 + team2Over25) / 2;

        // Badge dinamico basato su prolificità
        if (avgProlificita >= 75) {
            tradingBadge = {
                text: 'Trading Back Over 2.5',
                color: 'bg-yellow-100 text-yellow-700 border-yellow-300'
            };
        } else if (avgProlificita >= 60) {
            tradingBadge = {
                text: 'Trading Scalping Over 1.5',
                color: 'bg-blue-100 text-blue-700 border-blue-300'
            };
        } else {
            tradingBadge = {
                text: 'Trading Gol 1° Tempo',
                color: 'bg-green-100 text-green-700 border-green-300'
            };
        }
        return tradingBadge;
    }

    // STANDARD: Logica normale per altre strategie
    if (tip === '+1.5' && htProb >= 75) {
        tradingBadge = {
            text: 'Trading Gol 1° Tempo',
            color: 'bg-green-100 text-green-700 border-green-300'
        };
    } else if (tip === '+2.5') {
        tradingBadge = {
            text: 'Trading Back Over 2.5',
            color: 'bg-purple-100 text-purple-700 border-purple-300'
        };
    } else if (['1', '2'].includes(tip) && score >= 70) {
        tradingBadge = {
            text: 'Trading Lay The Draw',
            color: 'bg-blue-100 text-blue-700 border-blue-300'
        };
    }

    return tradingBadge;
}

// ==================== MONTE CARLO ENGINE ====================

/**
 * Seeded Random Number Generator (Mulberry32)
 * Ensures deterministic results for the same match/seed.
 */
class SeededRandom {
    constructor(seedString) {
        // Create a hash from the string to use as numeric seed
        let h = 0x811c9dc5;
        if (seedString) {
            for (let i = 0; i < seedString.length; i++) {
                h ^= seedString.charCodeAt(i);
                h = Math.imul(h, 0x01000193);
            }
        } else {
            h = Math.floor(Math.random() * 0xFFFFFFFF);
        }
        this.state = h >>> 0;
    }

    // Returns a float between 0 and 1
    next() {
        let t = (this.state += 0x6D2B79F5);
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        this.state = t >>> 0; // update state
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }
}

/**
 * Generates a random number based on Poisson distribution
 * (Knuth's algorithm) - Now accepts a custom RNG
 */
function poissonRandom(lambda, rng = null) {
    const L = Math.exp(-lambda);
    let k = 0;
    let p = 1;
    do {
        k++;
        p *= rng ? rng.next() : Math.random();
    } while (p > L);
    return k - 1;
}

// ==================== MONTE CARLO ENGINE (TRUE SIMULATION) ====================

/**
 * Generates a random number based on Poisson distribution
 */
function poissonRandom(lambda) {
    const L = Math.exp(-lambda);
    let k = 0;
    let p = 1;
    do {
        k++;
        p *= Math.random();
    } while (p > L);
    return k - 1;
}

/**
 * Dixon-Coles Correction Function
 * Adjusts probability for low scores (0-0, 1-0, 0-1, 1-1)
 */
function dixonColesCorrection(hg, ag, rho, lambdaHome, lambdaAway) {
    if (hg === 0 && ag === 0) return 1 - (lambdaHome * lambdaAway * rho);
    if (hg === 0 && ag === 1) return 1 + (lambdaHome * rho);
    if (hg === 1 && ag === 0) return 1 + (lambdaAway * rho);
    if (hg === 1 && ag === 1) return 1 - rho;
    return 1;
}

/**
 * Runs a TRUE Monte Carlo simulation for a match
 * Returns raw data for density analysis
 */
function simulateMatch(lambdaHome, lambdaAway, iterations = 10000, seedString = "", entropy = 1.0) {
    // Determine seed for reproducible results
    // If no seed provided, utilize Math.random via SeededRandom wrapper or just null to use fallback
    const rng = seedString ? new SeededRandom(seedString) : null;
    const results = {
        homeWins: 0, draws: 0, awayWins: 0,
        dc1X: 0, dcX2: 0, dc12: 0,
        over15: 0, under35: 0,
        ht05: 0, // 🔥 NEW: 1° Tempo (0.5 HT)
        btts: 0, noGol: 0,
        scores: {}, // Exact score frequency
        homeCleanSheet: 0, awayCleanSheet: 0
    };

    // 🔥 FIX v4.4: Use optimal Rho from getDixonColesRho()
    const rho = getDixonColesRho();

    // 🔥 Volatility Analysis Setup
    let volatilityScore = 0;
    const entropyLimit = entropy > 1.0 ? entropy : 1.0;

    for (let i = 0; i < iterations; i++) {
        // Apply entropy "jitter" to lambda values to model league chaos
        let currentLambdaHome = lambdaHome;
        let currentLambdaAway = lambdaAway;

        if (entropy !== 1.0) {
            const jitterRange = (entropy - 1.0) * 0.3; // E.g., 1.25 entropy = ±0.075 jitter
            const jitterH = (Math.random() * jitterRange * 2) - jitterRange;
            const jitterA = (Math.random() * jitterRange * 2) - jitterRange;
            currentLambdaHome = Math.max(0.1, lambdaHome + jitterH);
            currentLambdaAway = Math.max(0.1, lambdaAway + jitterA);
        }

        const hg = poissonRandom(currentLambdaHome, rng);
        const ag = poissonRandom(currentLambdaAway, rng);

        // Apply Dixon-Coles weighting via rejection sampling or basic correction
        // For Monte Carlo, we weight the count by the correction factor
        const weight = dixonColesCorrection(hg, ag, rho, lambdaHome, lambdaAway);

        // Instead of increments of 1, we increment by weight
        const totalGoals = hg + ag;

        // 1X2
        if (hg > ag) results.homeWins += weight;
        else if (hg === ag) results.draws += weight;
        else results.awayWins += weight;

        // Double Chance
        if (hg >= ag) results.dc1X += weight;
        if (ag >= hg) results.dcX2 += weight;
        if (hg !== ag) results.dc12 += weight;

        // Goals (SOLO Over 1.5 e Under 3.5 - mercati più probabili)
        if (totalGoals > 1.5) results.over15 += weight;
        if (totalGoals < 3.5) results.under35 += weight;

        // 🔥 NEW: 0.5 HT Simulation (approx 45% of lambda)
        const hgHT = poissonRandom(currentLambdaHome * 0.45, rng);
        const agHT = poissonRandom(currentLambdaAway * 0.45, rng);
        if (hgHT + agHT > 0) results.ht05 += weight;

        // BTTS
        if (hg > 0 && ag > 0) results.btts += weight;
        else results.noGol += weight;

        // Clean Sheets
        if (ag === 0) results.homeCleanSheet += weight;
        if (hg === 0) results.awayCleanSheet += weight;

        // Exact Score
        const key = `${hg}-${ag}`;
        results.scores[key] = (results.scores[key] || 0) + weight;
    }

    // Normalize counts to get probabilities
    const sumWeights = Object.values(results.scores).reduce((a, b) => a + b, 0);

    // Process Exact Scores
    const sortedScores = Object.entries(results.scores)
        .sort(([, a], [, b]) => b - a)
        .map(([score, count]) => ({
            score,
            percent: Math.round((count / sumWeights) * 100),
            rawCount: count
        }));

    return {
        // Probabilities (10 Markets - rimosso Over 2.5)
        winHome: Math.round((results.homeWins / sumWeights) * 100),
        draw: Math.round((results.draws / sumWeights) * 100),
        winAway: Math.round((results.awayWins / sumWeights) * 100),
        dc1X: Math.round((results.dc1X / sumWeights) * 100),
        dcX2: Math.round((results.dcX2 / sumWeights) * 100),
        dc12: Math.round((results.dc12 / sumWeights) * 100),
        over15: Math.round((results.over15 / sumWeights) * 100),
        under35: Math.round((results.under35 / sumWeights) * 100),
        ht05: Math.round((results.ht05 / sumWeights) * 100), // 🔥 NEW
        btts: Math.round((results.btts / sumWeights) * 100),
        noGol: Math.round((results.noGol / sumWeights) * 100),

        // Rischi
        homeCleanSheetProb: Math.round((results.homeCleanSheet / sumWeights) * 100),
        awayCleanSheetProb: Math.round((results.awayCleanSheet / sumWeights) * 100),

        // Core Data
        exactScores: sortedScores,
        mostFrequentScore: sortedScores[0],
        // Volatility Evaluation
        volatilityIndex: Math.min(10, Math.round((entropyLimit - 0.8) * 20)),
        lastUpdated: Date.now()
    };
}

/**
 * Determines the "Safety Level" (Density) of the prediction
 */
function calculateSafetyLevel(simStats) {
    const topScorePerc = simStats.mostFrequentScore.percent;
    const top3Sum = simStats.exactScores.slice(0, 3).reduce((sum, s) => sum + s.percent, 0);

    if (topScorePerc >= 14 || top3Sum >= 35) return { level: 'ALTA', color: 'green', label: 'Alta Stabilità' };
    if (topScorePerc >= 10 || top3Sum >= 25) return { level: 'MEDIA', color: 'yellow', label: 'Media Stabilità' };
    return { level: 'BASSA', color: 'red', label: 'Bassa Stabilità (Rischio)' };
}

/**
 * Generates the "Magia AI" Strategy
 * "THE PROFESSIONAL SCANNER" Logic
 */
/**
 * Generates the "Magia AI" Strategy
 * "THE PROFESSIONAL SCANNER" Logic
 */
function generateMagiaAI(matches, allMatchesHistory) {
    const magicMatches = [];

    // 🔥 TUTTE LE PARTITE DELLA SANDBOX (campo magia rimosso - inutile)
    const sourceMatches = matches;

    sourceMatches.forEach(match => {
        if (!match.lega) return;
        const teams = parseTeams(match.partita);
        if (!teams) return;

        // Ensure magicStats exists (it should from Step 1)
        if (!match.magicStats) {
            // 🔥 DEBUG: Log missing magicStats
            console.log(`[Magia AI] Skip: ${match.partita} - NO magicStats (Step 1 non eseguito o non salvato)`);
            return;
        }

        /* 🔥 VETO COPPE REMOVED v12.0 for Total Coverage
        const isCup = STANDINGS_BLACKLIST_KEYWORDS.some(k => leagueNorm.includes(k));
        if (isCup) {
            console.log(`[Magia AI] Veto Coppa: ${match.partita} (${match.lega})`);
            return;
        }
        */

        let sim = match.magicStats;

        // ═══════════════════════════════════════════════════════════════════════
        // MAGIA AI 4.3: CASSA BLINDATA (@1.20 - 1.25)
        // ═══════════════════════════════════════════════════════════════════════

        // 🔥 FILTRO 1: REAL API ODDS PREFERRED (Using estimates as fallback v12.0)
        const hasRealApiOdds = match.quota1 && match.quotaX && match.quota2 &&
            parseFloat(match.quota1) > 1 &&
            parseFloat(match.quotaX) > 1 &&
            parseFloat(match.quota2) > 1;

        if (!hasRealApiOdds) {
            console.log(`[Magia AI] Note: ${match.partita} - Using estimated odds (No real API odds found)`);
        }

        // MAP ALL SIGNALS
        const allSignals = [
            { label: '1', prob: sim.winHome, type: '1X2' },
            { label: 'X', prob: sim.draw, type: '1X2' },
            { label: '2', prob: sim.winAway, type: '1X2' },
            { label: '1X', prob: sim.dc1X, type: 'DC' },
            { label: 'X2', prob: sim.dcX2, type: 'DC' },
            { label: '12', prob: sim.dc12, type: 'DC' },
            { label: '+1.5', prob: sim.over15, type: 'GOALS' },
            { label: '+2.5', prob: sim.over25, type: 'GOALS' },
            { label: '-3.5', prob: sim.under35, type: 'GOALS' },
            { label: 'Gol', prob: sim.btts, type: 'GOALS' },
            { label: 'No Gol', prob: sim.noGol, type: 'GOALS' }
        ];

        const THRESHOLDS = STRATEGY_CONFIG.MAGIA_AI.THRESHOLDS;

        const getThreshold = (signal) => {
            const cfg = THRESHOLDS.find(t =>
                (t.type === signal.type && t.label === signal.label) ||
                (t.type === signal.type && !t.label)
            );
            return cfg ? cfg.minProb : 75;
        };

        // 1. MAPPA CANDIDATI CON QUOTE REALI (Sandbox)
        const scoredCandidates = allSignals.map(signal => {
            let realOdd = null;
            if (signal.label === '1') realOdd = match.quota1;
            else if (signal.label === 'X') realOdd = match.quotaX;
            else if (signal.label === '2') realOdd = match.quota2;
            else if (signal.label === '1X') realOdd = match.bookmaker1X || match.q1X; // 🆕 Supporto nuove quote
            else if (signal.label === 'X2') realOdd = match.bookmakerX2 || match.qX2;
            else if (signal.label === '12') realOdd = match.bookmaker12 || match.q12;
            else if (signal.label === '+1.5') realOdd = match.bookmakerOver15 || match.qO15;
            else if (signal.label === '+2.5') realOdd = match.bookmakerOver25 || match.qO25;
            else if (signal.label === '-3.5') realOdd = match.bookmakerUnder35 || match.qU35;
            else if (signal.label === 'Gol') realOdd = match.bookmakerGG || match.qBTTS || match.qGol;
            else if (signal.label === 'No Gol') realOdd = match.bookmakerNG || match.qNG || match.qNoGol;

            const finalOdd = parseFloat(realOdd) || (100 / (signal.prob || 1));
            return {
                ...signal,
                quota: finalOdd.toFixed(2),
                isReal: !!realOdd
            };
        });

        // 🔥 ALGORITMO DI SELEZIONE ELITE v13.1
        // Portato soglia minima a 1.01 per marketing (stile Betmines)
        let candidates = scoredCandidates.filter(s => s.prob >= 75 && parseFloat(s.quota) >= 1.01);

        // Fallback 1: Solo alta probabilità
        if (candidates.length === 0) candidates = scoredCandidates.filter(s => s.prob >= 75);

        // Fallback 2: Il migliore assoluto
        if (candidates.length === 0) candidates = [scoredCandidates.sort((a, b) => b.prob - a.prob)[0]];

        // Priorità: DC (Sicure) > 1X2 (Classiche) > Goals (Over/Under)
        candidates.sort((a, b) => {
            const weights = { 'DC': 3, '1X2': 2, 'GOALS': 1 };
            if (weights[b.type] !== weights[a.type]) return weights[b.type] - weights[a.type];
            return b.prob - a.prob;
        });

        const bestPick = candidates[0];

        const magiaMatch = {
            ...match,
            tip: bestPick.label,
            probabilita: bestPick.prob.toFixed(1),
            probMagiaAI: bestPick.prob, // 🆕 NORMALIZZATO
            quota: bestPick.quota,
            quotaType: bestPick.isReal ? 'REAL' : 'AI_ESTIMATE',
            mercato: bestPick.type,
            strategy: 'magia_ai',
            smartScore: bestPick.prob // 🆕 AGGIUNTO SCORE
        };
        magicMatches.push(magiaMatch);
    });

    return magicMatches;
}

/**
 * ORCHESTRATOR: Distributes matches to strategies using pre-calculated stats./**
 * This function is the core of Step 2B.
 * 🔥 UPDATED v14.0: Accepts config (blacklist, presets) for dynamic extraction
 */
/**
 * orchestrator: Distributes matches to strategies using strict FixtureID (Mantra Protocol)
 * 🔥 UPDATED v15.0: Matches without fixtureId are DISCARDED. 
 * Merges AI data and Betmines data using fixtureId as the universal key.
 */
function distributeStrategies(calculatedMatches, allMatchesHistory, selectedDate, config = {}) {
    const blacklist = (config.blacklist || []).map(l => (l || "").toLowerCase().trim());
    const presets = config.presets || {};

    if ((!calculatedMatches || calculatedMatches.length === 0) && (!allMatchesHistory || allMatchesHistory.length === 0)) {
        return {};
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 1. UNIFIED POOL (ID-PURE PROTOCOL)
    // ═══════════════════════════════════════════════════════════════════════
    const pool = new Map();
    (allMatchesHistory || []).forEach(m => {
        if (m.data === selectedDate && m.magia === 'OK') {
            const fId = m.fixtureId || m.id;
            if (fId) {
                const key = String(fId);
                const matchCopy = { ...m };

                // 🔥 ID ONLY RULE: Resolve leagueId from Registry if missing
                if (!matchCopy.leagueId && window.leaguesRegistry) {
                    const normLega = normalizeLega(matchCopy.lega).toLowerCase().trim();
                    const registryEntry = window.leaguesRegistry.get(normLega);
                    if (registryEntry && registryEntry.leagueId) {
                        matchCopy.leagueId = registryEntry.leagueId;
                    }
                }

                pool.set(key, matchCopy);
            }
        }
    });

    const unifiedMatches = Array.from(pool.values());

    // ═══════════════════════════════════════════════════════════════════════
    // 2. GLOBAL FILTERS (Blacklist)
    // ═══════════════════════════════════════════════════════════════════════
    const cleanPool = unifiedMatches.filter(m => {
        const legaOrig = (m.lega || "").toLowerCase().trim();
        const legaNorm = normalizeLega(m.lega).toLowerCase().trim();
        return !blacklist.includes(legaOrig) && !blacklist.includes(legaNorm);
    });

    const results = {};

    // ═══════════════════════════════════════════════════════════════════════
    // 3. STRATEGY DISTRIBUTION
    // ═══════════════════════════════════════════════════════════════════════
    const strategies = [
        { id: 'all', name: '📊 ALL', type: 'all' },
        { id: 'italia', name: '🇮🇹 ITALIA', type: 'italia' },
        { id: 'top_eu', name: '🌍 TOP EU', type: 'top_eu' },
        { id: 'cups', name: '🏆 COPPE', type: 'cups' },
        { id: 'winrate_80', name: '🔥 WINRATE 80%', type: 'winrate_80' },
        { id: '___magia_ai', name: '🔮 SPECIAL AI', type: 'winrate_80' } // Now using rigid winrate filters
    ];

    const topEuLeagues = [
        'EU-ENG Premier League', 'EU-ESP La Liga', 'EU-DEU Bundesliga',
        'EU-FRA Ligue 1', 'EU-NED Eredivisie', 'EU-CHE Super League',
        'EU-PRT Primeira Liga', 'EU-BEL Pro League'
    ];
    const cupKeywords = ['champions league', 'europa league', 'conference league'];

    strategies.forEach(strat => {
        let filtered = [];

        if (strat.type === 'all') {
            // ALL: Keep matches with tips (either Betmines or AI)
            filtered = cleanPool.filter(m => (m.tip && String(m.tip).trim() !== '') || m.magicStats?.tipMagiaAI);
        } else if (strat.type === 'italia') {
            filtered = cleanPool.filter(m => normalizeLega(m.lega).startsWith('eu-ita'));
        } else if (strat.type === 'top_eu') {
            const topEuLower = topEuLeagues.map(l => l.toLowerCase());
            filtered = cleanPool.filter(m => topEuLower.includes(normalizeLega(m.lega)));
        } else if (strat.type === 'cups') {
            filtered = cleanPool.filter(m => {
                const l = normalizeLega(m.lega);
                return cupKeywords.some(k => l.includes(k.toLowerCase()));
            });
        } else if (strat.type === 'winrate_80') {
            // Mapping for presets (firebase id vs strat id)
            const presetId = strat.id === '___magia_ai' ? 'special_ai' : strat.id;
            const p = presets[presetId] || {};

            filtered = cleanPool.filter(m => {
                const isWinrate = strat.id === 'winrate_80';

                // 🔥 ID ONLY RULE: Compare Numeric IDs (handled as strings for safety if they came from Firebase)
                if (p.leagues?.length > 0) {
                    const matchLeagueId = String(m.leagueId || '');
                    const allowedLeagues = p.leagues.map(id => String(id));

                    if (!allowedLeagues.includes(matchLeagueId)) return false;
                }

                if (p.tips?.length > 0 && !p.tips.includes(m.tip)) return false;
                if (p.odds && (parseFloat(m.quota) < p.odds[0] || parseFloat(m.quota) > p.odds[1])) return false;
                if (p.prob && (parseFloat(m.probabilita) < p.prob[0] || parseFloat(m.probabilita) > p.prob[1])) return false;
                return true;
            });
        }

        results[strat.id] = {
            id: strat.id,
            name: strat.name,
            matches: filtered,
            totalMatches: filtered.length,
            type: strat.type,
            lastUpdated: Date.now()
        };
    });

    return results;
}



/**
 * Calcola i parametri Magia AI (Dixon-Coles) per una singola partita
 * Versione "viva" per trading ohne filtri di soglia confidence
 */
function getMagiaStats(match, allMatchesHistory) {
    const teams = parseTeams(match.partita);
    if (!teams) return null;

    const homeStats = analyzeTeamStats(teams.home, true, 'ALL', allMatchesHistory, match.teamIdHome);
    const awayStats = analyzeTeamStats(teams.away, false, 'ALL', allMatchesHistory, match.teamIdAway);

    // Relaxed form check: prioritize current form but fallback to season stats instead of returning null
    // if (homeStats.currForm.matchCount < 3 || awayStats.currForm.matchCount < 3) return null;

    // League Goal & Entropy Factors
    const leagueNorm = (match.lega || '').toLowerCase();
    const cleanLega = leagueNorm.replace(/\[.*?\]\s*/g, '');

    // 🔥 FIX v4.4: Use dynamic goal factor function
    let goalFactor = getGoalFactor(leagueNorm);
    let entropyFactor = 1.0;
    let volatilityLevel = 'STABILE';

    // 🔥 Check LEAGUE_DNA for Entropy & Volatility
    for (const [league, dna] of Object.entries(LEAGUE_DNA)) {
        if (leagueNorm.includes(league) || cleanLega.includes(league)) {
            entropyFactor = dna.entropy;
            volatilityLevel = dna.vLevel;
            break;
        }
    }

    // Fallback to generic factors
    if (entropyFactor === 1.0) {
        for (const [l, factor] of Object.entries(LEAGUE_ENTROPY_FACTORS)) {
            if (leagueNorm.includes(l) || cleanLega.includes(l)) {
                entropyFactor = factor;
                break;
            }
        }
    }

    // 🔥 POINT 3: MOTIVATION FACTOR (STANDINGS)
    let motivationH = 1.0;
    let motivationA = 1.0;

    // Check if standings are available for this league
    let leagueId = match.leagueId || null;

    // 🔗 Use Registry loaded at startup (clean solution - no LEAGUE_MAPPING)
    if (!leagueId && window.leaguesRegistry) {
        // leaguesRegistry is a Map loaded once at admin startup
        const registryEntry = window.leaguesRegistry.get(normalizeLega(match.lega));
        if (registryEntry && registryEntry.leagueId) {
            leagueId = registryEntry.leagueId;
        }
    }

    const cache = window.standingsCache;
    let standings = null;
    if (leagueId && cache) {
        // Support both Map (new) and object (old) structures
        if (typeof cache.get === 'function') {
            // Check for potential keys like standings_135_2024 or just 135
            standings = cache.get(leagueId) || cache.get(`standings_${leagueId}_2025`) || cache.get(`standings_${leagueId}_2024`);
        } else {
            standings = cache[leagueId];
        }
        if (!standings) console.warn(`[EngineDebug] No standings for ID ${leagueId} in cache`);
    } else {
        console.warn(`[EngineDebug] Skip standings lookup: leagueId=${leagueId}, cache=${!!cache}`);
    }

    const motivationBadges = [];
    let rankH = null;
    let rankA = null;

    if (standings) {
        const idH = match.teamIdHome;
        const idA = match.teamIdAway;

        const stdH = standings.find(s => {
            if (idH && s.team.id === idH) return true;
            const sName = normalizeTeamName(s.team.name);
            const normH = normalizeTeamName(teams.home);
            return sName.includes(normH) || normH.includes(sName);
        });
        const stdA = standings.find(s => {
            if (idA && s.team.id === idA) return true;
            const sName = normalizeTeamName(s.team.name);
            const normA = normalizeTeamName(teams.away);
            return sName.includes(normA) || normA.includes(sName);
        });

        if (stdH && stdA) {
            rankH = stdH.rank;
            rankA = stdA.rank;
            const totalTeams = standings.length;

            // High Motivation: Fighting for Title/Europe (Top 4) or Relegation (Bottom 4)
            if (stdH.rank >= totalTeams - 4) {
                motivationH += 0.15;
                motivationBadges.push({ team: 'H', type: 'SALVEZZA', label: 'Lotta Salvezza 🆘' });
            } else if (stdH.rank <= 4) {
                motivationH += 0.10;
                motivationBadges.push({ team: 'H', type: 'TITOLO', label: 'Corsa Titolo/EU 🏆' });
            }

            if (stdA.rank >= totalTeams - 4) {
                motivationA += 0.15;
                motivationBadges.push({ team: 'A', type: 'SALVEZZA', label: 'Lotta Salvezza 🆘' });
            } else if (stdA.rank <= 4) {
                motivationA += 0.10;
                motivationBadges.push({ team: 'A', type: 'TITOLO', label: 'Corsa Titolo/EU 🏆' });
            }

            // Direct Clash: If teams are within 3 points of each other
            if (Math.abs(stdH.points - stdA.points) <= 3) {
                motivationH += 0.05;
                motivationA += 0.05;
                motivationBadges.push({ team: 'B', type: 'SCONTRO', label: 'Scontro Diretto ⚔️' });
            }

            // 🔥 TECHNICAL GAP CORRECTION (Home/Away Strength)
            if (stdH.home && stdH.all && stdH.home.played >= 3) {
                const homeGfAvg = stdH.home.goals.for / stdH.home.played;
                const seasonGfAvg = stdH.all.goals.for / stdH.all.played;
                if (seasonGfAvg > 0) {
                    const homeFactor = homeGfAvg / seasonGfAvg;
                    // Boost if home performance > season avg, penalize if weaker
                    motivationH *= (0.95 + (Math.min(1.2, homeFactor) * 0.05));
                }
            }
            if (stdA.away && stdA.all && stdA.away.played >= 3) {
                const awayGfAvg = stdA.away.goals.for / stdA.away.played;
                const seasonGfAvg = stdA.all.goals.for / stdA.all.played;
                if (seasonGfAvg > 0) {
                    const awayFactor = awayGfAvg / seasonGfAvg;
                    motivationA *= (0.95 + (Math.min(1.2, awayFactor) * 0.05));
                }
            }
        }
    }
    // 🔥 FIX v4.4: ELO Factor integrated in Lambda (not post-processing)
    let eloFactorHome = 1.0;
    let eloFactorAway = 1.0;
    let eloDiff = 0;
    let eloRatingH = 1500;
    let eloRatingA = 1500;

    if (window.teamELORatings) {
        eloRatingH = window.teamELORatings.get(teams.home) || 1500;
        eloRatingA = window.teamELORatings.get(teams.away) || 1500;
        eloDiff = eloRatingH - eloRatingA;

        // ELO Factor: For every 150 ELO points difference, adjust lambda by ~10%
        // Max adjustment: ±20%
        eloFactorHome = 1 + Math.max(-0.20, Math.min(0.20, eloDiff / 1500));
        eloFactorAway = 1 + Math.max(-0.20, Math.min(0.20, -eloDiff / 1500));
    }

    const lambdaHome = ((homeStats.currForm.avgScored * 0.6 + homeStats.season.avgScored * 0.4 +
        awayStats.currForm.avgConceded * 0.6 + awayStats.season.avgConceded * 0.4) / 2) * goalFactor * motivationH * eloFactorHome;
    const lambdaAway = ((awayStats.currForm.avgScored * 0.6 + awayStats.season.avgScored * 0.4 +
        homeStats.currForm.avgConceded * 0.6 + homeStats.season.avgConceded * 0.4) / 2) * goalFactor * motivationA * eloFactorAway;

    const sim = simulateMatch(lambdaHome, lambdaAway, 10000, match.partita, entropyFactor);
    sim.motivationBadges = motivationBadges;
    sim.rankH = rankH;
    sim.rankA = rankA;
    sim.leagueId = leagueId;

    // 🔥 EXPERT STATS (Form & Goals)
    sim.expertStats = {
        home: {
            form: homeStats.currForm.outcomes || [],
            avgScored: homeStats.season.avgScored,
            avgConceded: homeStats.season.avgConceded,
            formScored: homeStats.currForm.avgScored
        },
        away: {
            form: awayStats.currForm.outcomes || [],
            avgScored: awayStats.season.avgScored,
            avgConceded: awayStats.season.avgConceded,
            formScored: awayStats.currForm.avgScored
        }
    };
    /**
     * STATISTICAL ENGINE v4.4.0 - ELITE MODE with Pre-integrated ELO
     * Last update: 24/01/2026 - ELO now in Lambda (not post-processing)
     */
    console.log('%c[Elite Engine 4.4] Logic Initialized | ELO Pre-integrated', 'color: #00ff00; font-weight: bold; background: #000; padding: 5px;');

    // 🔥 FIX v4.4: ELO is now integrated in Lambda (lines 2140-2156)
    // Just record values for display, no more probability adjustment here
    sim.eloRatingH = Math.round(eloRatingH);
    sim.eloRatingA = Math.round(eloRatingA);
    sim.eloDiff = Math.round(eloDiff);

    // Hybrid refinement (Draw Penalty) v4.5 "Real Draw"
    const weightSim = (window.STRATEGY_CONFIG && window.STRATEGY_CONFIG.ENGINE) ? window.STRATEGY_CONFIG.ENGINE.HYBRID_DRAW_WEIGHT_SIM : 0.7;
    const weightHist = (window.STRATEGY_CONFIG && window.STRATEGY_CONFIG.ENGINE) ? window.STRATEGY_CONFIG.ENGINE.HYBRID_DRAW_WEIGHT_HIST : 0.3;

    const histHomeDraw = homeStats.season.matches > 0 ? (homeStats.season.draws / homeStats.season.matches) * 100 : 25;
    const histAwayDraw = awayStats.season.matches > 0 ? (awayStats.season.draws / awayStats.season.matches) * 100 : 25;
    const avgHistDraw = (histHomeDraw + histAwayDraw) / 2;

    let hybridDraw = (sim.draw * weightSim) + (avgHistDraw * weightHist);

    const dbTip = (match.tip || '').trim();
    if (dbTip === '1' || dbTip === '2') {
        hybridDraw = hybridDraw * 0.90;
    }

    // Normalize
    const remainder = 100 - hybridDraw;
    const ratio = remainder / (sim.winHome + sim.winAway);
    sim.draw = hybridDraw;
    sim.winHome = sim.winHome * ratio;
    sim.winAway = sim.winAway * ratio;

    // 🔥 POINT 4: CATEGORY GAP DETECTION (v4.1)
    const cupKeywords = ['cup', 'coppa', 'trofeo', 'fa cup', 'copa', 'final', 'supercup', 'supercoppa', 'super cup', 'qualifiers', 'play-off', 'friendlies', 'friendly', 'international', 'spareggio'];
    const isCupMatch = cupKeywords.some(k => leagueNorm.includes(k)) && !leagueNorm.includes('league');
    let isCategoryGap = false;

    if (isCupMatch) {
        // Se abbiamo ELO, usiamo quello come proxy veloce del gap di categoria
        if (sim.eloDiff && Math.abs(sim.eloDiff) > 250) {
            isCategoryGap = true;
        } else {
            // Fallback: se le leghe "originarie" di provenienza nel DB sono diverse
            // (implementazione light: se una squadra ha più del 70% dei match in una lega diversa dall'altra)
            // Per ora usiamo ELO > 250 come trigger primario per evitare rallentamenti eccessivi.
            if (!sim.eloDiff && (homeStats.currForm.matchCount > 0 && awayStats.currForm.matchCount > 0)) {
                // Se non c'è ELO ma c'è disparità evidente di goal factor storici (proxy)
                // isCategoryGap = true; // Placeholder
            }
        }
    }
    sim.isCategoryGap = isCategoryGap;
    sim.isCupMatch = isCupMatch;

    // 🔥 NEW v12.0: ADAPTIVE LOGIC based on League Trust Score (Master Trust v12.0)
    const normalizedLega = normalizeLega(match.lega);
    const trustData = (window.LEAGUE_TRUST && window.LEAGUE_TRUST[normalizedLega]) ? window.LEAGUE_TRUST[normalizedLega] : { trust: 5, mode: 'STANDARD' };

    // 🔥 NEW v4.5: MAGIA FIRBA (Marketing-First Selection Logic)
    // Goal: Win Rate over Value. Priority to "safe" low odds.

    // Preparation: Map odds to signals
    const allSignals = [
        { label: '1', prob: sim.winHome, type: '1X2' },
        { label: 'X', prob: sim.draw, type: '1X2' },
        { label: '2', prob: sim.winAway, type: '1X2' },
        { label: '1X', prob: sim.dc1X, type: 'DC' },
        { label: 'X2', prob: sim.dcX2, type: 'DC' },
        { label: '12', prob: sim.dc12, type: 'DC' },
        { label: '+1.5', prob: sim.over15, type: 'GOALS' },
        { label: '-3.5', prob: sim.under35, type: 'GOALS' },
        { label: '+0.5 HT', prob: sim.ht05, type: 'GOALS' }
    ];

    allSignals.forEach(s => {
        const tip = s.label;
        if (tip === '1') s.odd = match.quota1 || 1.25;
        else if (tip === 'X') s.odd = match.quotaX || 1.25;
        else if (tip === '2') s.odd = match.quota2 || 1.25;
        else if (tip === '1X') s.odd = match.bookmaker1X || match.q1X || 1.25;
        else if (tip === 'X2') s.odd = match.bookmakerX2 || match.qX2 || 1.25;
        else if (tip === '12') s.odd = match.bookmaker12 || match.q12 || 1.25;
        else if (tip === '+1.5') s.odd = match.bookmakerOver15 || 1.25;
        else if (tip === '+2.5') s.odd = match.bookmakerOver25 || 1.25;
        else if (tip === '-3.5') s.odd = match.bookmakerUnder35 || 1.25;
        else if (tip === '+0.5 HT') s.odd = match.bookmakerOver05HT || 1.25;
        else s.odd = 1.25;
    });

    // Strategy Rules:
    // 1. Hard Cap @ 1.40
    // 2. 1.30-1.40 ONLY if Prob >= 80%
    // 3. Serie B/C Over 1.5 ONLY if Odd > 1.20
    const hardCap = 1.40;
    const isHardLeague = normalizedLega.includes('Serie B') || normalizedLega.includes('Serie C');

    let candidates = allSignals.filter(s => {
        // Rule 1: Hard Cap
        if (s.odd > hardCap) return false;

        // Rule 2: Range 1.30-1.40 requires 80% Prob
        if (s.odd >= 1.30 && s.prob < 80) return false;

        // Rule 3: Hard League Over 1.5 Risk Filter
        if (isHardLeague && s.label === '+1.5' && s.odd <= 1.20) return false;

        return true;
    });

    // Order by PROBABILITY (Marketing-First: Win more, don't care about value)
    candidates.sort((a, b) => b.prob - a.prob);

    if (candidates.length > 0) {
        bestPick = candidates[0];
        console.log(`[Engine] 🔮 Magia Firba Selected: ${bestPick.label} (Prob: ${bestPick.prob}%, Odd: ${bestPick.odd})`);
    } else {
        // Absolute Fallback: lowest odd available among standard signals
        bestPick = [...allSignals].sort((a, b) => a.odd - b.odd)[0];
        console.log(`[Engine] ⚠️ Fallback to Lowest Odd: ${bestPick.label}`);
    }

    // 🔥 Add Trust & Mode Info to output (Already in return object)

    return {
        // Core probabilities
        winHome: sim.winHome,
        draw: sim.draw,
        winAway: sim.winAway,
        dc1X: sim.dc1X,
        dcX2: sim.dcX2,
        dc12: sim.dc12,

        // Intelligence Fields
        expertStats: sim.expertStats,
        rankH: sim.rankH,
        rankA: sim.rankA,
        leagueId: sim.leagueId,
        trustInfo: trustData, // Injected

        // Goal markets
        over15: sim.over15,
        over25: sim.over25,
        under35: sim.under35,
        ht05: sim.ht05,
        btts: sim.btts,
        noGol: sim.noGol,

        // Meta & AI - Calcola quota reale dal tip selezionato
        tipMagiaAI: bestPick.label,
        oddMagiaAI: (() => {
            const tip = bestPick.label;
            // 1X2
            if (tip === '1') return match.quota1 || 1.25;
            if (tip === 'X') return match.quotaX || 1.25;
            if (tip === '2') return match.quota2 || 1.25;
            // Double Chance
            if (tip === '1X') return match.bookmaker1X || match.q1X || 1.25;
            if (tip === 'X2') return match.bookmakerX2 || match.qX2 || 1.25;
            if (tip === '12') return match.bookmaker12 || match.q12 || 1.25;
            // Goals
            if (tip === '+1.5') return match.bookmakerOver15 || 1.25;
            if (tip === '+2.5') return match.bookmakerOver25 || 1.25;
            if (tip === '-3.5') return match.bookmakerUnder35 || 1.25;
            if (tip === '+0.5 HT') return match.bookmakerOver05HT || 1.25;
            // BTTS
            if (tip === 'GG') return match.bookmakerGG || 1.25;
            if (tip === 'NG') return match.bookmakerNG || 1.25;
            return 1.25; // Fallback
        })(),
        confidence: bestPick.prob,
        probMagiaAI: bestPick.prob, // 🆕 NORMALIZZATO
        score: bestPick.prob,
        smartScore: bestPick.prob,   // 🆕 NORMALIZZATO

        // Formato descrittivo per PWA
        pickDescription: `Magia AI rileva alta probabilità per mercato ${bestPick.type}: ${bestPick.label}`,

        // New Advanced metrics
        eloRatingH: sim.eloRatingH,
        eloRatingA: sim.eloRatingA,
        eloDiff: sim.eloDiff,
        motivationBadges: sim.motivationBadges || []
    };
}

// parseTeams moved to js/utils.js

// Export functions
window.calculateStrategyRankings = null; // Will be defined in admin logic, not here
window.engine = {
    poissonProbability: null, // Removed simple Poisson, replaced by Monte Carlo
    analyzeTeamStats,
    calculateScore,
    generateTradingBadge,
    // checkLiquidity removed
    simulateMatch,
    getMagiaStats,
    generateMagiaAI,
    // Trading Strategy Functions
    transformToTradingStrategy,
    createBackOver25Strategy,
    createHTSniperStrategy,
    createLayTheDrawStrategy,
    createSecondHalfSurgeStrategy,
    createUnder35TradingStrategy,
    extractHTProb,
    calculateAllTradingStrategies,
    analyzeDrawRate,
    // NEW: Value Edge calculation
    calculateValueEdge,
    calculateELORatings, // Added calculateELORatings
    parseTeams, // Added parseTeams for consistency
    MIN_VALUE_EDGE: (typeof STRATEGY_CONFIG !== 'undefined' ? STRATEGY_CONFIG.TRADING.MIN_VALUE_EDGE : 3.0),
    // 🔥 NEW v4.4: Dynamic factors and optimal Rho
    calculateDynamicGoalFactors,
    getGoalFactor,
    calculateOptimalRho,
    getDixonColesRho,
    // Expose the global setters for initialization
    initDynamicFactors: (dbCompleto) => {
        DYNAMIC_GOAL_FACTORS = calculateDynamicGoalFactors(dbCompleto);
        OPTIMAL_RHO = calculateOptimalRho(dbCompleto);
        console.log('[Engine v4.4] Dynamic factors initialized:', { goalFactors: DYNAMIC_GOAL_FACTORS, rho: OPTIMAL_RHO });
    }
};
