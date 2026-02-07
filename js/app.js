import { initializeApp } from "https://www.gstatic.com/firebasejs/9.15.0/firebase-app.js";
import { getFirestore, doc, getDoc, setDoc, updateDoc, arrayUnion, arrayRemove, collection, query, where, getDocs, onSnapshot, Timestamp } from "https://www.gstatic.com/firebasejs/9.15.0/firebase-firestore.js";
import { getAuth, signInWithEmailAndPassword, createUserWithEmailAndPassword, onAuthStateChanged, signOut, setPersistence, browserLocalPersistence, sendPasswordResetEmail } from "https://www.gstatic.com/firebasejs/9.15.0/firebase-auth.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/9.15.0/firebase-functions.js";

// Import utility modules (refactored from app.js)
import { normalizeDeep, levenshteinDistance } from './utils/normalize.js';
import { parsePair, getRankingColor, isMatchStale, renderEventIcon, formatDateLong, formatDateShort, getDataHash, DEFAULT_LOGO_BASE64 } from './utils/helpers.js';
import { evaluateTipLocally } from './utils/evaluate.js';

// Expose utilities globally for backward compatibility
window.normalizeDeep = normalizeDeep;
window.levenshteinDistance = levenshteinDistance;
window.parsePair = parsePair;
window.getRankingColor = getRankingColor;
window.isMatchStale = isMatchStale;
window.renderEventIcon = renderEventIcon;
window.formatDateLong = formatDateLong;
window.formatDateShort = formatDateShort;
window.getDataHash = getDataHash;
window.DEFAULT_LOGO_BASE64 = DEFAULT_LOGO_BASE64;
window.evaluateTipLocally = evaluateTipLocally;

// Firebase Config (Configured in init via window.firebaseConfig if present, or defaults)
const firebaseConfig = window.firebaseConfig;
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);
const functions = getFunctions(app);

// Global State
window.db = db;
window.setDoc = setDoc;
window.getDoc = getDoc;
window.doc = doc;
window.collection = collection;
window.query = query;
window.where = where;
window.getDocs = getDocs;
window.currentUser = null;
window.currentUserProfile = null;
window.strategiesData = null;
window.selectedMatches = [];
window.aiKnowledge = {};
window.globalStats = { total: 0, wins: 0, losses: 0, winrate: 0 };

let currentStrategyId = null;
let currentSubFilter = 'all';
let currentSortMode = 'time';

// ANTI-FLICKER CACHE: Remember last rendered data to avoid re-renders
let _lastRenderCache = {
    rankingHash: null,
    myMatchesHash: null,
    tradingHash: null,
    dashboardHash: null
};

// DEBOUNCE: Prevent rapid-fire re-renders
let _liveUpdateDebounceTimer = null;
const DEBOUNCE_MS = 2000; // Aumentato per ridurre flickering


let isRegisterMode = false;
let warningStats = null;
window.tradingFavorites = []; // IDs of favorite trading picks
let currentTradingDate = new Date().toISOString().split('T')[0];
let tradingUnsubscribe = null; // For real-time updates
let strategiesUnsubscribe = null; // For real-time betting updates
let liveHubUnsubscribe = null; // For unified live scores hub
window.liveScoresHub = {}; // Global store for live updates
window.strategyTemplates = {}; // Global store for strategy templates

// 📦 Load Strategy Templates from Firebase (once at app init)
async function loadStrategyTemplates() {
    try {
        const templatesSnap = await getDocs(collection(db, "strategy_templates"));
        templatesSnap.forEach(doc => {
            window.strategyTemplates[doc.id] = doc.data();
        });
        console.log(`[Templates] ✅ Loaded ${Object.keys(window.strategyTemplates).length} strategy templates`);
    } catch (e) {
        console.warn('[Templates] Failed to load from Firebase, using fallback:', e.message);
        // Fallback: Hardcoded templates in case Firebase fails
        window.strategyTemplates = {
            'LAY_THE_DRAW': { id: 'LAY_THE_DRAW', shortId: 'ltd', name: 'Lay The Draw', icon: '🎲', color: 'orange', actionLabel: 'Lay The Draw', defaultTiming: 'Primi 10-15 minuti', defaultEntry: '@ 3.2 - 4.0', defaultExit: '@ 2.20' },
            'BACK_OVER_25': { id: 'BACK_OVER_25', shortId: 'over25', name: 'Back Over 2.5', icon: '⚽', color: 'blue', actionLabel: 'Back Over 2.5 Goals', defaultTiming: 'Pre-match o primi 20 min', defaultEntry: '@ 2.1 - 2.4', defaultExit: '@ 1.70' },
            'SECOND_HALF_SURGE': { id: 'SECOND_HALF_SURGE', shortId: 'over25_2t', name: 'Gol nel 2° Tempo', icon: '🔥', color: 'red', actionLabel: 'Back Over 0.5 2° Tempo', defaultTiming: 'Fine primo tempo', defaultEntry: '@ 1.9 - 2.2', defaultExit: '@ 1.60' },
            'HT_SNIPER': { id: 'HT_SNIPER', shortId: 'ht_sniper', name: 'HT Sniper', icon: '🎯', color: 'purple', actionLabel: 'Back Over 0.5 HT', defaultTiming: 'Minuto 15-20', defaultEntry: '@ 1.7 - 2.0', defaultExit: '@ 1.40' },
            'UNDER_35_SCALPING': { id: 'UNDER_35_SCALPING', shortId: 'scalping', name: 'Scalping U3.5', icon: '⚡', color: 'emerald', actionLabel: 'Back Under 3.5', defaultTiming: 'Dopo il primo gol', defaultEntry: '@ 1.4 - 1.6', defaultExit: '@ 1.20' }
        };
    }
}

const HIGH_LIQUIDITY_LEAGUES = [
    "Serie A", "Serie B", "Premier League", "Championship", "League One",
    "La Liga", "Bundesliga", "Ligue 1", "Eredivisie", "Primeira Liga",
    "Super League", "Bundesliga (AUT)", "Pro League",
    "Champions League", "Europa League", "Conference League",
    "Coppa Italia", "FA Cup", "Copa del Rey"
];

// ==================== NOTIFICATION PRIORITY LOGIC ====================
// Due Anime: Betting vs Trading - prevent duplicate notifications

/**
 * Check if we should send betting-style notifications (result-only) for a match
 * @param {string} matchId - The match ID
 * @returns {boolean} - True if betting notifications should be sent
 */
window.shouldSendBettingNotification = function (matchId) {
    // If match is in tradingFavorites, skip betting notifications (would be duplicate)
    const tradingId = `trading_${matchId.replace(/[^a-z0-9]/gi, '').toLowerCase()}`;
    if ((window.tradingFavorites || []).includes(tradingId) || (window.tradingFavorites || []).includes(matchId)) {
        return false;
    }
    // Only send if in selectedMatches (betting favorites)
    return (window.selectedMatches || []).some(sm => sm.id === matchId);
};

/**
 * Check if we should send full trading notifications (push, goal alerts, stats)
 * @param {string} matchId - The match ID  
 * @returns {boolean} - True if trading notifications should be sent
 */
window.shouldSendTradingNotification = function (matchId) {
    const tradingId = `trading_${matchId.replace(/[^a-z0-9]/gi, '').toLowerCase()}`;
    return (window.tradingFavorites || []).includes(tradingId) || (window.tradingFavorites || []).includes(matchId);
};

/**
 * Get the notification type for a match based on favorites
 * @param {string} matchId - The match ID
 * @returns {'trading'|'betting'|'none'} - The notification type to use
 */
window.getNotificationType = function (matchId) {
    if (window.shouldSendTradingNotification(matchId)) return 'trading';
    if (window.shouldSendBettingNotification(matchId)) return 'betting';
    return 'none';
};

// Auth Persistence
setPersistence(auth, browserLocalPersistence).catch(err => console.error('[Auth] Persistence error:', err));

// Secure Gemini Implementation
window.chatWithGemini = async (payload) => {
    try {
        const chatFn = httpsCallable(functions, 'chat');
        const result = await chatFn({
            contents: payload.contents,
            generationConfig: payload.generationConfig || { temperature: 0.7 }
        });
        return result;
    } catch (error) {
        console.error('[Eugenio] Proxy Error:', error);
        let msg = "Eugenio è stanco (troppe richieste). Riprova tra poco! ☕";
        if (error.code === 'unauthenticated') msg = "Accedi per parlare con Eugenio.";
        alert(msg);
        throw error;
    }
};

// ==================== TRADING 2.0 UTILS ====================
window.calculateGoalCookingPressure = function (stats, minute) {
    if (!stats || !minute || minute < 1) return 0;

    // Use pre-calculated value from backend if available for maximum consistency
    if (stats.pressureValue !== undefined) {
        return Math.round(parseFloat(stats.pressureValue) || 0);
    }

    // --- FALLBACK CALCULATION (If Backend doesn't provide it) ---
    // Extract totals safely
    const homeShots = parsePair(stats.shots?.total || "0 - 0");
    const awayShots = parsePair(stats.shots?.total || "0 - 0"); // BUG in original logic? Assuming total is one string
    // Let's use robust parsing assuming key might be missing
    const getVal = (pair, idx) => {
        if (!pair) return 0;
        const parts = pair.split(' - ').map(n => parseInt(n) || 0);
        return parts[idx] || 0;
    };

    // Total shots
    const tHome = getVal(stats.shots?.total, 0);
    const tAway = getVal(stats.shots?.total, 1);

    // On Goal
    const gHome = getVal(stats.on_goal?.home ? `${stats.on_goal.home} - 0` : null, 0) || getVal(stats.shots?.on_goal, 0);
    const gAway = getVal(stats.on_goal?.away ? `0 - ${stats.on_goal.away}` : null, 1) || getVal(stats.shots?.on_goal, 1);

    // Inside Box (Dangerous)
    const bHome = getVal(stats.shots?.inside_box, 0);
    const bAway = getVal(stats.shots?.inside_box, 1);

    // Corners
    const cHome = getVal(stats.corners?.home ? `${stats.corners.home} - 0` : null, 0) || getVal(stats.corners, 0);
    const cAway = getVal(stats.corners?.away ? `0 - ${stats.corners.away}` : null, 1) || getVal(stats.corners, 1);

    // Dangerous Attacks (if available)
    // const dHome = ...

    const totalActivity = (tHome + tAway) * 1 + (gHome + gAway) * 3 + (bHome + bAway) * 2 + (cHome + cAway) * 1.5;

    // Normalize by time (intensity per minute)
    let intensity = totalActivity / minute;

    // Scale to 0-100 (Arbitrary scaling factor based on "good" game stats)
    // A game with 1 shot/min combined is insanely high pace. 0.5 is decent.
    let pressure = Math.min(100, Math.round((intensity / 0.8) * 100));

    return pressure;
};









window.getLiveTradingAnalysis = async function (matchId) {
    const matchName = matchId.replace('trading_', '').replace(/_/g, ' ');
    const normalizedId = matchId.replace('trading_', '');
    let match = null;


    // 1. Search in Favorites
    if (window.selectedMatches) {
        match = window.selectedMatches.find(m => window.generateUniversalMatchId(m) === matchId);
    }

    // 2. Search in Trading Cache
    if (!match && typeof lastTradingPicksCache !== 'undefined') {
        match = lastTradingPicksCache.find(p => window.getTradingPickId(p.partita) === matchId || p.id === matchId);
    }

    // 3. Search in all Strategies
    if (!match && window.strategiesData) {
        for (const strat of Object.values(window.strategiesData)) {
            if (strat.matches) {
                match = strat.matches.find(m => window.generateUniversalMatchId(m) === matchId);
                if (match) break;
            }
        }
    }

    // 4. Search in Live Hub (NEW)
    if (!match && window.liveScoresHub) {
        match = Object.values(window.liveScoresHub).find(m => m.matchName === matchId || m.fixtureId === matchId);
    }

    if (!match) {
        console.warn(`[eugenio] Match ${matchId} not found in local memory.`);
        alert("Dati match non trovati in memoria. Provo comunque a generare un'analisi basica... 🧞‍♂️");
    }

    // Extract data - handle multiple formats (Trading picks vs Live Hub)
    const elapsed = (match?.elapsed || match?.liveData?.elapsed || match?.minute || '0').toString().replace("'", "");
    const score = match?.score || match?.liveData?.score || match?.risultato || "0-0";
    const status = match?.status || match?.liveData?.status || 'LIVE';
    const stats = match?.liveStats || match?.liveData?.stats || {};

    // Build stats string properly - Resilient Mapping v2.4 (Enhanced Stats)
    const getStat = (obj, keys, def = "0 - 0") => {
        for (const k of keys) {
            if (obj[k] !== undefined && obj[k] !== null && obj[k] !== "" && obj[k] !== "0-0") return obj[k];
        }
        return def;
    };

    const sog = getStat(stats, ["shotsOnGoal", "shots_on_goal", "sog"]);
    const totalShots = getStat(stats, ["totalShots", "total_shots"]);
    const shotsInside = getStat(stats, ["shotsInside", "shots_inside", "shotsInsideBox"]);
    const corners = getStat(stats, ["corners", "corner_kicks"]);
    const pos = getStat(stats, ["possession", "ball_possession", "palla"], "50% - 50%");
    const xg = stats.xg ? `${stats.xg.home?.toFixed(2) || stats.xg.home || 0} - ${stats.xg.away?.toFixed(2) || stats.xg.away || 0}` : "0.0 - 0.0";

    // 🏛️ AUTHORITY CHECK (Socio Protocol)
    const auth = window.resolveMatchAuthority(match);
    const authStatus = auth.isElite ? (auth.isMagia ? "[MASSIMA CONFIDENZA] ELITE GOLD + CONSENSO MAGIA AI 🥇🪄" : "ELITE GOLD 🥇") : (auth.isMagia ? "SCELTA MAGICA 🪄" : "STANDARD 🔵");

    // 🔬 HISTORICAL & PRE-MATCH DATA
    const eloInfo = (match?.elo_home && match?.elo_away) ? `\n- Forza (ELO): ${match.elo_home} (H) vs ${match.elo_away} (A) | Gap: ${Math.abs(match.elo_home - match.elo_away)}` : '';
    const ranking = (match?.rank_home || match?.rank_away) ? `\n- Classifica: Pos. ${match.rank_home || '?'} (H) vs Pos. ${match.rank_away || '?'} (A)` : '';
    const motivation = match?.motivation ? `\n- Note Motivazionali: ${match.motivation}` : '';

    // Build events summary if available
    const events = match?.events || [];
    let eventsText = '';
    if (events.length > 0) {
        const goals = events.filter(e => e.type?.toUpperCase().includes('GOAL'));
        const cards = events.filter(e => e.type?.toUpperCase().includes('CARD'));
        eventsText = `\n- Timeline Live: ${goals.length} gol, ${cards.length} cartellini segnalati.`;
    }

    // 🔍 CARD CONTEXT DETECTION (Trading vs Betting)
    const isTradingCard = !!(match?.hasTradingStrategy || match?.entryRange || match?.strategy?.toLowerCase().includes('lay') || match?.strategy?.toLowerCase().includes('back'));
    const cardType = isTradingCard ? "TRADING CARD (Exchange Logic)" : "BETTING CARD (Standard Selection)";

    // 📦 EXTRA TRADING DATA (If available)
    let tradingDetails = '';
    if (isTradingCard) {
        const t = window.resolveTradingData ? window.resolveTradingData(match) : {};
        tradingDetails = `
**PARAMETRI OPERATIVI CARD:**
- Ingresso: ${t.entry || match.entryRange || 'N/A'}
- Uscita: ${t.exit || match.exitTarget || 'N/A'}
- Timing: ${t.timing || match.timing || 'N/A'}`;
    }

    const visibleQuestion = `euGENIO 🧞‍♂️, fammi un'analisi live di questo match: **${matchName}**`;
    const userName = (typeof getUserName === 'function') ? getUserName() : "Socio";

    const hiddenDetailedPrompt = `Sei euGENIO, analista professionista di betting e trading sportivo.

**CONTESTO:** Stai analizzando una **${cardType}**.

**DATI TECNICI DEL MATCH:**
- Match: ${matchName}
- Status Autorità: ${authStatus}${eloInfo}${ranking}${motivation}
- Minuto: ${elapsed}' | Risultato: ${score} | Status: ${status}
- Pressione Gol: ${stats.pressureValue || 'N/A'}%
- Strategia/Tip: ${match?.strategy || match?.label || 'Monitoraggio'} | ${match?.tip || ''}${tradingDetails}
- xG: ${xg} | SOG: ${sog} | Tiri Totali: ${totalShots}
- Tiri in Area: ${shotsInside} | Corner: ${corners} | Possesso: ${pos}${eventsText}

**FILOSOFIA SOCIO (ENGINE v5.0):**
- Siamo nemici dei "Cigni Neri" (quote < 1.25).
- Ogni Consiglio (Parlay) rispetta le nostre soglie di rischio.
- Sii critico se i dati non supportano il pronostico della card.

**STILE DI RISPOSTA:**
1. Inizia con: "Ok ${userName}:"
2. **Vai DRITTO AL PUNTO**. Evita preamboli tipo "Analizzando i dati..." o "Sulla base delle statistiche...".
3. Usa i dati (xG, Tiri in Area, Corner, SOG) per la tua analisi.
4. **VERDICT CHIARO**: Entra/Esci/Attendi/Cashout + motivazione.
5. **COMMENTO CARD**: Valuta se l'Ingresso/Uscita previsto sulla card è ancora valido o se bisogna cambiare piano.
6. Sii professionale ma anche **coinvolgente**. Sei un Socio esperto, non un robot.
7. Libertà di espressione: parla quanto serve, ma non dilungarti se non necessario.`;




    // Execute with Hidden Logic v2.3
    if (typeof window.askEugenioDetailed === 'function') {
        window.askEugenioDetailed(visibleQuestion, hiddenDetailedPrompt);
    } else {
        // Fallback if component not ready
        alert("euGENIO si sta preparando... riprova tra un istante!");
    }
};

window.resetPassword = async function () {
    const email = prompt('Inserisci la tua email per recuperare la password:');
    if (!email) return;

    try {
        await sendPasswordResetEmail(auth, email);
        alert('✅ Email inviata! Controlla la tua casella di posta per reimpostare la password.');
    } catch (error) {
        console.error('[Auth] Password reset error:', error);
        alert('⚠️ Errore: ' + (error.message || 'Email non valida'));
    }
};

// Helper: Rendering icone eventi live (Trading 2.0)


// ==================== LOCAL OUTCOME EVALUATOR (Fallback for non-API matches) ====================


// ==================== UNIVERSAL CARD RENDERER ====================
// Helper per normalizzare i dati di trading (Template + Dati Dinamici)
window.resolveTradingData = function (match) {
    // 📦 SIMPLIFIED: Use only .strategy (single source of truth)
    const stratId = match.strategy;
    const template = window.strategyTemplates?.[stratId] || window.strategyTemplates?.[stratId?.toUpperCase()];

    if (template) {
        // Format Entry Range from dynamic data
        let entryLabel = template.defaultEntry;
        if (match.entryRange) {
            if (Array.isArray(match.entryRange)) {
                entryLabel = `@ ${match.entryRange.join(' - ')}`;
            } else if (typeof match.entryRange === 'object' && match.entryRange.range) {
                entryLabel = Array.isArray(match.entryRange.range)
                    ? `@ ${match.entryRange.range.join(' - ')}`
                    : `@ ${match.entryRange.range}`;
            } else {
                entryLabel = `@ ${match.entryRange}`;
            }
        }

        // Format Exit Target from dynamic data
        let exitLabel = template.defaultExit;
        if (match.exitTarget) {
            if (typeof match.exitTarget === 'object' && match.exitTarget.target) {
                exitLabel = typeof match.exitTarget.target === 'number'
                    ? `@ ${match.exitTarget.target.toFixed(2)}`
                    : `@ ${match.exitTarget.target}`;
            } else if (typeof match.exitTarget === 'number') {
                exitLabel = `@ ${match.exitTarget.toFixed(2)}`;
            } else {
                exitLabel = `@ ${match.exitTarget}`;
            }
        }

        const timing = template.defaultTiming;
        const action = template.actionLabel || template.name;

        return {
            action: action,
            entry: entryLabel,
            exit: exitLabel,
            timing: timing,
            stopLoss: 'Dinamico',
            reasoning: match.reasoning || null,
            confidence: match.confidence || 0,
            icon: template.icon,
            color: template.color,
            fullLabel: `${action} | ${timing} → ${exitLabel}`
        };
    }

    // 🔄 LEGACY FORMAT: Handle old tradingInstruction object
    const raw = match.tradingInstruction;

    if (!raw) {
        return {
            action: 'Monitoraggio Attivo',
            entry: match.quota ? `@ ${match.quota}` : 'Dinamico',
            exit: 'Cash-out Live',
            timing: 'In corso...',
            stopLoss: 'Dinamico',
            fullLabel: `Monitoraggio attivo per ${match.strategy || 'Trading'}`
        };
    }

    if (typeof raw === 'string') {
        const parts = raw.split('|').map(s => s.trim());
        return {
            action: parts[0] || raw,
            entry: match.quota ? `@ ${match.quota}` : 'Dinamico',
            exit: 'Cash-out Live',
            timing: parts[1] || 'Live',
            stopLoss: 'Dinamico',
            fullLabel: raw
        };
    }

    const action = raw.action || match.tip || 'TRADING';
    const entryObj = raw.entry || {};
    const exitObj = raw.exit || {};
    const slObj = raw.stopLoss || {};

    let entryLabel = '';
    if (Array.isArray(entryObj.range)) entryLabel = `@ ${entryObj.range.join(' - ')}`;
    else if (entryObj.range) entryLabel = `@ ${entryObj.range}`;
    else entryLabel = match.quota ? `@ ${match.quota}` : 'Dinamica';

    let exitLabel = exitObj.target || 'Cash-out';
    if (typeof exitLabel === 'number') exitLabel = `Target @ ${exitLabel.toFixed(2)}`;

    const timing = entryObj.timing || raw.timing || 'Live';
    const stopLoss = slObj.trigger ? `Trigger @ ${slObj.trigger}` : (slObj.timing || 'Dinamico');

    return {
        action: action,
        entry: entryLabel,
        exit: exitLabel,
        timing: timing,
        stopLoss: stopLoss,
        fullLabel: `${action} | ${timing} → ${exitLabel}`
    };
};

// 🏆 HELPER: Identifica se un match è un "Trading Pick" usando fixtureId (ID univoco API-Football)
window.isTradingPick = function (match) {
    if (!match) return false;

    const picks = window.lastTradingPicksCache || [];
    if (picks.length === 0) return match.isTrading || false;

    // 1. PRIMARY: Match by fixtureId (most reliable)
    if (match.fixtureId) {
        const fId = String(match.fixtureId);
        const foundByFixture = picks.some(p => String(p.fixtureId || '') === fId);
        if (foundByFixture) return true;
    }

    // 2. FALLBACK: Exact partita match (only if fixtureId not available)
    if (match.partita) {
        const foundByName = picks.some(p => p.partita === match.partita);
        if (foundByName) return true;
    }

    // 3. Check explicit trading flags or strategies
    const tradingStrats = ['LAY_THE_DRAW', 'LAY_DRAW', 'BACK_OVER_25', 'HT_SNIPER', 'SECOND_HALF_SURGE', 'UNDER_35_SCALPING', 'TRADING'];
    return tradingStrats.includes(match.strategy) || match.isTrading === true;
};

window.createUniversalCard = function (match, index, stratId, options = {}) {
    console.log(`[CardDebug] Rendering ${match.partita || 'Unknown'} (Strat: ${stratId}, Options: ${JSON.stringify(options)})`);

    // ... rest of the function ...
    // 0. LIVE HUB SYNC: Check if we have real-time score/status for this match-tip
    const mName = match.partita || "";
    // CRITICAL FIX: Always use the action from the original object if it exists
    const mTip = (match.tradingInstruction && typeof match.tradingInstruction === 'object' && match.tradingInstruction.action)
        ? match.tradingInstruction.action
        : (match.tip || "");

    // DEBUG: Initial State Check for Bhayangkara (REMOVED)
    // DEEP NORMALIZATION (Same as Backend)
    // ID-PURE NORMALIZATION (Swiss consistency)
    const normalizeDeep = (str) => {
        if (!str) return "";
        return str.toLowerCase()
            .normalize("NFD").replace(/[\u0300-\u036f]/g, "") // Remove accents
            .replace(/[^a-z0-9]/g, "")
            .replace(/(.)\1+/g, "$1");
    };

    const mKey = normalizeDeep(mName);
    const tKey = normalizeDeep(mTip);

    // ID-PURE PROTOCOL: Use fixtureId-based Hub key exclusively. 🇨🇭
    if (!match.fixtureId) {
        console.warn(`[LiveHub] ⚠️ Missing fixtureId for ${mName}. Sync disabled.`);
    }
    // 🛡️ PROTOCOLLO SOCIO ID-PURE 🇨🇭: Cerchiamo i dati live tramite ID tecnico
    let liveHubData = match._liveHubRef;
    if (!liveHubData && match.fixtureId) {
        const targetId = String(match.fixtureId);

        // 1. Cerchiamo nel Hub globale (Chiave diretta o scansione valori)
        // Questo garantisce che se il server sta monitorando il match, l'app lo trovi SEMPRE.
        liveHubData = window.liveScoresHub[targetId] ||
            Object.values(window.liveScoresHub).find(h => String(h.fixtureId) === targetId);

        if (liveHubData) {
            console.log(`[LiveSync] 🎯 Match "${mName}" agganciato tramite ID: ${targetId}`);
        }
    }

    // Calcolo stato temporale (Protocollo Timezone 🇮🇹)
    const matchDate = match.data || new Date().toISOString().split('T')[0];
    const matchTime = match.ora || match.api_time || '00:00';

    // Priorità al kickoffTimestamp (UTC) salvato, altrimenti fallback (interpretato come locale)
    const kickoffTime = match.kickoffTimestamp ? new Date(match.kickoffTimestamp) : new Date(`${matchDate}T${matchTime}:00`);

    // ID-PURE Protocol: NO fallbacks allowed. 🛡️
    // If not found by fixtureId above, we don't try fuzzy or exactly matching by name.
    // This forces precision and helps identify missing fixtureIds in Step 1.

    // DEBUG rimosso - causava spam nella console


    if (liveHubData) {
        // 🏛️ RICALCOLO ESITO (Se la Tip nel Hub differisce dalla Tip della Card)
        // Se il server monitora "Over 2.5" ma la card è "Under 3.5", usiamo lo score live 
        // ma ricalcoliamo il VINTO/PERSO localmente per non dare info sbagliate.
        let finalEvaluation = liveHubData.evaluation;
        const cardTip = mTip.toUpperCase().replace(/\s/g, '');
        const hubTip = (liveHubData.tip || "").toUpperCase().replace(/\s/g, '');

        if (hubTip !== cardTip && liveHubData.score) {
            const localEval = window.evaluateTipLocally ? window.evaluateTipLocally(mTip, liveHubData.score) : null;
            if (localEval) finalEvaluation = localEval;
        }

        match = {
            ...match,
            risultato: liveHubData.score,
            status: liveHubData.status,
            minute: liveHubData.elapsed,
            esito: finalEvaluation,
            liveData: {
                ...match.liveData,
                score: liveHubData.score,
                elapsed: liveHubData.elapsed,
                status: liveHubData.status
            },
            liveStats: liveHubData.liveStats || match.liveStats,
            events: liveHubData.events || match.events,
            source: liveHubData.source || match.source,
            isLiveSync: true
        };

        // 🩺 PROTOCOLLO 130min: Se il match è al 90° e il tempo previsto è passato, è FINITO.
        const elapsedMinute = parseInt(liveHubData.elapsed) || 0;

        if (elapsedMinute >= 90 && match.status !== 'FT' && match.status !== 'AET' && match.status !== 'PEN') {
            const matchTimeStr = match.ora || '00:00';
            const matchDateStr = match.data || new Date().toISOString().split('T')[0];

            // Protocollo Timezone: Use kickoffTimestamp for expected end time calculation
            const kickoff = match.kickoffTimestamp ? new Date(match.kickoffTimestamp) : new Date(`${matchDateStr}T${matchTimeStr}:00`);
            const expectedEndTime = kickoff.getTime() + (130 * 60 * 1000); // kickoff + 2h10m

            if (Date.now() > expectedEndTime) {
                console.log(`[Auto-FT] ⏱️ Match "${mName}" at ${elapsedMinute}' past expected end - forcing FT`);
                match.status = 'FT';
            }
        }

    }
    else if (match.risultato && match.risultato.includes('-') && !match.esito) {
        // FALLBACK: Match has a result in local data but NOT in Hub AND NOT in permanent esito
        // FIX: For Magia AI, use the AI tip if available, otherwise standard tip
        const evalTip = match.magicStats?.tipMagiaAI || mTip;
        const localEsito = evaluateTipLocally(evalTip, match.risultato);

        // DEBUG: Trace local evaluation
        if (mName.toLowerCase().includes('bhayangkara')) {
            console.log(`[DebugColor] Match: ${mName}`);
            console.log(`[DebugColor] Tip used: "${evalTip}" (orig: "${mTip}")`);
            console.log(`[DebugColor] Result: "${match.risultato}"`);
            console.log(`[DebugColor] Evaluated Local Esito: ${localEsito}`);
        }

        if (localEsito) {
            match = { ...match, esito: localEsito, status: 'FT', isNotMonitored: true };
            if (mName.toLowerCase().includes('bhayangkara')) console.log(`[DebugColor] FORCED STATUS TO FT. New Status: ${match.status}`);
        } else {
            if (mName.toLowerCase().includes('bhayangkara')) console.log(`[DebugColor] Evaluation Failed (returned null)`);
        }
    }
    else if (!liveHubData && !match.risultato) {
        // IMPORTANTE: Solo le partite TERMINATE senza dati live sono "non monitorate"
        // Le partite FUTURE rimangono monitorate (mostrano "IN ATTESA")
        const isFinished = match.status && ['FT', 'AET', 'PEN', 'CANC', 'PST', 'ABD'].includes(match.status);
        if (isFinished) {
            match = { ...match, isNotMonitored: true };
        }
        // Altrimenti: partita futura o in corso, rimane monitorata (sarà "IN ATTESA" o mostrerà dati live)
    }

    // Detect Precise AI Type
    const isMagiaAI = match.isMagiaAI || stratId === 'magia_ai';
    const isSpecialAI = match.isSpecialAI || stratId === '___magia_ai';
    const isAIPick = isMagiaAI || isSpecialAI;
    const isMagia = stratId === 'magia_ai';

    // 🏆 REGOLA D'ORO (Socio's Protocol): Il settore di salvataggio decide il tipo.
    // Se è nel Trading Box (Hub source=TRADING), card ricca. Altrimenti card normale.
    let isTrading = window.isTradingPick(match) || options.isTrading;
    if (liveHubData && liveHubData.source) {
        isTrading = (liveHubData.source === 'TRADING');
    }

    // 🏆 CUP DETECTION (Socio's Protocol): Hide rankings for Cups/Finals
    const cupKeywords = ['cup', 'coppa', 'trofeo', 'fa cup', 'copa', 'final', 'supercup', 'supercoppa', 'super cup', 'qualifiers', 'play-off', 'friendlies', 'friendly', 'international', 'spareggio'];
    const cupIds = [1, 2, 3, 4, 6, 7, 9, 45, 48, 137, 143, 529, 66, 848];
    const isCupMatch = cupIds.includes(parseInt(match.leagueId)) || (cupKeywords.some(k => (match.lega || '').toLowerCase().includes(k)) && !((match.lega || '').toLowerCase().includes('league')));


    console.log(`[CardDebug] ${match.partita}: isCup=${isCupMatch}, rankH=${match.rankH}, expertStats=${!!match.expertStats}`);

    // 🏆 UNIFIED ID (FixtureID Mantra)
    const matchId = window.getMantraId(match);

    // Acceso se presente in QUALSIASI delle liste (per ora manteniamo le liste distinte 
    // ma le cerchiamo entrambe per sincronia visiva)
    const isFlagged = (window.tradingFavorites || []).includes(matchId) ||
        (window.selectedMatches || []).some(sm => window.getMantraId(sm) === matchId);

    // 🧪 Confidence fallback to prevent NaN
    let rankingValue = 0;
    if (typeof match.confidence === 'number' && !isNaN(match.confidence)) {
        rankingValue = Math.round(match.confidence);
    } else if (typeof match.score === 'number' && !isNaN(match.score)) {
        rankingValue = Math.round(match.score);
    }
    const rankingColor = getRankingColor(rankingValue);
    const rankingBadgeHTML = rankingValue > 0 ? `<span class="bg-${rankingColor} text-black px-2 py-0.5 rounded-full text-xs font-black ml-2 shadow-sm border border-black/10 transition-transform hover:scale-110">${rankingValue}</span>` : '';

    // Style Configuration
    let headerClass = 'bg-gradient-to-r from-blue-900 via-indigo-900 to-blue-950';
    let headerIcon = '<i class="fa-solid fa-futbol"></i>';
    let headerTitle = 'Analisi Match';

    if (isMagia) {
        headerClass = 'bg-slate-100 border-b border-slate-200';
        headerIcon = '<i class="fa-solid fa-microchip text-indigo-500"></i>';
        headerTitle = 'Magia AI Scanner';
    } else if (isTrading) {
        switch (match.strategy) {
            case 'BACK_OVER_25':
                headerClass = 'bg-gradient-to-r from-purple-600 to-blue-600';
                headerIcon = '📊';
                headerTitle = 'Trading: BACK OVER 2.5';
                break;
            case 'LAY_THE_DRAW':
            case 'LAY_DRAW':
                headerClass = 'bg-gradient-to-r from-orange-500 to-red-500';
                headerIcon = '🎯';
                headerTitle = 'Trading: LAY THE DRAW';
                break;
            case 'HT_SNIPER':
                headerClass = 'bg-gradient-to-r from-red-600 to-rose-700 animate-pulse';
                headerIcon = '🎯';
                headerTitle = 'HT SNIPER';
                break;
            case 'SECOND_HALF_SURGE':
                headerClass = 'bg-gradient-to-r from-orange-600 to-amber-700';
                headerIcon = '🔥';
                headerTitle = '2ND HALF SURGE';
                break;
            case 'UNDER_35_SCALPING':
                headerClass = 'bg-gradient-to-r from-emerald-600 to-teal-700';
                headerIcon = '🛡️';
                headerTitle = 'Trading: UNDER SCALPING';
                break;
            default:
                headerClass = 'bg-gradient-to-r from-indigo-600 to-blue-700';
                headerIcon = '📈';
                headerTitle = 'Trading Sportivo';
        }
    }

    const card = document.createElement('div');
    // Color coding based on result (DARKER/VIVID colors) - ONLY for FINISHED matches
    let esitoClass = '';
    let finalEsito = (match.esito || "").toUpperCase(); // Changed to `let`

    // STANDARD LOGIC (Clean): Status MUST be FT/AET/PEN
    const isFinished = match.status === 'FT' || match.status === 'AET' || match.status === 'PEN';

    // --- 🏛️ AUTHORITY PROTOCOL (Swiss Precise Selection) ---
    const mAuth = window.resolveMatchAuthority(match);
    let resolvedTip = mAuth.tip;
    let resolvedQuota = mAuth.quota;
    let resolvedProb = mAuth.prob;

    if (isFinished || liveHubData?.status === 'FT') {
        if (!finalEsito && match.risultato && (resolvedTip && resolvedTip !== '-')) {
            // JIT Calculation: Use established resolvedTip as single source of truth
            const parts = match.risultato.split('-').map(s => parseInt(s.trim()));
            if (parts.length === 2) {
                const [h, a] = parts;
                const tot = h + a;
                const t = resolvedTip.toUpperCase().replace(/\s/g, '');

                let calc = null;
                if (t === '1') calc = h > a ? 'VINTO' : 'PERSO';
                else if (t === 'X') calc = h === a ? 'VINTO' : 'PERSO';
                else if (t === '2') calc = a > h ? 'VINTO' : 'PERSO';
                else if (t === '1X') calc = h >= a ? 'VINTO' : 'PERSO';
                else if (t === 'X2') calc = a >= h ? 'VINTO' : 'PERSO';
                else if (t === '12') calc = h !== a ? 'VINTO' : 'PERSO';
                else if (t === 'GG' || t === 'GOL' || t === 'BTTS' || t === 'YES') calc = (h > 0 && a > 0) ? 'VINTO' : 'PERSO';
                else if (t === 'NG' || t === 'NOGOL' || t === 'NO') calc = (h === 0 || a === 0) ? 'VINTO' : 'PERSO';
                else if (t.includes('OVER') || t.includes('+')) {
                    const thr = parseFloat(t.replace(/[^\d.]/g, ''));
                    calc = tot > thr ? 'VINTO' : 'PERSO';
                } else if (t.includes('UNDER') || t.includes('-')) {
                    const thr = parseFloat(t.replace(/[^\d.]/g, ''));
                    calc = tot < thr ? 'VINTO' : 'PERSO';
                } else if (t.includes('LAYTHEDRAW') || t.includes('LAYDRAW')) {
                    calc = h !== a ? 'VINTO' : 'PERSO';
                }

                if (calc) {
                    finalEsito = calc; // Apply outcome to color the background
                }
            }
        }

        const checkEsito = (finalEsito || "").toUpperCase();

        if (checkEsito === 'WIN' || checkEsito === 'VINTO') {
            esitoClass = 'bg-gradient-to-b from-green-200 to-green-300 border-green-400 ring-2 ring-green-300';
        } else if (checkEsito === 'LOSE' || checkEsito === 'PERSO') {
            esitoClass = 'bg-gradient-to-b from-red-200 to-red-300 border-red-400 ring-2 ring-red-300';
        } else if (checkEsito === 'CASH_OUT' || checkEsito === 'CASHOUT') {
            esitoClass = 'bg-gradient-to-b from-yellow-200 to-yellow-300 border-yellow-400 ring-2 ring-yellow-300';
        } else if (checkEsito === 'STOP_LOSS') {
            esitoClass = 'bg-gradient-to-b from-rose-300 to-rose-400 border-rose-500 ring-2 ring-rose-400';
        } else if (checkEsito === 'PUSH' || checkEsito === 'VOID' || checkEsito === 'RIMBORSATO') {
            esitoClass = 'bg-gradient-to-b from-gray-200 to-gray-300 border-gray-400 ring-2 ring-gray-300';
        }
    }

    const aiBrandingClass = isAIPick ? 'ring-2 ring-purple-600 shadow-[0_0_15px_rgba(147,51,234,0.3)]' : '';
    card.className = `match-card rounded-3xl shadow-2xl fade-in mb-4 overflow-hidden relative transition-all duration-300 ${isMagia ? 'magia-scanner-card' : 'glass-card-premium'} ${esitoClass} ${aiBrandingClass}`;

    // Identificazione visiva discreta per trading card (bordino emerald)
    if (isTrading) card.classList.add('border-l-4', 'border-emerald-500');

    // --- Footer ---
    // Moved Flag Button to Header

    // Header Generation with Star
    // FIX: Star visibility on light backgrounds (Magia AI) vs Dark backgrounds
    const isLightHeader = isMagia;
    const starInactiveClass = isLightHeader ? 'text-slate-300' : 'text-white/60';
    const starActiveClass = isLightHeader ? 'text-yellow-500' : 'text-yellow-300';
    const btnHoverClass = isLightHeader ? 'hover:text-yellow-500' : 'hover:text-yellow-300';

    const flagBtnHTML = `<button data-match-id="${matchId}" class="flag-btn ${isFlagged ? 'flagged' : ''} ${btnHoverClass} transition text-xl ml-2" onclick='toggleMatchFavorite(${JSON.stringify(match).replace(/'/g, "&apos;")}); event.stopPropagation();'>
             <i class="${isFlagged ? `fa-solid fa-star ${starActiveClass} drop-shadow-md` : `fa-regular fa-star ${starInactiveClass}`}"></i>
           </button>`;


    let headerHTML = '';
    const elapsed = match.liveData?.elapsed || match.liveData?.minute || 0;
    const isLive = elapsed > 0;
    const isRealTimeMatch = isTrading || isMagia || (match.lega && HIGH_LIQUIDITY_LEAGUES.includes(match.lega));

    if (isMagia) {
        headerHTML = `
            <div class="p-3 flex justify-between items-center text-slate-800 relative border-b border-slate-200 bg-white">
                <div class="flex items-center gap-2">
                    <div class="w-6 h-6 rounded bg-indigo-50 flex items-center justify-center border border-indigo-100">
                        <i class="fa-solid fa-microchip text-indigo-500 text-xs"></i>
                    </div>
                    <span class="font-black text-xs tracking-widest uppercase text-slate-500">MAGIA AI SCANNER</span>
                    ${!isCupMatch ? `<span class="bg-indigo-500 text-white px-1.5 py-0.5 rounded text-xs font-black shadow-sm">${rankingValue}</span>` : ''}
                </div>
                <div class="flex items-center gap-2">
                    ${match.ora ? `<div class="text-slate-400 text-xs font-bold flex items-center gap-1"><i class="fa-regular fa-clock"></i> ${match.ora}</div>` : ''}
                    ${flagBtnHTML}
                </div>
            </div>
        `;
    } else {
        headerHTML = `
            <div class="${headerClass} p-3 flex justify-between items-center text-white relative">
                <div class="flex items-center gap-2">
                    ${headerIcon}
                    <span class="font-bold text-sm tracking-wider uppercase">${headerTitle}</span>
                    ${!isCupMatch ? rankingBadgeHTML : ''}
                </div>
                <div class="flex items-center gap-2">
                    ${match.ora ? `<span class="text-xs bg-white/20 px-2 py-0.5 rounded font-bold">⏰ ${match.ora}</span>` : ''}
                    ${flagBtnHTML}
                </div>
                ${isLive && isTrading ? `
                <div class="absolute bottom-0 left-0 h-1 bg-white/10 w-full overflow-hidden">
                    <div class="h-full bg-yellow-400 goal-cooking-bar" style="width: ${calculateGoalCookingPressure(match.liveStats, elapsed)}%"></div>
                </div>` : ''}
            </div>
        `;
    }

    // --- Teams & Score (Modern V2 Layout with Defined Borders) ---
    const currentScore = match.liveData?.score || (match.liveData ? `${match.liveData.homeScore || 0} - ${match.liveData.awayScore || 0}` : (match.risultato || "0-0"));
    const [homeScore, awayScore] = currentScore.split('-').map(s => s.trim());
    const isPlayed = match.risultato && match.risultato.includes('-');

    // Status Badge Logic
    let statusText = '';
    let statusClass = 'hidden';

    if (match.status === 'HT' || (match.risultato && match.risultato.includes('HT'))) {
        statusText = 'HT';
        statusClass = 'bg-slate-200 text-slate-600';
    } else if (match.status === 'FT' || match.status === 'AET' || match.status === 'PEN' || (match.risultato && match.risultato.includes('FT'))) {
        statusText = 'FINALE';
        statusClass = 'bg-slate-800 text-white';
    } else if (isLive && !match.isNotMonitored) {
        statusText = `${elapsed}'`;
        statusClass = 'bg-red-500 text-white animate-pulse';
    } else if (match.ora) {
        statusText = match.ora;
        statusClass = 'bg-blue-50 text-blue-600 border border-blue-100';
    }

    // --- Intelligence Data (Ranks & Badges) ---
    const rankH = match.rankH || match.magicStats?.rankH || null;
    const rankA = match.rankA || match.magicStats?.rankA || null;
    const mBadges = match.motivationBadges || match.magicStats?.motivationBadges || [];

    let badgesHTML = '';
    if (mBadges && mBadges.length > 0) {
        badgesHTML = `
            <div class="flex flex-wrap justify-center gap-1.5 mt-1 px-4 mb-2">
                ${mBadges.map(b => {
            let colorClass = 'bg-slate-100 text-slate-600 border-slate-200';
            if (b.type === 'SALVEZZA') colorClass = 'bg-red-50 text-red-600 border-red-100';
            if (b.type === 'TITOLO') colorClass = 'bg-amber-50 text-amber-600 border-amber-100';
            if (b.type === 'SCONTRO') colorClass = 'bg-indigo-50 text-indigo-600 border-indigo-100';

            return `<span class="px-2 py-0.5 rounded-full text-[9px] font-black border ${colorClass} uppercase tracking-tighter shadow-sm">${b.label}</span>`;
        }).join('')}
            </div>
        `;
    }

    // --- EXPERT STATS SECTION (STORICO SQUADRE) ---
    const expertStats = match.expertStats || null;
    let expertStatsHTML = '';

    if (expertStats) {
        const renderForm = (form) => {
            if (!form || form.length === 0) return '<span class="text-[10px] text-slate-300">Nessun dato</span>';
            return form.map(f => {
                let colorClass = 'bg-slate-300';
                if (f === 'W') colorClass = 'bg-green-500';
                if (f === 'D') colorClass = 'bg-amber-400';
                if (f === 'L') colorClass = 'bg-red-500';
                return `<span class="w-4 h-4 rounded-sm ${colorClass} text-[10px] font-black text-white flex items-center justify-center uppercase">${f}</span>`;
            }).join('');
        };

        console.log(`[StatsDebug] Rendering expertStats for ${match.partita}, tip=${resolvedTip}`);

        const tipUpper = (resolvedTip || '').toUpperCase();
        const isGoalTip = tipUpper.includes('OVER') || tipUpper.includes('UNDER') || tipUpper.includes('GOAL') || tipUpper.includes('GOL') || tipUpper.includes('+') || tipUpper.includes('.') || tipUpper.includes('1.5') || tipUpper.includes('2.5');
        const isOutcomeTip = !isGoalTip; // Fallback for 1X2, DC, etc.

        expertStatsHTML = `
            <div class="px-4 mb-4 mt-2">
                <div class="bg-indigo-50/50 rounded-xl p-3 border border-indigo-100 flex flex-col gap-2 relative overflow-hidden">
                    <div class="absolute -top-1 -right-1 text-[24px] text-indigo-100 opacity-20 pointer-events-none">
                        <i class="fa-solid fa-chart-line"></i>
                    </div>
                    <div class="text-[10px] font-black text-indigo-400 uppercase tracking-widest border-b border-indigo-100 pb-1 mb-1 flex items-center gap-1.5">
                        <i class="fa-solid fa-microchip"></i> Statistiche AI: ${isGoalTip ? 'Gol' : 'Forma'}
                    </div>
                    <div class="flex justify-between items-start gap-4">
                        <!-- Home Team Stats -->
                        <div class="flex-1">
                            ${isOutcomeTip ? `
                            <div class="flex items-center gap-1 mb-1.5">
                                ${renderForm(expertStats.home.form)}
                            </div>` : ''}
                            
                            ${isGoalTip ? `
                            <div class="text-[10px] text-slate-500">
                                ⚽ Segnati: <span class="font-bold text-slate-800">${(expertStats.home.avgScored || 0).toFixed(1)}</span>
                            </div>
                            <div class="text-[10px] text-slate-500">
                                🥅 Subiti: <span class="font-bold text-slate-800">${(expertStats.home.avgConceded || 0).toFixed(1)}</span>
                            </div>` : ''}
                        </div>

                        <div class="w-px h-10 bg-indigo-100 self-center"></div>

                        <!-- Away Team Stats -->
                        <div class="flex-1 text-right">
                            ${isOutcomeTip ? `
                            <div class="flex items-center justify-end gap-1 mb-1.5">
                                ${renderForm(expertStats.away.form)}
                            </div>` : ''}

                            ${isGoalTip ? `
                            <div class="text-[10px] text-slate-500">
                                <span class="font-bold text-slate-800">${(expertStats.away.avgScored || 0).toFixed(1)}</span> :Segnati ⚽
                            </div>
                            <div class="text-[10px] text-slate-500">
                                <span class="font-bold text-slate-800">${(expertStats.away.avgConceded || 0).toFixed(1)}</span> :Subiti 🥅
                            </div>` : ''}
                        </div>
                    </div>
                </div>
            </div>
        `;
    }

    const scoreboardHTML = `
        <div class="py-4 px-3 flex justify-between items-center relative">
            <!-- Home Team -->
            <div class="w-[38%] text-right pr-2 flex flex-col justify-center">
                <span class="text-[13px] font-bold text-slate-800 leading-tight line-clamp-2 uppercase tracking-tight">
                    ${(match.partita || ' - ').split('-')[0].trim()}
                </span>
                ${(rankH && !isCupMatch) ? `<span class="text-[10px] text-indigo-500 font-black mt-0.5">Pos. ${rankH}°</span>` : ''}
            </div>

            <!-- Scoreboard Box (Central Feature) -->
            <div class="w-[24%] flex flex-col items-center justify-center relative z-10">
                <div class="bg-white border border-slate-200 shadow-sm rounded-xl px-2 py-2 min-w-[75px] flex justify-center items-center relative">
                    ${isPlayed || isLive ?
            `<span class="text-2xl font-black text-slate-900 tracking-tight font-mono">${homeScore}<span class="text-slate-300 mx-0.5">-</span>${awayScore}</span>`
            : `<span class="text-lg font-bold text-slate-400">VS</span>`
        }
                    
                    ${statusText ?
            `<span class="absolute -top-2.5 left-1/2 -translate-x-1/2 ${statusClass} px-2 py-0.5 rounded-md text-[11px] font-black uppercase shadow-sm whitespace-nowrap z-20 border border-white/50">${statusText}</span>`
            : ''}
                </div>
            </div>

            <!-- Away Team -->
            <div class="w-[38%] text-left pl-2 flex flex-col justify-center">
                <span class="text-[13px] font-bold text-slate-800 leading-tight line-clamp-2 uppercase tracking-tight">
                    ${(match.partita || ' - ').split('-')[1]?.trim() || ''}
                </span>
                ${(rankA && !isCupMatch) ? `<span class="text-[10px] text-indigo-500 font-black mt-0.5">Pos. ${rankA}°</span>` : ''}
            </div>
        </div>
    `;

    const teamsHTML = `
        <div class="bg-slate-50/50 rounded-t-2xl border-b border-slate-100">
            <!-- Slim Header -->
             <div class="text-center py-2 flex justify-center items-center gap-2 relative">
                 <span class="text-[11px] font-black text-slate-400 uppercase tracking-widest cursor-pointer select-none" onclick="window.triggerMatchDebug('${matchId}', this)">${match.lega || 'LEGA'}</span>
                 ${isLive && isTrading ? `<span class="w-1.5 h-1.5 bg-green-500 rounded-full animate-pulse"></span>` : ''}
             </div>
            ${badgesHTML}
            ${scoreboardHTML}
        </div>
    `;

    // --- Primary Signal ---
    let primarySignalHTML = '';
    const ms = match.magicStats || {};

    if (isMagia) {
        primarySignalHTML = `
            <div class="px-4 pb-4">
                <!-- Magia AI Main Tip (Blue Pill) -->
                <div class="bg-gradient-to-r from-indigo-500 to-blue-600 rounded-xl p-3 text-center shadow-lg shadow-indigo-200/50 mb-3 relative overflow-hidden group">
                     <div class="absolute top-0 right-0 bg-purple-600 text-[10px] sm:text-xs font-black px-2 py-0.5 rounded-bl shadow-lg text-white ring-1 ring-white/20">MAGIA AI</div>
                     <div class="absolute inset-0 bg-white/10 translate-y-full group-hover:translate-y-0 transition-transform duration-300"></div>
                     <span class="text-[11px] font-bold text-indigo-100 uppercase tracking-widest mb-0.5 block">PREVISIONE IA</span>
                     <div class="flex justify-center items-center gap-2">
                      <span class="text-xl font-black text-white">${match.tip || '-'}</span>
                      ${match.quota ? `<span class="bg-white/20 px-1.5 rounded text-xs font-bold text-white backdrop-blur-sm">@ ${match.quota}</span>` : ''}
                     </div>
                </div>

                <!-- SMART COMPARE -->
                ${(ms.tipMagiaAI && match.tip && ms.tipMagiaAI !== match.tip) ? `
                <div class="mt-[-8px] mb-3 text-center">
                    <div class="inline-block bg-purple-100 border border-purple-200 rounded-full px-3 py-0.5 text-[10px] font-black text-purple-600">
                        <i class="fa-solid fa-triangle-exclamation mr-1"></i> AI suggerisce <span class="underline">${ms.tipMagiaAI}</span> invece di ${match.tip}
                    </div>
                </div>
                ` : ''}

                <!-- Prob Bar -->
                <!-- Prob Bar -->
                <div class="mb-4">
                    <div class="prob-bar-container h-2 bg-slate-100 rounded-full overflow-hidden flex">
                        <div class="h-full bg-indigo-500" style="width: ${ms.winHomeProb || 33}%"></div>
                        <div class="h-full bg-slate-300" style="width: ${ms.drawProb || 33}%"></div>
                        <div class="h-full bg-purple-500" style="width: ${ms.winAwayProb || 33}%"></div>
                    </div>
                    <div class="flex justify-between text-[11px] font-bold text-slate-400 mt-1 px-1">
                        <span>1 (${Math.round(ms.winHomeProb || 0)}%)</span>
                        <span>X (${Math.round(ms.drawProb || 0)}%)</span>
                        <span>2 (${Math.round(ms.winAwayProb || 0)}%)</span>
                    </div>
                </div>

                <div class="grid grid-cols-3 gap-2">
                    <div class="bg-slate-50 border border-slate-100 rounded-lg p-2 text-center">
                         <div class="text-[10px] text-slate-400 font-black uppercase mb-0.5">AFFIDABILITÀ</div>
                         <div class="text-sm font-black text-indigo-600">${ms.confidence || 0}%</div>
                    </div>
                    <div class="bg-slate-50 border border-slate-100 rounded-lg p-2 text-center">
                         <div class="text-[10px] text-slate-400 font-black uppercase mb-0.5">PROB. NO GOL</div>
                         <div class="text-sm font-black text-slate-700">${ms.noGolProb || 0}%</div>
                    </div>
                    <div class="bg-slate-50 border border-slate-100 rounded-lg p-2 text-center">
                         <div class="text-[10px] text-slate-400 font-black uppercase mb-0.5">SEGNALE EXTRA</div>
                         <div class="text-xs font-black text-purple-600 whitespace-nowrap overflow-hidden text-ellipsis">${(ms.topSignals && ms.topSignals[1]) ? ms.topSignals[1].label : '-'}</div>
                    </div>
                </div>

                </div>
            </div>
        `;
    } else if (isTrading) {
        // --- 🧬 HYBRID TRADING CARD: Mostra Trading + Betting ---
        // --- 🧬 HYBRID TRADING CARD: Mostra Trading + Betting ---
        const tData = window.resolveTradingData(match);
        // --- 🏛️ AUTHORITY PROTOCOL (Hybrid Context) ---
        const mAuth = window.resolveMatchAuthority(match);
        let betTip = mAuth.tip;
        let betQuota = mAuth.quota;
        let betProb = mAuth.prob;
        let isGoldBadge = mAuth.isElite || mAuth.isMagia;
        let aiLabel = mAuth.badgeLabel;

        // Visual styling based on Authority Status
        const bettingBoxBg = mAuth.boxBg;
        const bettingBoxBorder = mAuth.boxBorder;
        const bettingTipText = mAuth.tipColor;
        const bettingTitleText = mAuth.titleColor;
        const aiBadgeStyle = mAuth.badgeClass;

        primarySignalHTML = `
            <div class="px-4 pb-4">
                <!-- 1. Betting Signal (Integrated & GOLD Ready) -->
                <div class="${bettingBoxBg} ${bettingBoxBorder} border-2 rounded-2xl p-4 text-center mb-4 relative overflow-hidden group shadow-sm transition-all duration-500">
                     ${isGoldBadge ? `<div class="absolute top-0 right-0 ${aiBadgeStyle} text-[9px] font-black px-2 py-1 rounded-bl shadow-sm z-10">${aiLabel}</div>` : ''}
                     <span class="text-[10px] font-black ${bettingTitleText} uppercase tracking-widest mb-1.5 block">CONSIGLIO BETTING</span>
                     <div class="flex justify-center items-center gap-3">
                        <span class="text-xl font-black ${bettingTipText}">${betTip}</span>
                        ${betQuota ? `<span class="${mAuth.isElite ? 'bg-amber-600' : (mAuth.isMagia ? 'bg-white text-indigo-700' : 'bg-blue-600')} text-white px-2 py-0.5 rounded-lg text-xs font-bold shadow-sm">@ ${betQuota}</span>` : ''}
                        <span class="${mAuth.isElite ? 'bg-white/50 text-amber-900 border-amber-300' : (mAuth.isMagia ? 'bg-indigo-800/40 text-white border-indigo-300' : 'bg-blue-100 text-blue-700 border-blue-200')} border px-2 py-0.5 rounded-lg text-xs font-black shadow-xs">${Math.round(betProb)}%</span>
                     </div>
                </div>

                <!-- 2. Trading Instructions -->
                <div class="bg-gradient-to-br from-emerald-500/10 to-teal-600/20 border border-emerald-500/30 rounded-2xl p-4 shadow-inner relative overflow-hidden group">
                     <div class="flex justify-between items-start mb-4">
                        <div class="bg-emerald-600 text-white text-[10px] font-black px-2.5 py-1 rounded-lg shadow-lg flex items-center gap-1.5 uppercase tracking-widest ring-1 ring-white/20">
                            <i class="fa-solid fa-bolt-lightning text-[9px] animate-pulse"></i> Trading 3.0
                        </div>
                        <div class="text-right">
                             <div class="text-emerald-700 font-black text-sm drop-shadow-sm uppercase tracking-tighter">${tData.action}</div>
                        </div>
                    </div>

                    <div class="grid grid-cols-2 gap-3 mb-2 relative z-10">
                        <div class="bg-white/50 backdrop-blur-md rounded-xl p-3 border border-white/60 shadow-sm">
                            <div class="text-[9px] font-bold text-emerald-800/70 uppercase tracking-widest mb-1">Ingresso</div>
                            <div class="text-xs font-black text-emerald-900">${tData.entry}</div>
                        </div>
                        <div class="bg-white/50 backdrop-blur-md rounded-xl p-3 border border-white/60 shadow-sm">
                            <div class="text-[9px] font-bold text-orange-800/70 uppercase tracking-widest mb-1">Uscita</div>
                            <div class="text-xs font-black text-orange-900">${tData.exit}</div>
                        </div>
                        <div class="bg-white/50 backdrop-blur-md rounded-xl p-3 border border-white/60 shadow-sm col-span-2">
                            <div class="text-[9px] font-bold text-indigo-800/70 uppercase tracking-widest mb-1">Timing</div>
                            <div class="text-[10px] font-bold text-indigo-950">${tData.timing}</div>
                        </div>
                    </div>
                </div>
            </div>
        `;
    } else {
        // --- 🧪 GOLDEN PROTOCOL VISUALS (Standard Betting Card) ---

        // --- 🏛️ AUTHORITY PROTOCOL (Standard Context) ---
        const mAuth = window.resolveMatchAuthority(match);
        let betTip = mAuth.tip;
        let betQuota = mAuth.quota;
        let betProb = mAuth.prob;
        let isGoldBadge = mAuth.isElite || mAuth.isMagia;
        let aiLabel = mAuth.badgeLabel;

        // Visual Styles from Authority
        const isGoldCard = mAuth.isElite;
        const badgeStyle = mAuth.badgeClass;

        // ⚖️ SOBRIETY UPDATE: Elite Gold gradient moved from full card to just the Tip Block
        const mainPillBg = isGoldCard ? 'bg-gradient-to-br from-amber-400 via-yellow-200 to-amber-500 shadow-lg ring-1 ring-amber-300' : 'bg-blue-600';
        const mainTipText = isGoldCard ? 'text-amber-950' : 'text-white';

        primarySignalHTML = `
            <div class="px-4 pb-4 flex flex-col items-center gap-3">
                <!-- Standard Main Tip (Blue Pill or GOLD PILL) -->
                <div class="w-full ${mainPillBg} rounded-xl py-2 px-3 text-center shadow-md relative overflow-hidden group">
                     ${isGoldBadge ? `<div class="absolute top-0 right-0 ${badgeStyle} text-[10px] sm:text-[11px] font-black px-2 py-0.5 rounded-bl shadow-lg z-10">${aiLabel}</div>` : ''}
                     <span class="text-[10px] uppercase font-bold ${isGoldCard ? 'text-amber-800' : 'text-blue-200'} block mb-0.5">CONSIGLIO</span>
                     <span class="text-lg font-black tracking-wide ${mainTipText}">${betTip}</span>
                     ${betQuota ? `<span class="ml-2 ${isGoldCard ? 'bg-amber-600 text-white' : (mAuth.isMagia ? 'bg-white text-indigo-700' : 'bg-blue-500/50 text-white')} px-1.5 rounded text-sm font-bold">@ ${betQuota}</span>` : ''}
                </div>

                <!-- Secondary/HT Tip (Purple Pill) -->
                <div class="w-[80%] ${isGoldCard ? 'bg-white/40 border-amber-300 text-amber-900' : (mAuth.isMagia ? 'bg-indigo-600/20 border-indigo-400 text-indigo-100' : 'bg-purple-50 border-purple-100 text-purple-800')} border rounded-full py-1 px-3 text-center flex justify-between items-center shadow-sm">
                     <span class="text-xs font-black uppercase ${isGoldCard ? 'text-amber-700' : (mAuth.isMagia ? 'text-indigo-200' : 'text-purple-400')}">0.5 HT</span>
                     <span class="text-xs font-bold ${isGoldCard ? 'text-amber-900' : (mAuth.isMagia ? 'text-white' : 'text-purple-700')}">Prob. ${Math.round(betProb)}%</span>
                     <span class="${isGoldCard ? 'bg-amber-500 text-white' : (mAuth.isMagia ? 'bg-indigo-400 text-white' : 'bg-purple-100 text-purple-600')} px-1.5 rounded text-xs font-bold">@ 1.50+</span>
                </div>
            </div>
        `;

        // Update the card object if we want a subtle glow for Elite
        if (isGoldCard) card.className += ' ring-2 ring-amber-400/30';
    }

    // --- Insights / detailedTrading ---
    let insightsHTML = expertStatsHTML ? `<div class="px-4 mb-2">${expertStatsHTML}</div>` : '';

    // TRADING: Live Stats & Sniper Trigger (Always show if available for Trading)
    if (isTrading && match.liveStats) {
        const pos = typeof match.liveStats.possession === 'object'
            ? `${match.liveStats.possession.home}% - ${match.liveStats.possession.away}%`
            : (match.liveStats.possession || '0% - 0%');

        const pressure = calculateGoalCookingPressure(match.liveStats, match.liveData?.elapsed || match.liveData?.minute || 0);
        // Sniper trigger moved to background/Telegram, simplified UI here
        const isSniperTrigger = (match.strategy === 'HT_SNIPER' && (match.liveData?.elapsed >= 15 && match.liveData?.elapsed <= 25) && (match.liveData?.score === '0-0'));

        insightsHTML += `
            <div class="px-4 mb-2">
                ${isSniperTrigger ? `
                <div class="bg-indigo-50 border border-indigo-100 text-indigo-700 text-[11px] font-bold p-1.5 rounded-lg mb-2 flex items-center justify-between">
                    <span>🎯 FINESTRA SNIPER ATTIVA</span>
                    <i class="fa-solid fa-clock"></i>
                </div>` : ''}

                <div class="bg-slate-50 rounded-xl p-2.5 border border-slate-100 mb-2">
                    <div class="flex justify-between items-center mb-1">
                        <span class="text-[10px] font-bold text-slate-400 uppercase">Goal Cooking Indicator</span>
                        <span class="text-[11px] font-black ${pressure > 70 ? 'text-orange-500' : 'text-blue-500'}">${pressure}%</span>
                    </div>
                    <div class="h-1.5 bg-slate-200 rounded-full overflow-hidden">
                        <div class="h-full bg-gradient-to-r from-blue-400 via-yellow-400 to-red-400" style="width: ${pressure}%"></div>
                    </div>
                </div>
                
                <!-- NEW: Comprehensive Stats Dashboard -->
                <div class="px-4 mb-3">
                    <div class="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-2.5 flex items-center gap-1.5">
                        <i class="fa-solid fa-chart-line text-[9px]"></i> Live Statistics
                    </div>
                    <div class="grid grid-cols-3 gap-2">
                        <!-- xG -->
                        <div class="bg-gray-50 rounded-lg p-2 border border-gray-100 text-center">
                            <div class="text-lg mx-auto w-7 h-7 rounded-full flex items-center justify-center mb-1 bg-purple-100 text-purple-600">⚡</div>
                            <div class="text-[9px] text-gray-500 font-bold uppercase tracking-wider mb-0.5">xG</div>
                            <div class="text-xs font-black text-gray-800">${match.liveStats.xg?.home || 0} - ${match.liveStats.xg?.away || 0}</div>
                        </div>
                        
                        <!-- Shots on Goal -->
                        <div class="bg-gray-50 rounded-lg p-2 border border-gray-100 text-center">
                            <div class="text-lg mx-auto w-7 h-7 rounded-full flex items-center justify-center mb-1 bg-orange-100 text-orange-600">🎯</div>
                            <div class="text-[9px] text-gray-500 font-bold uppercase tracking-wider mb-0.5">Tiri (Porta)</div>
                            <div class="text-xs font-black text-gray-800">${match.liveStats.shotsOnGoal || '0-0'}</div>
                        </div>
                        
                        <!-- Total Shots -->
                        <div class="bg-gray-50 rounded-lg p-2 border border-gray-100 text-center">
                            <div class="text-lg mx-auto w-7 h-7 rounded-full flex items-center justify-center mb-1 bg-blue-100 text-blue-600">⚽</div>
                            <div class="text-[9px] text-gray-500 font-bold uppercase tracking-wider mb-0.5">Tiri Totali</div>
                            <div class="text-xs font-black text-gray-800">${match.liveStats.totalShots || '0-0'}</div>
                        </div>
                        
                        <!-- Corners -->
                        <div class="bg-gray-50 rounded-lg p-2 border border-gray-100 text-center">
                            <div class="text-lg mx-auto w-7 h-7 rounded-full flex items-center justify-center mb-1 bg-emerald-100 text-emerald-600">📐</div>
                            <div class="text-[9px] text-gray-500 font-bold uppercase tracking-wider mb-0.5">Corner</div>
                            <div class="text-xs font-black text-gray-800">${match.liveStats.corners || '0-0'}</div>
                        </div>
                        
                        <!-- Shots Inside Box -->
                        <div class="bg-gray-50 rounded-lg p-2 border border-gray-100 text-center">
                            <div class="text-lg mx-auto w-7 h-7 rounded-full flex items-center justify-center mb-1 bg-red-100 text-red-600">🔥</div>
                            <div class="text-[9px] text-gray-500 font-bold uppercase tracking-wider mb-0.5">Tiri in Area</div>
                            <div class="text-xs font-black text-gray-800">${match.liveStats.shotsInside || '0-0'}</div>
                        </div>
                        
                        <!-- Possession -->
                        <div class="bg-gray-50 rounded-lg p-2 border border-gray-100 text-center">
                            <div class="text-lg mx-auto w-7 h-7 rounded-full flex items-center justify-center mb-1 bg-indigo-100 text-indigo-600">🏃</div>
                            <div class="text-[9px] text-gray-500 font-bold uppercase tracking-wider mb-0.5">Possesso</div>
                            <div class="text-xs font-black text-gray-800">${pos}</div>
                        </div>
                    </div>
                </div>
                
                <!-- Live Insight Button -->
                <button onclick="window.getLiveTradingAnalysis('${matchId}')" class="w-full mt-2 bg-indigo-100 text-indigo-700 py-2 rounded-lg text-xs font-bold hover:bg-indigo-200 transition flex items-center justify-center gap-2">
                    <i class="fa-solid fa-brain"></i> euGENIO LIVE INSIGHT
                </button>
            </div>
        `;
    } else if (isTrading) {
        // PRE-MATCH TRADING case handled by common insightsHTML initialization
    } else if (isTrading && isLive) {
        // Placeholder for missing stats (e.g. match just started)
        insightsHTML += `
            <div class="px-4 mb-2">
                 <div class="bg-slate-50 border border-slate-100 rounded-xl p-3 text-center flex flex-col items-center gap-2 animate-pulse">
                     <i class="fa-solid fa-satellite-dish text-indigo-400 text-xl fa-bounce"></i>
                     <span class="text-xs font-bold text-slate-400">In attesa dei dati dal campo...</span>
                 </div>
            </div>
        `;
    }

    // TRADING: Match Events Timeline (Goals + Cards)
    if (match.events && match.events.length > 0) {
        // Filter goals and cards (Case Insensitive)
        const events = (match.events || []).filter(ev => {
            const type = (ev.type || '').toLowerCase();
            const detail = (ev.detail || '').toLowerCase();
            return type === 'goal' || detail.includes('goal') || type === 'card';
        });

        console.log(`[CardDebug] Timeline for ${match.partita}: Events=${events.length}`);

        // 🏆 Robust Side Detection (Home vs Away)
        const homeTeamPartita = (match.partita || '').split('-')[0]?.trim().toLowerCase().replace(/[^a-z0-9]/g, '');

        let timelineHTML = '';
        if (events && events.length > 0) {
            // Sort events by time to handle overlays logically
            events.sort((a, b) => {
                const headA = parseInt(a.time?.elapsed || a.elapsed || a.minute || 0);
                const headB = parseInt(b.time?.elapsed || b.elapsed || b.minute || 0);
                return headA - headB;
            });

            timelineHTML = `
                <div class="px-4 mb-5">
                    <div class="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em] mb-4 flex items-center gap-2">
                        <i class="fa-solid fa-timeline text-[9px] text-emerald-500"></i> Match Timeline
                        ${(match.status === 'FT' || match.status === 'AET') ? '<span class="text-[9px] text-slate-300 ml-auto">FINALE</span>' : ''}
                    </div>
                    
                    <div class="relative bg-[#064e3b] border border-emerald-800 rounded-3xl p-4 pt-16 pb-16 shadow-[inset_0_2px_25px_rgba(0,0,0,0.5)] h-64 overflow-hidden">
                        <!-- Pitch Markings & Lawn Texture -->
                        <div class="absolute inset-0 pointer-events-none">
                            <!-- Alternate Lawn Stripes -->
                            <div class="absolute inset-0 opacity-[0.05]" style="background: repeating-linear-gradient(90deg, transparent, transparent 10%, #000 10%, #000 20%);"></div>
                            
                            <div class="absolute inset-0 opacity-20">
                                <div class="absolute top-0 bottom-0 left-1/2 w-[1.5px] bg-white -translate-x-1/2 shadow-[0_0_8px_white]"></div> <!-- Halfway Line -->
                                <div class="absolute inset-y-10 left-10 right-10 border-x-2 border-white/40 shadow-[0_0_5px_rgba(255,255,255,0.2)]"></div> <!-- Pitch Borders -->
                                <div class="absolute top-1/2 left-1/2 w-24 h-24 border-2 border-white rounded-full -translate-x-1/2 -translate-y-1/2 shadow-[0_0_10px_rgba(255,255,255,0.2)]"></div>
                            </div>
                        </div>
                        
                        <!-- Fixed 90' Progress Bar (Fiber Optic Style) -->
                        <div class="absolute top-1/2 -translate-y-1/2 left-10 right-10 h-1.5 bg-emerald-950/60 rounded-full overflow-hidden border border-emerald-700/30">
                            <div class="h-full bg-gradient-to-r from-emerald-400 via-lime-400 to-emerald-300 shadow-[0_0_20px_rgba(52,211,153,0.8)] transition-all duration-1000 fiber-optic-progress relative" 
                                 style="width: ${Math.min(Math.max((parseInt(match.minute || 0) / 90) * 100, 0), 100)}%">
                                 <div class="absolute inset-0 bg-gradient-to-r from-transparent via-white/30 to-transparent animate-pulse"></div>
                                 <div class="absolute right-0 top-0 bottom-0 w-4 bg-white/60 blur-[3px]"></div>
                            </div>
                        </div>

                        <!-- Removed redundant labels per user request -->
                        
                        <!-- Live Indicator (Vibrant Emerald) -->
                        ${(match.status !== 'FT' && match.minute) ? `
                            <div class="absolute top-1/2 -translate-y-1/2 flex flex-col items-center pointer-events-none" style="left: calc(40px + (100% - 80px) * ${Math.min(Math.max((parseInt(match.minute) / 90), 0), 1.0)}); z-index: 5;">
                                <div class="w-[2px] h-20 bg-emerald-400/30 rounded-full blur-[1px]"></div>
                                <div class="w-3 h-3 bg-emerald-400 rounded-full shadow-[0_0_12px_rgba(52,211,153,1)] border-2 border-white -mt-10"></div>
                            </div>
                        ` : ''}

                        <!-- Events Rendering: Broadcast Style with High-Contrast Stems -->
                        ${(() => {
                    const seen = new Set();
                    const validEvents = events.filter(ev => {
                        const type = (ev.type || '').toLowerCase();
                        const detail = (ev.detail || '').toLowerCase();
                        const min = parseInt(ev.time?.elapsed || ev.elapsed || ev.minute || 0);
                        const playerName = ev.player?.name || '';
                        const key = `${type}-${min}-${playerName}`;
                        if (seen.has(key)) return false;
                        seen.add(key);

                        return (type === 'goal' && (detail.includes('normal') || detail.includes('penalty') || detail.includes('own goal') || detail === '')) ||
                            (type === 'card' && (detail.includes('yellow') || detail.includes('red')));
                    });

                    let lastHomeMin = -999, lastAwayMin = -999;
                    let hLevel = 0, aLevel = 0;

                    const bookingsList = [];

                    const renderedEvents = validEvents.map((ev, i) => {
                        const min = parseInt(ev.time?.elapsed || ev.elapsed || ev.minute || 0);
                        const pos = Math.min(Math.max((min / 90) * 100, 0), 100);
                        const isGoal = (ev.type || '').toLowerCase() === 'goal';
                        const detail = (ev.detail || '').toLowerCase();
                        const team = (ev.team?.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
                        const isHome = team.includes(homeTeamPartita) || homeTeamPartita.includes(team) || ev.side === 'home';
                        const playerNameFull = ev.player?.name || '';
                        const name = playerNameFull ? playerNameFull.split(' ').pop().toUpperCase() : '';

                        if (!isGoal) {
                            bookingsList.push({ min, name, detail, isHome });
                        }

                        // Vert Staggering (3 Levels) - Threshold set to 12 mins for maximum clarity
                        let level = 0;
                        if (isHome) {
                            if (Math.abs(min - lastHomeMin) < 12) hLevel = (hLevel + 1) % 3; else hLevel = 0;
                            level = hLevel; lastHomeMin = min;
                        } else {
                            if (Math.abs(min - lastAwayMin) < 12) aLevel = (aLevel + 1) % 3; else aLevel = 0;
                            level = aLevel; lastAwayMin = min;
                        }

                        const stemHeight = 18 + (level * 35);

                        if (isGoal) {
                            return `
                            <div class="absolute" style="left: calc(40px + (100% - 80px) * ${pos / 100}); ${isHome ? 'bottom: 50%' : 'top: 50%'}; z-index: 30; transform: translateX(-50%);">
                                <div class="flex ${isHome ? 'flex-col-reverse' : 'flex-col'} items-center">
                                    <div class="bg-white text-emerald-900 text-[8px] font-black px-1.5 py-0.5 rounded shadow-[0_0_10px_rgba(255,255,255,0.4)] border border-emerald-400 z-40 mb-[-5px] mt-[-5px]">${min}'</div>
                                    <div class="w-[1.5px] bg-gradient-to-${isHome ? 't' : 'b'} from-white to-transparent opacity-60" style="height: ${stemHeight}px"></div>
                                    <div class="relative group flex flex-col items-center">
                                        <!-- Minimalist Pulsing Goal Icon -->
                                        <div class="relative flex items-center justify-center">
                                            <div class="absolute w-8 h-8 bg-emerald-400 rounded-full animate-ping opacity-20"></div>
                                            <span class="text-xl drop-shadow-[0_0_8px_rgba(255,255,255,0.8)] z-10">⚽</span>
                                        </div>
                                        <div class="absolute ${isHome ? 'bottom-full mb-2' : 'top-full mt-2'} glass-label-premium px-2 py-0.5 rounded-lg shadow-2xl whitespace-nowrap z-50">
                                            <span class="text-[10px] font-black text-white tracking-widest">${name || 'GOL'}</span>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        `;
                        } else { // Card
                            return `
                             <div class="absolute" style="left: calc(40px + (100% - 80px) * ${pos / 100}); ${isHome ? 'bottom: 50%' : 'top: 50%'}; z-index: 25; transform: translateX(-50%);">
                                 <div class="flex ${isHome ? 'flex-col-reverse' : 'flex-col'} items-center">
                                    <div class="bg-white/90 text-emerald-950 text-[7px] font-black px-1 rounded shadow-sm z-40 mb-[-4px] mt-[-4px]">${min}'</div>
                                    <div class="w-[1px] bg-white/20" style="height: 10px"></div>
                                    <div class="w-3.5 h-5 ${detail.includes('yellow') ? 'bg-yellow-400 shadow-[0_0_10px_rgba(250,204,21,0.4)]' : 'bg-red-500 shadow-[0_0_10px_rgba(239,68,68,0.4)]'} rounded-[1.5px] border border-white/40 z-10"></div>
                                 </div>
                            </div>
                        `;
                        }
                    }).join('');

                    return `
                        ${renderedEvents}
                        </div> <!-- Close pitch relative div -->
                        ${bookingsList.length > 0 ? `
                        <div class="mt-4 px-2">
                            <div class="text-[9px] font-black text-slate-500 uppercase tracking-widest mb-3 border-b border-slate-100 pb-1 flex items-center gap-2">
                                <i class="fa-solid fa-clone text-[8px]"></i> Provvedimenti
                            </div>
                            
                            ${(() => {
                                const homeB = bookingsList.filter(b => b.isHome).sort((a, b) => a.min - b.min);
                                const awayB = bookingsList.filter(b => !b.isHome).sort((a, b) => a.min - b.min);

                                let html = '';
                                if (homeB.length > 0) {
                                    html += `
                                        <div class="flex flex-wrap gap-x-3 gap-y-2 mb-3">
                                            ${homeB.map(b => `
                                                <div class="flex items-center gap-1.5 bg-slate-50 px-2 py-1 rounded-md border border-slate-100">
                                                    <div class="w-1.5 h-3 ${b.detail.includes('yellow') ? 'bg-yellow-400' : 'bg-red-500'} rounded-[1px] border border-black/5"></div>
                                                    <span class="text-[10px] font-bold text-slate-400">${b.min}'</span>
                                                    <span class="text-[10px] font-black text-slate-700 uppercase tracking-tight">${b.name}</span>
                                                </div>
                                            `).join('')}
                                        </div>
                                    `;
                                }
                                if (awayB.length > 0) {
                                    if (homeB.length > 0) html += `<div class="w-full h-[1px] bg-slate-50 mb-3"></div>`;
                                    html += `
                                        <div class="flex flex-wrap gap-x-3 gap-y-2">
                                            ${awayB.map(b => `
                                                <div class="flex items-center gap-1.5 bg-slate-50 px-2 py-1 rounded-md border border-slate-100">
                                                    <div class="w-1.5 h-3 ${b.detail.includes('yellow') ? 'bg-yellow-400' : 'bg-red-500'} rounded-[1px] border border-black/5"></div>
                                                    <span class="text-[10px] font-bold text-slate-400">${b.min}'</span>
                                                    <span class="text-[10px] font-black text-slate-700 uppercase tracking-tight">${b.name}</span>
                                                </div>
                                            `).join('')}
                                        </div>
                                    `;
                                }
                                return html;
                            })()}
                        </div>` : ''}
                    `;
                })()}
                </div>
            </div>
            `;
        }
        insightsHTML += timelineHTML;
    }

    // 1X2 Prob Bar (Consistent AI Insight) - ONLY SHOW FOR NON-MAGIA MATCHES (Avoid duplicate)
    if (!isMagia && (ms.winHomeProb || ms.drawProb || ms.winAwayProb)) {
        insightsHTML += `
            <div class="px-4 mb-4">
                    <div class="bg-slate-50 p-3 rounded-xl border border-slate-100">
                        <div class="flex justify-between items-end mb-2">
                            <span class="text-xs font-black text-slate-400 uppercase tracking-widest">Probabilità AI</span>
                        </div>
                        <div class="flex h-2.5 rounded-full overflow-hidden mb-2 shadow-inner bg-slate-200">
                            <div class="h-full bg-indigo-500" style="width: ${ms.winHomeProb || 33}%"></div>
                            <div class="h-full bg-slate-300" style="width: ${ms.drawProb || 33}%"></div>
                            <div class="h-full bg-purple-500" style="width: ${ms.winAwayProb || 33}%"></div>
                        </div>
                        <div class="flex justify-between text-xs font-bold text-slate-500 px-1">
                            <div class="flex items-center gap-1"><div class="w-2 h-2 rounded-full bg-indigo-500"></div>1 (${Math.round(ms.winHomeProb || 0)}%)</div>
                            <div class="flex items-center gap-1"><div class="w-2 h-2 rounded-full bg-slate-300"></div>X (${Math.round(ms.drawProb || 0)}%)</div>
                            <div class="flex items-center gap-1"><div class="w-2 h-2 rounded-full bg-purple-500"></div>2 (${Math.round(ms.winAwayProb || 0)}%)</div>
                        </div>
                    </div>
            </div>
                `;
    }

    // euGENIO Insight
    const why = match.why || match.spiegazione || match.insight || "";
    if (why) {
        insightsHTML += `
                <div class="px-4 mb-3">
                    <div class="eugenio-why-box border border-indigo-100 shadow-sm relative overflow-hidden bg-indigo-50/30">
                        <div class="flex items-center gap-1.5 mb-1">
                            <i class="fa-solid fa-brain text-xs text-indigo-400"></i>
                            <span class="text-[11px] font-black text-indigo-400 uppercase tracking-widest">Il Perché di euGENIO</span>
                        </div>
                        ${why}
                    </div>
            </div>
                `;
    }

    // Warnings (Standard Only)
    // isFinished is already defined at top of function
    if (!isMagia && !isTrading && warningStats && STANDARD_STRATEGIES.includes(stratId)) {
        const volatile = warningStats.volatileLeagues?.find(l => l.lega === match.lega);
        if (volatile && !isFinished) {
            insightsHTML += `
                <div class="mx-4 mb-3 bg-red-50 border border-red-200 rounded-lg p-2 flex items-center gap-2">
                    <i class="fa-solid fa-triangle-exclamation text-red-500 text-xs"></i>
                    <div class="text-xs text-red-700 font-bold">Lega volatile (${volatile.volatility}% vol)</div>
                </div>
                `;
        }
    }

    // 05 HT Logic - REMOVED AS REQUESTED (Duplicato, usiamo quello del DB nel primarySignal)
    const htHTML = '';

    insightsHTML += htHTML;

    // --- Rationale (If second source exists) ---
    const alternativeRationale = match.logicRationale || match.logic_rationale || match.reasoning || "";
    if (alternativeRationale && !why) {
        insightsHTML += `
                <div class="px-4 mb-3">
                    <div class="eugenio-why-box border border-indigo-100 shadow-sm relative overflow-hidden bg-indigo-50/30">
                        <div class="flex items-center gap-1.5 mb-1">
                            <i class="fa-solid fa-brain text-xs text-indigo-400"></i>
                            <span class="text-[11px] font-black text-indigo-400 uppercase tracking-widest">Il Perché di euGENIO</span>
                        </div>
                        ${alternativeRationale}
                    </div>
            </div>
                `;
    }

    // --- Footer with Monitoring Badge ---
    let notMonitoredBadge = '';
    const now = new Date();
    const matchTimeStr = match.ora || '00:00';
    const matchDateStr = match.data || now.toISOString().split('T')[0];
    const matchDateTime = new Date(`${matchDateStr}T${matchTimeStr}:00`);
    const oneHourAfterKickoff = (now - matchDateTime) > (60 * 60 * 1000); // 1 hour after kickoff

    // NEW RULE: Se mancano dati live 2 ORE dopo il kickoff → Non Monitorata
    // Abbiamo alzato a 120 minuti per dare tempo al sistema di recuperare match lenti o ritardati
    const twoHoursAfterKickoff = (now - matchDateTime) > (120 * 60 * 1000);

    if (match.isNotMonitored || (!liveHubData && twoHoursAfterKickoff)) {
        const isFuture = matchDateTime > now;

        if (mName.toLowerCase().includes('torino') || mName.toLowerCase().includes('roma')) {
            console.log(`[SURGERY-DEBUG] 🚩 MONITORING FAILURE for ${mName}`);
        }

        notMonitoredBadge = isFuture
            ? '<span class="text-[11px] font-bold text-blue-400 uppercase tracking-widest bg-blue-500/10 px-2 py-0.5 rounded-full flex items-center gap-1"><i class="fa-regular fa-clock"></i> In Attesa</span>'
            : '<span class="text-[11px] font-bold text-red-400 uppercase tracking-widest bg-red-500/10 px-2 py-0.5 rounded-full flex items-center gap-1"><i class="fa-solid fa-ban"></i> Non Monitorata</span>';
    }


    const footerHTML = `
                <div class="bg-slate-50 p-2 border-t border-slate-100 flex justify-between items-center px-4">
              <div class="text-[11px] font-bold text-slate-400 uppercase tracking-widest">TIPSTER AI</div>
              <div class="flex items-center gap-2">
                ${match.status === 'FT' ? '<span class="text-[11px] font-black text-green-600">● MATCH CONCLUSO</span>' : (notMonitoredBadge || '<span class="text-[11px] font-black text-indigo-500 animate-pulse">● MONITORAGGIO ATTIVO</span>')}
              </div>
        </div>
                `;

    card.innerHTML = headerHTML + teamsHTML + primarySignalHTML + insightsHTML + footerHTML;
    return card;
};

// ==================== TRADING LOGIC ====================
let tradingFilterState = 'all'; // all, live, favs
let lastTradingPicksCache = [];
window.lastTradingPicksCache = lastTradingPicksCache; // 🏆 Expose globally for isTradingPick

window.initTradingPage = function () {
    // Filter Listeners
    const filters = {
        'filter-trading-all': 'all',
        'filter-trading-live': 'live',
        'filter-trading-favs': 'favs'
    };

    Object.entries(filters).forEach(([id, state]) => {
        const btn = document.getElementById(id);
        if (!btn) return;
        btn.onclick = () => {
            tradingFilterState = state;
            // UI Update
            Object.keys(filters).forEach(k => {
                const b = document.getElementById(k);
                b.className = (k === id)
                    ? 'flex-1 py-2 px-3 rounded-lg font-bold text-xs transition-all bg-gray-800 text-white shadow-lg'
                    : 'flex-1 py-2 px-3 rounded-lg font-bold text-xs transition-all bg-transparent text-gray-500 hover:bg-gray-800 flex items-center justify-center gap-1';
            });
            window.renderTradingCards(lastTradingPicksCache);
        };
    });

    // Navigation Listeners
    document.getElementById('trading-date-prev').addEventListener('click', () => {
        const d = new Date(currentTradingDate);
        d.setDate(d.getDate() - 1);
        currentTradingDate = d.toISOString().split('T')[0];
        loadTradingPicks(currentTradingDate);
    });

    document.getElementById('trading-date-next').addEventListener('click', () => {
        const d = new Date(currentTradingDate);
        d.setDate(d.getDate() + 1);
        currentTradingDate = d.toISOString().split('T')[0];
        loadTradingPicks(currentTradingDate);
    });

    // Initial Load
    loadTradingFavorites();
    loadTradingPicks(currentTradingDate);
};

/**
 * TAB: I CONSIGLI
 * Now reads pre-calculated parlays from Firebase (admin-generated)
 * v5.0 - Server-Side Calculation
 */
window.loadTipsPage = async function () {
    const today = window.currentAppDate || new Date().toISOString().split('T')[0];
    const containerWrapper = document.getElementById('parlays-container');
    const noTipsEmptyLogic = document.getElementById('no-tips-empty-logic');
    const noTipsEmptyFallback = document.getElementById('no-tips-empty-fallback');

    if (!containerWrapper) return;

    containerWrapper.innerHTML = '<div class="text-center text-white/60 py-8"><i class="fa-solid fa-spinner fa-spin text-2xl mb-2"></i><p class="text-sm">Caricamento consigli...</p></div>';

    try {
        // Fetch pre-calculated parlays from Firebase
        const parlayDoc = await getDoc(doc(db, "daily_parlays", today));

        if (!parlayDoc.exists() || !parlayDoc.data().parlays) {
            console.log('[Tips] No pre-calculated parlays found for', today);
            containerWrapper.classList.add('hidden');
            if (noTipsEmptyFallback) noTipsEmptyFallback.classList.remove('hidden');
            if (noTipsEmptyLogic) noTipsEmptyLogic.classList.add('hidden');
            return;
        }

        const data = parlayDoc.data();
        const parlays = data.parlays;

        console.log(`[Tips] Loaded ${Object.keys(parlays).length} parlays from Firebase(generated: ${data.generatedAt})`);

        containerWrapper.classList.remove('hidden');
        if (noTipsEmptyLogic) noTipsEmptyLogic.classList.add('hidden');
        if (noTipsEmptyFallback) noTipsEmptyFallback.classList.add('hidden');
        containerWrapper.innerHTML = '';

        // Render each parlay
        Object.entries(parlays).forEach(([key, parlay]) => {
            if (!parlay.picks || parlay.picks.length === 0) return;

            const card = document.createElement('div');
            card.className = 'glass-parlay-card fade-in';

            const headerHtml = `
                <div class="flex justify-between items-start mb-6">
                    <div>
                        <div class="flex items-center gap-2 mb-2">
                            <span class="bg-${parlay.color}-600 text-white text-[11px] font-black px-4 py-1.5 rounded-full uppercase tracking-widest shadow-lg">${parlay.label}</span>
                            <span class="roi-badge">+${parlay.roi}% ROI</span>
                        </div>
                        <div class="text-xs text-white/80 font-bold uppercase tracking-tight ml-2">Confidence AI: <span class="text-white font-black">${parlay.avgConfidence}%</span></div>
                    </div>
                    <div class="text-right">
                        <div class="text-[11px] font-black text-white/70 uppercase tracking-[0.3em] mb-1">Quota Totale</div>
                        <div class="text-3xl font-black text-white leading-none">@${parlay.totalOdds.toFixed(2)}</div>
                    </div>
                </div>
                `;

            let matchesHtml = '<div class="space-y-4">';
            parlay.picks.forEach(m => {
                const isGoal = (m.tip || '').includes('Goal') || (m.tip || '').includes('Over') || (m.tip || '').includes('+');
                let icon = isGoal ? 'fa-fire-flame-curved' : 'fa-shield-halved';

                // Split teams
                const teams = (m.partita || '').split('-').map(t => t.trim());
                const home = teams[0] || 'Team A';
                const away = teams[1] || 'Team B';

                // Star Logic (FixtureID Mantra)
                const matchId = window.getMantraId(m);
                const isFlagged = (window.tradingFavorites || []).includes(matchId) ||
                    (window.selectedMatches || []).some(sm => window.getMantraId(sm) === matchId);
                const starClass = isFlagged ? 'fa-solid text-yellow-300' : 'fa-regular text-white/70';

                // Live Score Integration
                let liveMatch = null;
                if (window.liveScoresHub) {
                    liveMatch = Object.values(window.liveScoresHub).find(x => (x.fixtureId && m.fixtureId && x.fixtureId == m.fixtureId));
                    if (!liveMatch) {
                        const norm = s => (s || '').toLowerCase().replace(/[^a-z]/g, '');
                        liveMatch = Object.values(window.liveScoresHub).find(x => {
                            const n = norm(x.matchName || '');
                            return n.includes(norm(home)) && n.includes(norm(away));
                        });
                    }
                }

                const currentScore = liveMatch ? (liveMatch.score || liveMatch.risultato) : (m.risultato || null);
                const [scHome, scAway] = currentScore ? currentScore.split('-') : ['', ''];

                const isLive = liveMatch && ['1H', '2H', 'HT', 'ET', 'P', 'LIVE'].includes(liveMatch.status);
                const isFT = (liveMatch && liveMatch.status === 'FT') || m.status === 'FT' || (m.risultato && m.risultato.length > 2);

                // Time Badge
                let timeBadge = '';
                if (isFT) timeBadge = '<span class="text-emerald-400 font-bold ml-1 text-[9px]">FT</span>';
                else if (isLive) timeBadge = `<span class="text-rose-500 font-bold ml-1 animate-pulse text-[9px]">\'${liveMatch?.elapsed || liveMatch?.minute || ''}</span>`;
                else if (m.ora) timeBadge = `<span class="text-[11px] text-white/60 font-bold bg-white/5 px-1.5 rounded"><i class="fa-regular fa-clock mr-1 text-[10px]"></i>${m.ora}</span>`;

                // Outcome Styling
                let outcomeStatus = (m.esito || '').toUpperCase();

                // 🧠 AUTO-ESITO: Se non c'è esito ma c'è il risultato, calcolalo localmente
                if (!outcomeStatus && currentScore && m.tip) {
                    const localEval = window.evaluateTipLocally ? window.evaluateTipLocally(m.tip, currentScore) : null;
                    if (localEval) outcomeStatus = localEval.toUpperCase();
                }

                let boxClass = 'glass-item-premium transition-all duration-300';
                let iconClass = isGoal ? 'text-orange-400' : 'text-blue-400';
                let iconBg = 'bg-white/10';

                if (outcomeStatus === 'WIN' || outcomeStatus === 'VINTO') {
                    boxClass += ' ring-1 ring-emerald-500/50 bg-emerald-500/5';
                    iconClass = 'text-emerald-400';
                    iconBg = 'bg-emerald-400/20 shadow-[0_0_15px_rgba(52,211,153,0.3)]';
                    icon = 'fa-check';
                } else if (outcomeStatus === 'LOSE' || outcomeStatus === 'PERSO') {
                    boxClass += ' opacity-60 grayscale-[0.5] border-l-2 border-rose-500/50';
                    iconClass = 'text-rose-400';
                    iconBg = 'bg-rose-400/10';
                    icon = 'fa-xmark';
                }

                matchesHtml += `
                    <div class="${boxClass}">
                        <div class="tip-icon-box ${iconClass} ${iconBg}">
                            <i class="fa-solid ${icon}"></i>
                        </div>
                        <div class="team-vertical-box">
                            <div class="flex justify-between items-center mb-1 pr-2">
                                <span class="text-[11px] text-white/50 font-black truncate uppercase tracking-widest italic max-w-[70%]">${m.lega || 'PRO LEAGUE'}</span>
                                ${timeBadge}
                            </div>
                            <div class="flex justify-between items-center pr-2">
                                <div class="team-name-row truncate max-w-[85%]">${home}</div>
                                ${scHome ? `<span class="text-amber-300 font-black text-sm drop-shadow-sm">${scHome}</span>` : ''}
                            </div>
                            <div class="flex justify-between items-center pr-2">
                                 <div class="team-name-row truncate max-w-[85%]">${away}</div>
                                 ${scAway ? `<span class="text-amber-300 font-black text-sm drop-shadow-sm">${scAway}</span>` : ''}
                            </div>
                            <div class="flex items-center gap-2 mt-2">
                                <span class="tip-label-badge ${outcomeStatus === 'WIN' ? 'bg-emerald-500/30 text-emerald-200 border-emerald-500/50' : ''}">${m.tip}</span>
                                <span class="confidence-label">AI ${m.score || 85}%</span>
                            </div>
                        </div>
                        <div class="flex items-center gap-3">
                             <div class="odd-highlight-v5 ${outcomeStatus === 'VINTO' || outcomeStatus === 'WIN' ? 'text-emerald-300 text-lg' : ''}">@${m.quota}</div>
                             <button data-match-id="${matchId}" 
                                onclick='toggleMatchFavorite(${JSON.stringify(m).replace(/'/g, "&apos;")}); event.stopPropagation();' 
                                class="hover:scale-110 transition-transform p-1">
                                <i class="${starClass} fa-star text-lg drop-shadow-sm"></i>
                             </button>
                        </div>
                    </div>
                `;
            });
            matchesHtml += '</div>';

            card.innerHTML = headerHtml + matchesHtml;
            containerWrapper.appendChild(card);
        });

    } catch (error) {
        console.error('[Tips] Error loading parlays from Firebase:', error);
        containerWrapper.innerHTML = '<div class="text-center text-red-400 py-8"><i class="fa-solid fa-exclamation-circle text-2xl mb-2"></i><p class="text-sm">Errore caricamento consigli</p></div>';
        if (noTipsEmptyFallback) noTipsEmptyFallback.classList.add('hidden');
        if (noTipsEmptyLogic) noTipsEmptyLogic.classList.add('hidden');
    }
};

window.loadTradingPicks = function (date) {
    if (tradingUnsubscribe) tradingUnsubscribe();

    // Also unsubscribe from signals if active
    if (window.signalsUnsubscribe) {
        window.signalsUnsubscribe();
        window.signalsUnsubscribe = null;
    }

    // Update Date Display
    document.getElementById('trading-selected-date-display').textContent = formatDateLong(date);
    document.getElementById('trading-date-indicator').textContent = 'Caricamento...';

    // 1. Listen for Daily Picks
    tradingUnsubscribe = onSnapshot(doc(db, "daily_trading_picks", date), (docSnap) => {
        if (!docSnap.exists()) {
            window.renderTradingCards([], {});
            document.getElementById('trading-date-indicator').textContent = 'Nessuna partita';
            return;
        }

        const data = docSnap.data();
        const picks = data.picks || [];

        // 2. Fetch Live Signals (Realtime)
        // We listen to the entire collection or query by date if possible. 
        // For simplicity and to match old logic, we'll listen to the collection but filtered could be better.
        // However, the ID matching happens on client.

        if (window.signalsUnsubscribe) window.signalsUnsubscribe();

        window.signalsUnsubscribe = onSnapshot(collection(db, "trading_signals"), (signalsSnap) => {
            const signalsMap = {};
            signalsSnap.forEach(doc => {
                signalsMap[doc.id] = doc.data();
            });

            // Merge functionality
            const mergedPicks = picks.map(pick => {
                const pickId = window.getTradingPickId(pick);

                // Try multiple ID formats for matching
                let sig = signalsMap[pickId] || signalsMap[`trading_${pickId} `] || signalsMap[pickId.replace('trading_', '')];

                if (!sig) {
                    // Try to find by partial match on name (normalized)
                    const cleanPickName = pick.partita.toLowerCase().replace(/[^a-z]/g, "");
                    for (const sid in signalsMap) {
                        if (sid.includes(cleanPickName)) {
                            sig = signalsMap[sid];
                            break;
                        }
                    }
                }

                if (sig) {
                    // Normalize sig data to ensure consistent structure if needed, 
                    // or just merge as is since createUniversalCard is now more robust.
                    return { ...pick, ...sig, id: pickId };
                }
                return { ...pick, id: pickId };
            });

            // 🔧 FIX: Merge with liveScoresHub AND Unified AI Data
            const liveHub = window.liveScoresHub || {};
            const unifiedMatches = window.getUnifiedMatches ? window.getUnifiedMatches() : [];

            const enrichedPicks = mergedPicks.map(pick => {
                let hubMatch = null;

                // 1. Sync with LiveHub (ID-Pure Only)
                if (pick.fixtureId) {
                    hubMatch = Object.values(liveHub).find(h => String(h.fixtureId || '') === String(pick.fixtureId));
                }

                // 2. Sync with AI Metadata (ID-Pure Only)
                const aiMatch = pick.fixtureId ? unifiedMatches.find(u => String(u.fixtureId || '') === String(pick.fixtureId)) : null;

                let finalPick = { ...pick };

                if (aiMatch) {
                    // SOCIO: Betting data (tip, odd, prob) always comes from the AI/All metadata
                    finalPick.tip = aiMatch.tip || aiMatch.magiaTip || pick.tip;
                    finalPick.quota = aiMatch.quota || pick.quota;
                    finalPick.probabilita = aiMatch.probabilita || aiMatch.confidence || pick.confidence || 0;

                    // Metadata for Authority Control (Scelta Magica / Elite Gold)
                    finalPick.isMagiaAI = aiMatch.isMagiaAI;
                    finalPick.isSpecialAI = aiMatch.isSpecialAI;
                    finalPick.magiaTip = aiMatch.magiaTip;
                }

                if (hubMatch) {
                    finalPick = {
                        ...finalPick,
                        liveStats: hubMatch.liveStats || {},
                        liveData: {
                            elapsed: hubMatch.elapsed,
                            status: hubMatch.status,
                            score: hubMatch.score
                        },
                        events: hubMatch.events || [],
                        homeLogo: hubMatch.homeLogo || pick.homeLogo,
                        awayLogo: hubMatch.awayLogo || pick.awayLogo,
                        homeTeam: hubMatch.homeTeam || pick.homeTeam,
                        awayTeam: hubMatch.awayTeam || pick.awayTeam
                    };
                }
                return finalPick;
            });

            window._prevScrollY = window.scrollY;
            window.renderTradingCards(enrichedPicks);

            // Restore scroll after rendering
            if (window._prevScrollY) {
                window.scrollTo(0, window._prevScrollY);
                delete window._prevScrollY;
            }

            if (mergedPicks.length > 0) {
                document.getElementById('trading-date-indicator').textContent = `${mergedPicks.length} opportunità`;
                document.getElementById('trading-empty').classList.add('hidden');
            } else {
                document.getElementById('trading-date-indicator').textContent = 'Nessuna partita';
                document.getElementById('trading-empty').classList.remove('hidden');
            }

        });

    }, (error) => {
        console.error("Trading Live Error", error);
        document.getElementById('trading-date-indicator').textContent = 'Errore caricamento';
    });
};

window.renderTradingCards = function (picks) {
    const oldScroll = window.scrollY; // 🩹 FIX: salva scroll prima del render
    lastTradingPicksCache = picks;
    window.lastTradingPicksCache = picks; // 🏆 Sync to window for isTradingPick

    // 🔧 FIX: Always re-enrich with latest LiveHub stats before rendering

    // This ensures that when LiveHub updates, we get the fresh stats even if picks came from cache
    const liveHub = window.liveScoresHub || {};
    const enrichedPicks = picks.map(pick => {
        // Find in liveScoresHub by fixtureId or name match
        let hubMatch = null;

        if (pick.fixtureId) {
            const targetId = String(pick.fixtureId);
            hubMatch = Object.values(liveHub).find(h => String(h.fixtureId || '') === targetId);
        }

        if (hubMatch) {
            // Merge LIVE stats over static pick data
            return {
                ...pick,
                liveStats: hubMatch.liveStats || {},
                liveData: {
                    elapsed: hubMatch.elapsed,
                    status: hubMatch.status,
                    score: hubMatch.score
                },
                events: hubMatch.events || [],
                // Prefer Hub data for display if available
                homeLogo: hubMatch.homeLogo || pick.homeLogo,
                awayLogo: hubMatch.awayLogo || pick.awayLogo,
                homeTeam: hubMatch.homeTeam || pick.homeTeam,
                awayTeam: hubMatch.awayTeam || pick.awayTeam,
                _liveHubRef: hubMatch // 🛡️ Pass reference to createUniversalCard
            };
        }
        return pick;
    });

    const container = document.getElementById('trading-matches-container');
    if (!container) return;

    // ANTI-FLICKER: Check diff based on enriched data
    const dataHash = getDataHash(enrichedPicks);
    if (_lastRenderCache.tradingHash === dataHash) {
        console.log('[Trading Render] ⏭️ SKIPPED (data unchanged)');
        return;
    }
    _lastRenderCache.tradingHash = dataHash;

    if (picks.length === 0) {
        document.getElementById('trading-empty').classList.remove('hidden');
        return;
    }

    // 1. Filter
    let filtered = enrichedPicks.filter(p => !isMatchStale(p));
    if (tradingFilterState === 'live') {
        filtered = filtered.filter(p => (p.liveData?.elapsed || p.liveData?.minute || 0) > 0);
    } else if (tradingFilterState === 'favs') {
        filtered = filtered.filter(p => (window.tradingFavorites || []).includes(window.getTradingPickId(p)));
    }

    if (filtered.length === 0) {
        if (picks.length > 0) {
            container.replaceChildren();
            document.getElementById('trading-empty').classList.remove('hidden');
        }
        return;
    }

    // 2. Smart Sorting
    const getPriority = (p) => {
        const isFav = (window.tradingFavorites || []).includes(window.getTradingPickId(p));
        const isLive = (p.liveData?.elapsed || p.liveData?.minute || 0) > 0;
        if (isFav && isLive) return 1;
        if (isLive) return 2;
        if (isFav) return 3;
        return 4;
    };

    filtered.sort((a, b) => {
        const pA = getPriority(a);
        const pB = getPriority(b);
        if (pA !== pB) return pA - pB;
        return (a.ora || '').localeCompare(b.ora || '');
    });

    document.getElementById('trading-empty').classList.add('hidden');

    // 🔧 NORMALIZZA ogni pick prima del render per evitare "undefined"
    const normalizedPicks = filtered.map((pick, idx) => {
        // 🐕 DEBUG: Log dati RAW prima della normalizzazione
        console.log(`[Trading Debug] Pick #${idx + 1} RAW:`, {
            partita: pick.partita,
            home: pick.home,
            away: pick.away,
            homeTeam: pick.homeTeam,
            awayTeam: pick.awayTeam,
            homeLogo: pick.homeLogo ? '✅ presente' : '❌ mancante',
            awayLogo: pick.awayLogo ? '✅ presente' : '❌ mancante',
            liveData: pick.liveData,
            liveStats: pick.liveStats ? '✅ presente' : '❌ mancante',
            strategy: pick.strategy,
            tradingInstruction: pick.tradingInstruction
        });

        const teamParts = (pick.partita || '').split(' - ');

        // Nomi squadre
        pick.home = pick.home || pick.homeTeam || teamParts[0]?.trim() || 'Home';
        pick.away = pick.away || pick.awayTeam || teamParts[1]?.trim() || 'Away';
        pick.matchName = pick.partita || `${pick.home} - ${pick.away}`;

        // Loghi (fallback a placeholder)
        pick.homeLogo = pick.homeLogo || window.DEFAULT_LOGO_BASE64;
        pick.awayLogo = pick.awayLogo || window.DEFAULT_LOGO_BASE64;

        // Score (parse da liveData.score se disponibile)
        pick.homeScore = pick.homeScore ?? (parseInt(pick.liveData?.score?.split('-')[0]?.trim()) || 0);
        pick.awayScore = pick.awayScore ?? (parseInt(pick.liveData?.score?.split('-')[1]?.trim()) || 0);

        // Status e minuto
        pick.elapsed = pick.elapsed || pick.liveData?.elapsed || 0;
        pick.status = pick.status || pick.liveData?.status || 'NS';

        // Trading flags
        pick.hasTradingStrategy = true;
        pick.strategy = pick.strategy || 'TRADING';

        // 🐕 DEBUG: Log dati DOPO normalizzazione
        console.log(`[Trading Debug] Pick #${idx + 1} NORMALIZED:`, {
            home: pick.home,
            away: pick.away,
            homeScore: pick.homeScore,
            awayScore: pick.awayScore,
            elapsed: pick.elapsed,
            status: pick.status,
            strategy: pick.strategy,
            hasLiveStats: !!(pick.liveStats && Object.keys(pick.liveStats).length > 0)
        });

        return pick;
    });

    // 🔧 Usa createUniversalCard DIRETTAMENTE con il contesto corretto
    const cardsHtml = normalizedPicks.map(pick => {
        return window.createUniversalCard(pick, 0, 'trading', {
            detailedTrading: true
        }).outerHTML;
    }).join('');

    // 🩹 ANTI-COLLAPSE: Blocca altezza container prima del render
    // Questo impedisce al browser di resettare lo scroll se il contenuto sparisce per un istante
    if (container.offsetHeight > 500) {
        container.style.minHeight = container.offsetHeight + 'px';
    }

    container.innerHTML = cardsHtml;

    // RESTORE SCROLL (More aggressive)
    if (oldScroll > 0) {
        // Usa setTimeout per garantire che il rendering sia avvenuto
        requestAnimationFrame(() => {
            window.scrollTo(0, oldScroll);
            // Rilascia min-height dopo (opzionale, ma pulito)
            setTimeout(() => { container.style.minHeight = '300px'; }, 500);
        });
    }
}

// Helper to generate consistent Trading Pick IDs (ID-Pure Protocol)
// 🕵️‍♂️ DEBUG PROTOCOL: 5-Click Decoder
const debugCounters = new Map();
window.triggerMatchDebug = function (matchId, element) {
    const now = Date.now();
    const data = debugCounters.get(matchId) || { count: 0, last: 0 };
    if (now - data.last > 2000) data.count = 0;
    data.count++;
    data.last = now;
    debugCounters.set(matchId, data);
    if (data.count >= 5) {
        data.count = 0;
        const m = (window.unifiedMatchesCache || []).find(m => window.getMantraId(m) === matchId) || {};
        const liveHub = window.liveScoresHub ? window.liveScoresHub[matchId] : null;
        const report = `📊 SOCIO-DEBUG REPORT\n\nMatch: ${m.partita || '?'}\nID (Mantra): ${matchId}\nFixtureID API: ${m.fixtureId || '🔴 MANCANTE'}\nStatus Admin: ${m.status || 'N/A'}\nLive Data (Match): ${m.liveData ? '✅ PRESENTE' : '🔴 ASSENTE'}\nLive Hub (Sync): ${liveHub ? '✅ CONNESSO' : '🔴 DISCONNESSO'}\nOra/Data: ${m.ora} - ${m.data}\n\n-------------------\nSocio, se FixtureID è Rosso, l'Admin non ha mappato l'ID.\nSe LiveHub è Rosso, il server non sta inviando aggiornamenti!`;
        alert(report);
        console.log('[SocioDebug] Full Match Object:', m);
    }
};

// Helper to generate consistent Match IDs (FixtureID Mantra)
window.getMantraId = function (match) {
    if (!match) return null;
    // 🛡️ PROTOCOLLO SOCIO ID-PURE 🇨🇭
    // Il fixtureId è la LEGGE. Se manca, check su 'id' o 'matchId' (backup legacy sicuri).
    const rawId = match.fixtureId || match.id || match.matchId;
    return rawId ? String(rawId).trim() : null;
};

// Legacy support: reindirizziamo tutto al Mantra
window.getTradingPickId = function (input) {
    return window.getMantraId(input);
};

window.generateUniversalMatchId = function (match) {
    return window.getMantraId(match);
};

/**
 * 🏛️ MATCH AUTHORITY PROTOCOL (Swiss Precise Selection)
 * Gestisce la gerarchia delle tips:
 * 1. ELITE GOLD (winrate80%) -> Banner Oro, Tip Betmines.
 * 2. SCELTA MAGICA (magia_ai) -> Se tip concordi, Banner Magico + Quota AI.
 * 3. STANDARD (all) -> Dati Betmines.
 */
window.resolveMatchAuthority = function (match) {
    const matchId = window.getMantraId(match);
    let baseMatch = match;

    // 🔬 Se mancano dati base (comune nei Trading Picks), cerchiamo in 'all'
    if ((!match.tip || match.tip === '-') && window.strategiesData?.['all']) {
        const found = window.strategiesData['all'].matches?.find(m => window.getMantraId(m) === matchId);
        if (found) baseMatch = found;
    }

    let result = {
        tip: baseMatch.tip || '-',
        quota: baseMatch.quota || null,
        prob: baseMatch.probabilita || 0,
        badgeLabel: '',
        badgeClass: 'bg-purple-600 text-white',
        isElite: false,
        isMagia: false,
        boxBg: 'bg-blue-600/10 border-blue-500/30',
        boxBorder: 'border-blue-500/40',
        titleColor: 'text-blue-600',
        tipColor: 'text-slate-800'
    };

    if (!window.strategiesData) return result;

    // 🔬 FIND REFERENCES FOR CROSS-CHECKING
    const allMatch = window.strategiesData?.['all']?.matches?.find(m => window.getMantraId(m) === matchId);

    // Support multiple Magia AI variations (Pro and Special)
    const magiaPro = window.strategiesData?.['magia_ai_raw']?.matches?.find(m => window.getMantraId(m) === matchId);
    const magiaSpecial = window.strategiesData?.['___magia_ai']?.matches?.find(m => window.getMantraId(m) === matchId);

    const magiaMatch = magiaPro || magiaSpecial;

    // 1. ELITE CHECK (winrate_80 Strategy) 🥇
    const eliteStrat = window.strategiesData?.['winrate_80'] || Object.values(window.strategiesData || {}).find(s => s?.id === 'winrate80');
    const eliteMatchRef = eliteStrat?.matches?.find(m => window.getMantraId(m) === matchId);

    if (eliteMatchRef) {
        result.isElite = true;

        // ⚖️ SOCIO FALLBACK: If not in 'all', prioritize Magia AI data over the treating dash '-'
        if (!allMatch && magiaMatch && magiaMatch.magicStats) {
            result.tip = (magiaMatch.magicStats.tipMagiaAI || magiaMatch.tip || '-').toUpperCase();
            result.quota = magiaMatch.magicStats.oddMagiaAI || magiaMatch.quota;
            result.prob = magiaMatch.magicStats.probMagiaAI || magiaMatch.probabilita || 0;
        } else if (allMatch) {
            result.tip = allMatch.tip;
            result.quota = allMatch.quota;
            result.prob = allMatch.probabilita;
        }

        result.badgeLabel = 'ELITE GOLD';

        // 🪄 CONSENSUS CHECK: If Magia AI agrees with same tip
        if (magiaMatch) {
            const mTip = (magiaMatch.tip || magiaMatch.magicStats?.tipMagiaAI || '').toUpperCase().trim();
            const eTip = (result.tip || '').toUpperCase().trim();

            if (mTip && eTip && mTip === eTip && mTip !== '-') {
                result.isMagia = true;
                result.badgeLabel = 'ELITE 🥇 MAGIA 🪄';
            }
        }

        result.badgeClass = 'bg-black text-amber-400 border border-amber-400/50 shadow-xl font-black italic';
        result.boxBg = 'bg-gradient-to-br from-amber-400 via-yellow-200 to-amber-500 shadow-lg ring-2 ring-amber-300';
        result.boxBorder = 'border-amber-400';
        result.titleColor = 'text-amber-900';
        result.tipColor = 'text-amber-950';
        return result;
    }

    // 2. STANDARD MAGIA AI CHECK 🪄 (For non-elite matches)
    if (magiaMatch) {
        // Consensus with 'all' or original match
        const magiaTip = (magiaMatch.tip || magiaMatch.magicStats?.tipMagiaAI || '').toUpperCase().trim();
        const currentTip = (result.tip || '').toUpperCase().trim();

        if (magiaTip && currentTip && magiaTip === currentTip && magiaTip !== '-') {
            result.isMagia = true;
            result.badgeLabel = 'SCELTA MAGICA';
            result.badgeClass = 'bg-white text-indigo-700 border border-indigo-200 shadow-md font-black';
            result.boxBg = 'bg-indigo-600 border-indigo-400 shadow-[0_0_15px_rgba(79,70,229,0.3)]';
            result.boxBorder = 'border-indigo-400';
            result.titleColor = 'text-indigo-100';
            result.tipColor = 'text-white';

            if (magiaMatch.magicStats?.oddMagiaAI) result.quota = magiaMatch.magicStats.oddMagiaAI;
            else if (magiaMatch.quota) result.quota = magiaMatch.quota;
        }
    }

    return result;
};

/**
 * 🛰️ INVERTED INDEX SYNC (Scalable Notifications)
 * Adds/removes user from match_subscribers collection
 */
async function updateMatchSubscribers(fixtureId, isAdding, type, matchData = null) {
    if (!window.currentUser || !fixtureId) return;

    const chatId = window.currentUserProfile?.telegramChatId;
    if (!chatId) return console.log('[Sync] No Telegram chatId, skipping inverted index.');

    const subRef = doc(db, "match_subscribers", String(fixtureId));

    try {
        // 🛡️ IDEMPOTENT SYNC (Swiss Protocol)
        // Recuperiamo lo stato attuale per evitare duplicati causati dal timestamp nuovo ogni volta
        const snap = await getDoc(subRef);
        let subs = [];
        if (snap.exists()) {
            subs = snap.data().subscribers || [];
        }

        // Rimuoviamo sempre la vecchia entry di questo utente (se esiste)
        const filtered = subs.filter(s => s.userId !== window.currentUser.uid);

        if (isAdding) {
            // 🎯 DATA EXTRACTION: Ensure Tip & Timing are preserved for notifications
            const resolvedTip = (matchData?.tradingInstruction?.action) || matchData?.tip || matchData?.operazione || '';
            const resolvedTiming = matchData?.timing || matchData?.tradingInstruction?.timing || '';

            const subData = {
                userId: window.currentUser.uid,
                chatId: String(chatId),
                type: type,
                notifyKickoff: window.currentUserProfile?.notifyKickoff !== false,
                notifyGoal: window.currentUserProfile?.notifyGoal !== false,
                notifyResult: window.currentUserProfile?.notifyResult !== false,
                notifyLive: window.currentUserProfile?.notifyLive !== false,
                matchName: matchData?.partita || matchData?.matchName || '',
                tip: resolvedTip,
                timing: resolvedTiming,
                addedAt: new Date().toISOString()
            };
            filtered.push(subData);
            await setDoc(subRef, {
                subscribers: filtered,
                updatedAt: Timestamp.now()
            }, { merge: true });
            console.log(`[Sync] 🛰️ Subscribed to match ${fixtureId} (Type: ${type})`);
        } else {
            await setDoc(subRef, {
                subscribers: filtered,
                updatedAt: Timestamp.now()
            }, { merge: true });
            console.log(`[Sync] 🛰️ Unsubscribed from match ${fixtureId}`);
        }
    } catch (e) { console.error('[Sync] Inverted Index Error:', e); }
}

/**
 * 🔄 AUTO-SYNC: Garantisce che tutti i preferiti siano nel "Centralino Live" (match_subscribers)
 * Risolve i casi in cui il primo click fallisce per lag o profilo non caricato.
 */
window.syncAllFavoritesToSubscribers = async function () {
    if (!window.currentUser || !window.currentUserProfile?.telegramChatId) return;

    // Raccogliamo tutti i FixtureID unici dai preferiti
    const allFavIds = new Set();

    (window.tradingFavorites || []).forEach(id => {
        if (!isNaN(id)) allFavIds.add(id);
    });

    (window.selectedMatches || []).forEach(m => {
        if (m.fixtureId) allFavIds.add(String(m.fixtureId));
    });

    if (allFavIds.size === 0) return;

    console.log(`[Sync] 🔄 Centralino Live: Sincronia per ${allFavIds.size} match...`);

    for (const fId of allFavIds) {
        // Cerchiamo i dati del match se disponibili nella lista strategie
        const matchData = (window.selectedMatches || []).find(m => String(m.fixtureId) === fId);
        await updateMatchSubscribers(fId, true, 'auto_sync', matchData);
    }

    console.log('[Sync] ✅ Centralino Live aggiornato.');
};

window.loadTradingFavorites = async function () {
    if (!window.currentUser) return;
    try {
        const favDoc = await getDoc(doc(db, "user_favorites", window.currentUser.uid));
        if (favDoc.exists()) {
            const data = favDoc.data();
            // NEW: Support both legacy and unified paths
            const rawFavorites = data.tradingPicks || [];
            window.tradingFavorites = [...new Set(rawFavorites)];

            // BACKUP SYNC: If we find bettingPicks here, sync them to window.selectedMatches
            if (data.bettingPicks && Array.isArray(data.bettingPicks)) {
                window.selectedMatches = data.bettingPicks;
                if (window.updateMyMatchesCount) window.updateMyMatchesCount();
            }

            console.log('[Trading] Favorites loaded:', window.tradingFavorites.length);

            if (document.getElementById('page-my-matches')?.classList.contains('active')) {
                window.renderTradingFavoritesInStarTab();
            }

            // 🔥 NEW: Forza la sincronia live per tutti i preferiti caricati
            await window.syncAllFavoritesToSubscribers();
        }
    } catch (e) { console.error("Load Trading Favs Error", e); }
};

/**
 * 🏆 UNIFIED TOGGLE (FixtureID Mantra)
 * Una sola funzione per accendere la stella ovunque.
 */
window.toggleMatchFavorite = async function (matchData) {
    if (!window.currentUser) return alert("Accedi per salvare i preferiti");

    const matchId = window.getMantraId(matchData);
    if (!matchId) return console.error("[Mantra] Missing ID for match:", matchData);

    // 1. UPDATE LOCAL STATE (Unified)
    if (!Array.isArray(window.tradingFavorites)) window.tradingFavorites = [];
    if (!Array.isArray(window.selectedMatches)) window.selectedMatches = [];

    const tIdx = window.tradingFavorites.indexOf(matchId);
    const sIdx = window.selectedMatches.findIndex(m => window.getMantraId(m) === matchId);

    // Se è presente in almeno una lista, lo stiamo rimuovendo
    const isRemoving = (tIdx >= 0 || sIdx >= 0);
    const wasAdded = !isRemoving;

    if (isRemoving) {
        if (tIdx >= 0) window.tradingFavorites.splice(tIdx, 1);
        if (sIdx >= 0) window.selectedMatches.splice(sIdx, 1);
        console.log('[Mantra] ✕ Removed:', matchId);
    } else {
        window.tradingFavorites.push(matchId);
        window.selectedMatches.push({
            ...matchData,
            id: matchId,
            strategyId: matchData.strategyId || 'all'
        });
        console.log('[Mantra] ⭐ Added:', matchId);
    }

    // 2. UI SURGICAL UPDATE (Tutte le card con lo stesso ID)
    const btns = document.querySelectorAll(`button[data-match-id="${matchId}"]`);
    btns.forEach(btn => {
        const icon = btn.querySelector('i');
        if (!icon) return;
        const isLight = btn.classList.contains('text-yellow-500') || icon.classList.contains('text-yellow-500');
        const activeColor = isLight ? 'text-yellow-500' : 'text-yellow-300';
        const inactiveColor = isLight ? 'text-slate-300' : 'text-white/60';

        if (wasAdded) {
            btn.classList.add('flagged');
            icon.classList.remove('fa-regular', 'text-white/60', 'text-slate-300', 'text-white/70');
            icon.classList.add('fa-solid', 'drop-shadow-md', activeColor);
        } else {
            btn.classList.remove('flagged', 'text-yellow-300', 'text-yellow-500');
            icon.classList.remove('fa-solid', 'text-yellow-300', 'text-yellow-500', 'drop-shadow-md');
            icon.classList.add('fa-regular', inactiveColor);
        }
    });

    if (window.updateMyMatchesCount) window.updateMyMatchesCount();
    if (window.renderTradingFavoritesInStarTab) window.renderTradingFavoritesInStarTab();

    // 3. SYNC TO FIREBASE
    try {
        const userId = window.currentUser.uid;
        // Aggiorna user_favorites (Unified list)
        await setDoc(doc(db, "user_favorites", userId), {
            tradingPicks: window.tradingFavorites,
            bettingPicks: window.selectedMatches,
            updatedAt: new Date().toISOString()
        }, { merge: true });

        // Backup legacy per non rompere il backend esistente subito
        await setDoc(doc(db, "users", userId, "data", "selected_matches"), {
            matches: window.selectedMatches,
            updated: Date.now()
        });

        // Backend Sync (Inverted Index)
        if (matchData.fixtureId) {
            await updateMatchSubscribers(matchData.fixtureId, wasAdded, 'unified', matchData);
        }
    } catch (e) { console.error("[Mantra] Error saving favorites:", e); }
};

// Legacy Redirects
window.toggleTradingFavorite = async function (matchId, fixtureId = null) {
    // Cerchiamo i dati del match nei cache se possibile
    const match = (lastTradingPicksCache || []).find(p => window.getMantraId(p) === matchId);
    await window.toggleMatchFavorite(match || { fixtureId: matchId });
};

window.toggleFlag = async function (matchId, matchData = null) {
    if (matchData) {
        await window.toggleMatchFavorite(matchData);
    } else {
        // Cerca nei dati caricati
        let found = null;
        if (window.strategiesData) {
            for (const strat of Object.values(window.strategiesData)) {
                const matches = strat.matches || (Array.isArray(strat) ? strat : []);
                found = matches.find(x => window.getMantraId(x) === matchId);
                if (found) break;
            }
        }
        await window.toggleMatchFavorite(found || { fixtureId: matchId });
    }
};

window.renderTradingFavoritesInStarTab = function () {
    const picks = lastTradingPicksCache || [];
    const activeFavs = picks.filter(p => (window.tradingFavorites || []).includes(window.getTradingPickId(p)));
    window.activeTradingFavoritesCount = activeFavs.length;
    window.updateMyMatchesCount();

    // Clean up container just in case
    const container = document.getElementById('trading-favorites-container');
    if (!container) return;

    if (activeFavs.length === 0) {
        container.replaceChildren();
        return;
    }

    // Use unified renderLiveHubCard for trading favorites - sort by time
    const sortedFavs = [...activeFavs].sort((a, b) => (a.ora || '').localeCompare(b.ora || ''));
    let html = '';
    sortedFavs.forEach(pick => {
        // Merge with live data if available
        let liveData = null;
        const fId = pick.fixtureId ? String(pick.fixtureId) : null;
        if (fId && window.liveScoresHub) {
            liveData = window.liveScoresHub[fId] || Object.values(window.liveScoresHub).find(h => String(h.fixtureId) === fId);
        }

        const preparedMatch = {
            ...pick,
            matchName: pick.partita,
            home: pick.partita?.split(' - ')?.[0] || '',
            away: pick.partita?.split(' - ')?.[1] || '',
            // Handle multiple score formats
            homeScore: liveData?.homeScore ??
                (liveData?.score ? parseInt(liveData.score.split('-')[0]) : null) ??
                (pick.risultato ? parseInt(pick.risultato.split('-')[0]) : null) ??
                pick.homeScore ?? 0,
            awayScore: liveData?.awayScore ??
                (liveData?.score ? parseInt(liveData.score.split('-')[1]) : null) ??
                (pick.risultato ? parseInt(pick.risultato.split('-')[1]) : null) ??
                pick.awayScore ?? 0,
            elapsed: liveData?.elapsed ?? pick.elapsed ?? 0,
            status: liveData?.status ?? pick.status ?? 'NS',
            liveStats: liveData?.liveStats ?? pick.liveStats ?? {},
            events: liveData?.events ?? pick.events ?? [],
            homeLogo: liveData?.homeLogo || pick.homeLogo,
            awayLogo: liveData?.awayLogo || pick.awayLogo,
            hasTradingStrategy: true,
            strategy: pick.strategy,
            tradingInstruction: pick.tradingInstruction,
            reasoning: pick.reasoning,
            ora: pick.ora,
            matchDate: pick.data
        };
        html += window.renderLiveHubCard(preparedMatch);
    });
    container.innerHTML = html;
};

// ==================== MAIN FUNCTIONS ====================
onAuthStateChanged(auth, async (user) => {
    if (user) {
        window.currentUser = user;
        await loadUserProfile(user.uid);
        if (typeof window.loadEugenioPrompt === 'function') window.loadEugenioPrompt();

        document.getElementById('loading-overlay').classList.add('hidden');
        document.getElementById('login-container').classList.add('hidden');
        document.getElementById('app-container').classList.remove('hidden');

        // Init logic
        await loadData();
        initTradingPage(); // Start trading listener

        // Navigation Handler
        document.querySelectorAll('.nav-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const page = btn.dataset.page;
                window.showPage(page);
            });
        });

    } else {
        // User not authenticated - show login form and hide overlay
        document.getElementById('loading-overlay').classList.add('hidden');
        document.getElementById('login-container').classList.remove('hidden');
    }
});

// INITIALIZE INTERNAL FILTERS (Europa / Mondo chips)
function initInternalFilters() {
    document.querySelectorAll('.filter-chip').forEach(btn => {
        btn.onclick = (e) => {
            const filter = e.target.dataset.filter;
            currentSubFilter = filter;

            // UI Toggle
            e.target.parentElement.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('active'));
            e.target.classList.add('active');

            // Re-render using the current strategy as base
            const baseStrat = window.strategiesData[currentStrategyId] || window.strategiesData['all'];
            window.showRanking(currentStrategyId, baseStrat);
        };
    });

    // --- Search Feature Initialization ---
    const searchInput = document.getElementById('internal-search-input');
    const clearBtn = document.getElementById('clear-search-btn');

    if (searchInput) {
        searchInput.oninput = () => {
            const baseStrat = window.strategiesData[currentStrategyId] || window.strategiesData['all'];
            window.showRanking(currentStrategyId, baseStrat);
        };
    }

    if (clearBtn) {
        clearBtn.onclick = () => {
            if (searchInput) {
                searchInput.value = '';
                searchInput.focus();
                const baseStrat = window.strategiesData[currentStrategyId] || window.strategiesData['all'];
                window.showRanking(currentStrategyId, baseStrat);
            }
        };
    }
}
document.addEventListener('DOMContentLoaded', initInternalFilters);
// Also call it immediately just in case
initInternalFilters();

// Event Listeners for Strategy & Ranking Pages
const backToStrategiesBtn = document.getElementById('back-to-strategies');
if (backToStrategiesBtn) {
    backToStrategiesBtn.addEventListener('click', () => {
        const searchInput = document.getElementById('internal-search-input');
        if (searchInput) searchInput.value = ''; // Reset search on back
        window.showPage('strategies');
    });
}

const sortByScoreBtn = document.getElementById('sort-by-score');
if (sortByScoreBtn) {
    sortByScoreBtn.addEventListener('click', () => {
        if (currentStrategyId && window.strategiesData[currentStrategyId]) {
            window.showRanking(currentStrategyId, window.strategiesData[currentStrategyId], 'score');
        }
    });
}

const sortByTimeBtn = document.getElementById('sort-by-time');
if (sortByTimeBtn) {
    sortByTimeBtn.addEventListener('click', () => {
        if (currentStrategyId && window.strategiesData[currentStrategyId]) {
            window.showRanking(currentStrategyId, window.strategiesData[currentStrategyId], 'time');
        }
    });
}

// My Matches Sorting
const myMatchesSortScore = document.getElementById('my-matches-sort-score');
if (myMatchesSortScore) {
    myMatchesSortScore.addEventListener('click', () => {
        // Implement logic if needed, currently reusing logic or re-rendering my matches
        // For simplicity, we can just re-render if we had a render function exposed
    });
}

// Additional Listeners
document.getElementById('logout-btn')?.addEventListener('click', () => signOut(auth));

// Auth Form Listeners
document.getElementById('toggle-login')?.addEventListener('click', () => {
    isRegisterMode = false;
    document.getElementById('auth-title').textContent = 'Accedi a TipsterAI';
    document.getElementById('auth-submit-btn').textContent = 'Accedi';
    document.getElementById('name-field').classList.add('hidden');
    document.getElementById('toggle-login').classList.add('bg-purple-600', 'text-white');
    document.getElementById('toggle-login').classList.remove('text-gray-600');
    document.getElementById('toggle-register').classList.remove('bg-purple-600', 'text-white');
    document.getElementById('toggle-register').classList.add('text-gray-600');
    document.getElementById('forgot-password-link').classList.remove('hidden');
});

document.getElementById('toggle-register')?.addEventListener('click', () => {
    isRegisterMode = true;
    document.getElementById('auth-title').textContent = 'Registrati a TipsterAI';
    document.getElementById('auth-submit-btn').textContent = 'Registrati';
    document.getElementById('name-field').classList.remove('hidden');
    document.getElementById('toggle-register').classList.add('bg-purple-600', 'text-white');
    document.getElementById('toggle-register').classList.remove('text-gray-600');
    document.getElementById('toggle-login').classList.remove('bg-purple-600', 'text-white');
    document.getElementById('toggle-login').classList.add('text-gray-600');
    document.getElementById('forgot-password-link').classList.add('hidden');
});

document.getElementById('auth-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const emailValue = document.getElementById('email').value;
    const passwordValue = document.getElementById('password').value;
    const errorDiv = document.getElementById('auth-error');
    errorDiv.classList.add('hidden');

    try {
        if (isRegisterMode) {
            const userName = document.getElementById('user-name').value.trim();
            if (!userName) throw new Error('Nickname obbligatorio');

            const userCredential = await createUserWithEmailAndPassword(auth, emailValue, passwordValue);
            await setDoc(doc(db, "users", userCredential.user.uid), {
                name: userName,
                email: emailValue,
                createdAt: new Date().toISOString(),
                subscription: "free",
                telegramLinked: false
            });
        } else {
            await signInWithEmailAndPassword(auth, emailValue, passwordValue);
        }
    } catch (err) {
        errorDiv.textContent = err.message;
        errorDiv.classList.remove('hidden');
    }
});

const deleteAllMatchesBtn = document.getElementById('delete-all-matches-btn');
if (deleteAllMatchesBtn) {
    deleteAllMatchesBtn.addEventListener('click', async () => {
        if (!window.currentUser) return alert("Accedi per gestire i preferiti.");

        if (confirm("Sei sicuro di voler cancellare TUTTE le partite salvate (Strategie + Trading)?")) {
            try {
                // 1. COLLECT ALL FIXTURE IDs to clear Inverted Index
                const fixtureIdsToClear = new Set();

                // From Strategy Matches
                (window.selectedMatches || []).forEach(m => {
                    if (m.fixtureId) fixtureIdsToClear.add(String(m.fixtureId));
                });

                // From Trading Favorites (We need to map IDs to fixtureIds if possible, 
                // but since we keep reference in window.tradingFavorites, if they are currently loaded 
                // we can find them in liveScoresHub or similar. 
                // To be safe, we clear everything we can find.)
                (window.tradingFavorites || []).forEach(tId => {
                    // Try to extract fixtureId from string if it follows 'trading_12345'
                    const match = tId.match(/trading_(\d+)/);
                    if (match) fixtureIdsToClear.add(match[1]);
                });

                // 2. CLEAR INVERTED INDEX (Sequential to avoid rate limits/overload)
                console.log(`[ClearAll] Cleaning ${fixtureIdsToClear.size} index entries...`);
                for (const fId of fixtureIdsToClear) {
                    await updateMatchSubscribers(fId, false, 'cleanup');
                }

                // 3. RESET LOCAL STATE
                window.selectedMatches = [];
                window.tradingFavorites = [];
                if (typeof tradingFavorites !== 'undefined') tradingFavorites = []; // Update local scope variable if exists

                // 4. SYNC TO FIREBASE (UNIFIED)
                await setDoc(doc(db, "user_favorites", window.currentUser.uid), {
                    tradingPicks: [],
                    bettingPicks: [],
                    updatedAt: new Date().toISOString()
                }, { merge: true });

                // 5. SYNC TO LEGACY PATH
                await setDoc(doc(db, "users", window.currentUser.uid, "data", "selected_matches"), {
                    matches: [],
                    updated: Date.now()
                });

                window.updateMyMatchesCount();
                alert("Tutti i preferiti cancellati correttamente.");
                window.location.reload();
            } catch (e) {
                console.error("[ClearAll] Error:", e);
                alert("Errore durante la cancellazione: " + e.message);
            }
        }
    });
}

async function loadUserProfile(uid) {
    console.log('[Profile] Loading for UID:', uid);
    try {
        const docSnap = await getDoc(doc(db, "users", uid));
        if (docSnap.exists()) {
            window.currentUserProfile = docSnap.data();
            const nick = window.currentUserProfile.name || 'Utente';
            const elHeader = document.getElementById('user-nickname-header');
            if (elHeader) elHeader.textContent = `Ciao, ${nick} ! 👋`;

            // Auto-populate account page if it's currently visible
            if (typeof window.populateAccountPage === 'function') {
                window.populateAccountPage();
            }
        }
    } catch (e) {
        console.error("Profile Error", e);
    }
}

async function loadData(dateToLoad = null) {
    const targetDate = dateToLoad || new Date().toISOString().split('T')[0];
    window.currentAppDate = targetDate; // Set global date for filtering

    if (strategiesUnsubscribe) {
        strategiesUnsubscribe();
        strategiesUnsubscribe = null;
    }

    try {
        // 🔥 FIX: Read strategies from SUBCOLLECTION, not document fields
        // Admin saves to: daily_strategies/{date}/strategies/{strategyId}
        const parentDocRef = doc(db, "daily_strategies", targetDate);
        const strategiesSubCol = collection(parentDocRef, "strategies");

        // Use onSnapshot on the subcollection for real-time updates
        strategiesUnsubscribe = onSnapshot(strategiesSubCol, async (snapshot) => {
            const approved = ['all', 'winrate_80', 'italia', 'top_eu', 'cups', 'best_05_ht', '___magia_ai', 'magia_ai', 'over_2_5_ai', 'top_del_giorno'];

            window.strategiesData = {};

            // SANITIZATION: Fix corrupt data (status missing) from backend
            const sanitizeMatch = (m) => {
                const hasRes = m.risultato && m.risultato.includes('-');
                const hasOutcome = m.esito && ['WIN', 'VINTO', 'LOSE', 'PERSO', 'VOID', 'RIMBORSATO', 'CASH_OUT'].includes(m.esito.toUpperCase());
                if (hasRes && hasOutcome && (!m.status || m.status === 'NS')) {
                    m.status = 'FT';
                }
            };

            if (!snapshot.empty) {
                snapshot.forEach(docSnap => {
                    const id = docSnap.id;
                    const strat = docSnap.data();
                    const isMagiaStrat = id.includes('magia');

                    if (id === 'top_del_giorno') return;

                    const isApproved = approved.includes(id) || isMagiaStrat || (strat && strat.method === 'poisson');

                    if (strat && (strat.name || isMagiaStrat) && isApproved) {
                        if (!strat.name) strat.name = "Magia AI";
                        if (strat.matches && Array.isArray(strat.matches)) {
                            // ⏱️ SOCIO PROTOCOL: Filter matches starting before 12:00
                            strat.matches = strat.matches.filter(m => {
                                if (!m.ora || !m.ora.includes(':')) return true;
                                const hour = parseInt(m.ora.split(':')[0]);
                                return hour >= 12;
                            });

                            strat.matches.forEach(m => {
                                sanitizeMatch(m);
                                m.stratId = id;
                            });
                        }
                        window.strategiesData[id] = strat;
                    }
                });
            }

            // SOCIO: Carica top_del_giorno da daily_trading_picks e normalizza i dati
            try {
                const tradingSnap = await getDoc(doc(db, "daily_trading_picks", targetDate));
                if (tradingSnap.exists()) {
                    const tradingData = tradingSnap.data();
                    const picks = tradingData.picks || [];
                    console.log(`[LoadData] Loaded ${picks.length} Trading picks from daily_trading_picks`);

                    // Normalizzazione dati
                    picks.forEach(p => {
                        const ti = p.tradingInstruction;
                        if (ti && typeof ti === 'object') {
                            const action = ti.action || 'Trading';
                            const entryTiming = ti.entry?.timing || '';
                            const exitTiming = ti.exit?.timing || '';
                            // FIXED: store formatted string in a separate property, keep original object
                            p.displayInstruction = `${action} | ${entryTiming} → ${exitTiming}`.replace(/\|  →/g, '').trim();
                        } else if (!ti) {
                            p.displayInstruction = "MONITORAGGIO ATTIVO";
                        }

                        p.hasTradingStrategy = true;
                        if (!p.strategy || p.strategy === 'undefined') {
                            p.strategy = p.strategyLabel || 'TRADING';
                        }
                    });

                    window.strategiesData['top_del_giorno'] = {
                        name: '🚀 Trading',
                        matches: picks
                    };
                }
            } catch (tradingErr) {
                console.warn('[LoadData] Error loading trading picks:', tradingErr);
            }

            // Re-renderizza
            renderStrategies();
            if (window.updateDateDisplay) window.updateDateDisplay(targetDate, true);

            // RE-RENDER PAGES IF ACTIVE (Preserving scroll)
            const activePageId = document.querySelector('.page.active')?.id;
            const scrollPos = window.scrollY;

            if (currentStrategyId && activePageId === 'page-ranking') {
                window.showRanking(currentStrategyId, window.strategiesData[currentStrategyId], currentSortMode);
            } else if (activePageId === 'page-my-matches') {
                window.showMyMatches();
            }

            if (scrollPos > 0) {
                window.scrollTo(0, scrollPos);
            }
        });

        // Load Favorites (Unified First, Legacy Fallback)
        if (!dateToLoad && window.currentUser) {
            const favDoc = await getDoc(doc(db, "user_favorites", window.currentUser.uid));
            if (favDoc.exists()) {
                const data = favDoc.data();
                if (data.bettingPicks) window.selectedMatches = data.bettingPicks;
                if (data.tradingPicks) window.tradingFavorites = data.tradingPicks;

                if (window.updateMyMatchesCount) window.updateMyMatchesCount();
            } else {
                // Legacy Fallback
                const userMatches = await getDoc(doc(db, "users", window.currentUser.uid, "data", "selected_matches"));
                if (userMatches.exists()) {
                    window.selectedMatches = userMatches.data().matches || [];
                    if (window.updateMyMatchesCount) window.updateMyMatchesCount();
                }
            }
        }

        // Load Warning Stats for Standard
        const wStats = await getDoc(doc(db, "system", "warning_stats"));
        if (wStats.exists()) warningStats = wStats.data();

        // START LIVE HUB LISTENER
        initLiveHubListener();

        await renderStats();

    } catch (e) {
        console.error("Load Data Error", e);
    }
}

async function renderStats() {
    try {
        // Read pre-calculated stats from system/global_stats (populated by admin)
        const statsDoc = await getDoc(doc(db, "system", "global_stats"));

        if (statsDoc.exists()) {
            const stats = statsDoc.data();

            // Update Global Stats for AI
            window.globalStats = {
                total: stats.total || 0,
                wins: stats.wins || 0,
                losses: stats.losses || 0,
                winrate: stats.winrate || 0
            };

            document.getElementById('stat-total').textContent = stats.total || 0;
            document.getElementById('stat-wins').textContent = stats.wins || 0;
            document.getElementById('stat-losses').textContent = stats.losses || 0;
            document.getElementById('stat-winrate').textContent = (stats.winrate || 0) + '%';
            const displayDate = window.currentAppDate || stats.lastUpdate || new Date().toISOString().split('T')[0];
            document.getElementById('last-update').textContent = formatDateLong(displayDate);
        } else {
            console.warn('[Stats] No global_stats found in system collection');
            // Set defaults
            document.getElementById('stat-total').textContent = '0';
            document.getElementById('stat-wins').textContent = '0';
            document.getElementById('stat-losses').textContent = '0';
            document.getElementById('stat-winrate').textContent = '0%';
            document.getElementById('last-update').textContent = formatDateLong(new Date().toISOString().split('T')[0]);
        }
    } catch (e) {
        console.error('Error loading stats:', e);
        // Set defaults on error
        document.getElementById('stat-total').textContent = '0';
        document.getElementById('stat-wins').textContent = '0';
        document.getElementById('stat-losses').textContent = '0';
        document.getElementById('stat-winrate').textContent = '0%';
        document.getElementById('last-update').textContent = formatDateLong(new Date().toISOString().split('T')[0]);
    }
}

// INIT LIVE HUB LISTENER
// Purpose: Listen for real-time score updates from Firestore
// INIT LIVE HUB LISTENER
// Purpose: Listen for real-time score updates from Firestore
function initLiveHubListener() {
    if (liveHubUnsubscribe) liveHubUnsubscribe();

    // FIX: Use Timestamp.fromDate() for correct Firestore comparison
    // Raw Date objects don't compare correctly with Firestore Timestamps
    const twentyFourHoursAgo = new Date();
    twentyFourHoursAgo.setHours(twentyFourHoursAgo.getHours() - 24);
    const twentyFourHoursAgoTimestamp = Timestamp.fromDate(twentyFourHoursAgo);

    const q = query(
        collection(db, "live_scores_hub"),
        where("updatedAt", ">=", twentyFourHoursAgoTimestamp)
    );

    liveHubUnsubscribe = onSnapshot(q, (snapshot) => {
        const changesCount = snapshot.docChanges().length;
        const now = new Date();
        console.log(`[LiveHub] 📡 Received ${changesCount} matches (last 24h) from Firestore at ${now.toLocaleTimeString()}`);

        // Check for MODIFIED events specifically
        let modifiedCount = 0;
        let addedCount = 0;

        snapshot.docChanges().forEach((change) => {
            const data = change.doc.data();
            const id = change.doc.id;

            if (change.type === 'modified') modifiedCount++;
            if (change.type === 'added') addedCount++;

            // Summary log avoided for each document to reduce noise

            if (change.type === "removed") {
                delete window.liveScoresHub[id];
            } else {
                window.liveScoresHub[id] = data;
            }
        });

        console.log(`[LiveHub] 📊 Summary: ${addedCount} ADDED, ${modifiedCount} MODIFIED`);

        // SIMPLIFIED LIVE UPDATE: Refresh ALL active views when data changes
        clearTimeout(_liveUpdateDebounceTimer);
        _liveUpdateDebounceTimer = setTimeout(() => {
            console.log('[LiveHub] Live data updated, refreshing active views...');

            const activePage = document.querySelector('.page.active');
            const activePageId = activePage?.id || 'unknown';
            const scrollPos = window.scrollY; // 🛡️ SAVE SCROLL

            console.log(`[LiveHub] Active page: ${activePageId}`);

            switch (activePageId) {
                case 'page-trading-sportivo':
                    if (window.renderTradingCards && window.lastTradingPicksCache) {
                        console.log('[LiveHub] Updating Trading Page...');
                        window.renderTradingCards(window.lastTradingPicksCache);
                    }
                    break;
                case 'page-strategies': // Handles "Top Live" cards
                    // Search for strategy matches displayed, usually Top Live
                    // console.log('[LiveHub] Updating Strategy Page Cards...');
                    // Iterate all live hub data to update visible cards
                    Object.values(window.liveScoresHub).forEach(updatedMatch => {
                        const strategiesContainer = document.getElementById('strategies-container');
                        if (!strategiesContainer) return;

                        // Try to find the card by data-match-id (assumed) or similar
                        // console.log(`[LiveHub] Looking for card for: ${updatedMatch.matchName}`);
                    });
                    break;
                case 'page-ranking':
                    if (currentStrategyId && window.strategiesData?.[currentStrategyId]) {
                        window.showRanking(currentStrategyId, window.strategiesData[currentStrategyId], currentSortMode);
                    }
                    break;
                case 'page-my-matches':
                case 'page-star':
                    if (typeof window.showMyMatches === 'function') window.showMyMatches();
                    break;
                case 'page-live':
                    // 🛡️ NO FLASH: Update only if needed, or don't clear container
                    if (typeof window.loadLiveHubMatches === 'function') window.loadLiveHubMatches();
                    break;
            }

            // 🛡️ RESTORE SCROLL
            if (scrollPos > 0) {
                window.scrollTo(0, scrollPos);
            }
        }, DEBOUNCE_MS);


        // Global Badge Update - ONLY count TODAY's LIVE matches from MAJOR LEAGUES with TRADING
        const today = new Date().toISOString().split('T')[0];
        const allMatches = Object.values(window.liveScoresHub);

        // Same leagues filter as in loadLiveHubMatches
        const MAJOR_LEAGUES = [
            135, 136, 39, 40, 41, 140, 78, 79, 61, 88, 94, 207, 235, 144, 203, 2, 3, 848, 137, 45, 143
        ];

        // 🛡️ Filter by Trading Strategies (align with Radar Live)
        const tradingPicks = window.strategiesData?.['top_del_giorno']?.matches || [];
        const tradingPicksNames = new Set(tradingPicks.map(p => (p.partita || '').toLowerCase().replace(/\s+/g, '')));
        const tradingPicksIds = new Set(tradingPicks.map(p => String(p.fixtureId || '')));

        const todayLiveMatches = allMatches.filter(m => {
            const isToday = (m.matchDate || '').startsWith(today);
            const isLive = ['1H', '2H', 'HT', 'ET', 'P', 'LIVE', 'BT'].includes((m.status || '').toUpperCase());
            const isMajorLeague = !m.leagueId || MAJOR_LEAGUES.includes(m.leagueId);

            // Match must also be a trading pick
            const matchNameNorm = (m.matchName || '').toLowerCase().replace(/\s+/g, '');
            const fid = String(m.fixtureId || '');
            const isTradingMatch = tradingPicksNames.has(matchNameNorm) || tradingPicksIds.has(fid);

            return isToday && isLive && isMajorLeague && isTradingMatch;
        });

        // De-duplicate by matchName
        const seen = new Set();
        const uniqueMatches = todayLiveMatches.filter(m => {
            const key = (m.matchName || '').toLowerCase().replace(/\s+/g, '');
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });

        const liveCount = uniqueMatches.length;
        const liveBadge = document.getElementById('live-badge');
        if (liveBadge) {
            if (liveCount > 0) {
                liveBadge.innerText = liveCount;
                liveBadge.classList.remove('hidden');
            } else {
                liveBadge.classList.add('hidden');
            }
        }
    });
}

function renderStrategies() {
    const container = document.getElementById('strategies-grid');
    if (!container) return;

    // INVISIBLE UPDATE PROTOCOL: Hide, update, restore
    const oldScroll = window.scrollY;
    const oldHeight = container.offsetHeight;

    container.style.visibility = 'hidden';
    if (oldHeight > 0) container.style.minHeight = `${oldHeight}px`;

    // AGGREGATE DATA (Unified to catch all AI stats)
    const unifiedMatches = getUnifiedMatches();
    const topLiveStrat = window.strategiesData['top_del_giorno'];

    // Counts (Case-Insensitive)
    const countTopLive = topLiveStrat?.matches?.length || 0;
    const countItalia = unifiedMatches.filter(m => (m.lega || '').toLowerCase().startsWith('eu-ita')).length;
    const countEuropa = unifiedMatches.filter(m => {
        const l = (m.lega || '').toLowerCase();
        return l.startsWith('eu-') && !l.startsWith('eu-ita');
    }).length;
    const countAfrica = unifiedMatches.filter(m => (m.lega || '').toLowerCase().startsWith('af-')).length;
    const countMondo = unifiedMatches.filter(m => {
        const l = (m.lega || '').toLowerCase();
        return l !== '' && !l.startsWith('eu-') && !l.startsWith('af-');
    }).length;

    const children = [];

    // 1. TOP LIVE (Emerald/Teal) -> TRADING
    children.push(createBigBucketBox('top_live', '🚀 TRADING', countTopLive, 'bg-gradient-to-br from-emerald-500 to-teal-600', '📡', true));

    // 2. ITALIA (Azzurro Premium)
    children.push(createBigBucketBox('italia', '🇮🇹 Italia', countItalia, 'bg-gradient-to-br from-blue-600 to-indigo-800', '🇮🇹'));

    // 3. EUROPA (Blue Premium)
    children.push(createBigBucketBox('europa', '🇪🇺 Europa', countEuropa, 'bg-gradient-to-br from-blue-800 to-indigo-950', '🇪🇺'));

    // 3.5 AFRICA (Green/Yellow Premium)
    children.push(createBigBucketBox('africa', '🌍 Africa', countAfrica, 'bg-gradient-to-br from-green-600 to-yellow-700', '🌍'));

    // 4. RESTO DEL MONDO (Yellow/Amber)
    children.push(createBigBucketBox('mondo', '🌎 Mondo', countMondo, 'bg-gradient-to-br from-amber-400 to-orange-600', '🌎'));

    // Step 3: Swap DOM
    container.replaceChildren(...children);

    // Step 4: Restore scroll BEFORE making visible
    if (oldScroll > 0) window.scrollTo({ top: oldScroll, behavior: 'instant' });

    // Step 5: Make visible again
    requestAnimationFrame(() => {
        container.style.visibility = '';
        container.style.minHeight = '';
    });
}

function createBigBucketBox(id, title, count, gradient, icon, isTopLive = false) {
    const div = document.createElement('div');
    // LONG RECTANGULAR LAYOUT: Reduced padding-y (p-4 instead of p-6) and changed border radius
    div.className = `${gradient} text-white rounded-2xl p-5 shadow-lg w-full text-left relative overflow-hidden transition-all active:scale-[0.98] cursor-pointer border border-white/20 mb-1 flex items-center justify-between group`;

    let liveBadge = '';
    if (isTopLive) {
        const liveHubMap = window.liveScoresHub || {};
        const LIVE_STATUSES = ['1H', '2H', 'HT', 'LIVE', 'ET', 'P'];
        const topMatches = window.strategiesData?.['top_del_giorno']?.matches || [];
        const hasLive = topMatches.some(am => {
            const hubMatch = liveHubMap[am.id] || Object.values(liveHubMap).find(h => h.matchName === am.partita || h.fixtureId === am.fixtureId);
            return hubMatch && LIVE_STATUSES.includes((hubMatch.status || '').toUpperCase());
        });

        if (hasLive) {
            liveBadge = `
                <div class="flex items-center gap-1.5 bg-white/20 px-2 py-0.5 rounded-full backdrop-blur-md border border-white/30 ml-2">
                    <span class="relative flex h-2 w-2">
                        <span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-white opacity-75"></span>
                        <span class="relative inline-flex rounded-full h-2 w-2 bg-white"></span>
                    </span>
                    <span class="text-[9px] font-black uppercase tracking-tighter">LIVE NOW</span>
                </div>`;
        }
    }
    let extraDecoration = '';
    let bgImage = '';

    // ASSET PATHS (Updated with generated premium visuals)
    // ASSET PATHS (Updated with generated premium visuals)
    const ASSETS = {
        italia: 'img/flag_italy.png',
        europa: 'img/flag_europe.png',
        africa: 'img/flag_africa.png',
        mondo: 'img/globe_world.png'
    };

    if (id === 'italia') {
        bgImage = ASSETS.italia;
        extraDecoration = `<div class="absolute top-0 left-0 w-full h-[4px] flex z-20 shadow-sm">
            <div class="h-full w-1/3 bg-[#009246]"></div>
            <div class="h-full w-1/3 bg-white"></div>
            <div class="h-full w-1/3 bg-[#ce2b37]"></div>
        </div>`;
    } else if (id === 'europa') {
        bgImage = ASSETS.europa;
        extraDecoration = `<div class="absolute inset-0 z-0 opacity-20 mix-blend-overlay pointer-events-none animate-pulse-slow" style="background-image: radial-gradient(circle, #ffcc00 1.5px, transparent 1.5px); background-size: 30px 30px;"></div>`;
    } else if (id === 'africa') {
        bgImage = ASSETS.africa;
    } else if (id === 'mondo') {
        bgImage = ASSETS.mondo;
    }

    const bgLayer = bgImage ? `<div class="absolute inset-0 z-0 bg-cover bg-center opacity-60 mix-blend-luminosity scale-110 group-hover:scale-100 transition-transform duration-700" style="background-image: url('${bgImage}')"></div>` : '';
    const overlayLayer = `<div class="absolute inset-0 z-10 bg-gradient-to-t from-black/60 via-transparent to-black/20 group-hover:from-black/40 transition-all duration-500"></div>`;

    div.innerHTML = `
        ${bgLayer}
        ${overlayLayer}
        ${extraDecoration}
        
        <!-- Search Icon Trigger (Top Right) -->
        <div class="absolute top-4 right-4 z-30 opacity-60 hover:opacity-100 hover:scale-120 transition-all search-trigger p-2" title="Cerca in questa categoria">
            <i class="fa-solid fa-magnifying-glass text-lg shadow-sm"></i>
        </div>
        
        <div class="relative z-20 flex items-center justify-between w-full">
            <div class="flex items-center gap-4">
                <div class="w-14 h-14 rounded-2xl bg-white/20 flex items-center justify-center text-4xl shadow-[inset_0_0_15px_rgba(255,255,255,0.2)] border border-white/30 group-hover:scale-110 group-hover:rotate-3 transition-all duration-500 backdrop-blur-md">
                    ${icon}
                </div>
                <div class="flex flex-col">
                    <div class="flex items-center gap-2">
                        <span class="text-2xl font-black text-white leading-tight uppercase tracking-tight drop-shadow-lg">${title}</span>
                        ${liveBadge}
                    </div>
                    <span class="text-[11px] text-white/80 font-bold uppercase tracking-[0.2em] mt-1 drop-shadow-md">
                        <span class="inline-block w-2 h-2 rounded-full bg-white/50 mr-1 animate-pulse"></span>
                        ${count} Partite Disponibili
                    </span>
                </div>
            </div>
            
            <div class="opacity-80 group-hover:opacity-100 group-hover:translate-x-2 transition-all duration-500">
                <i class="fa-solid fa-chevron-right text-2xl drop-shadow-lg"></i>
            </div>
        </div>

        <!-- Hero background icon -->
        <div class="absolute right-[-20px] bottom-[-20px] text-9xl opacity-20 blur-[2px] transition-all duration-700 group-hover:opacity-30 group-hover:scale-110 group-hover:rotate-0 rotate-12 pointer-events-none z-0">${icon}</div>
    `;

    div.onclick = (e) => {
        const isSearchTrigger = e.target.closest('.search-trigger');

        if (id === 'top_live') {
            window.showRanking('top_del_giorno', window.strategiesData['top_del_giorno']);
        } else {
            window.showRanking(id, window.strategiesData['all']);
        }

        // If search was clicked, focus the input
        if (isSearchTrigger) {
            setTimeout(() => {
                const searchInput = document.getElementById('internal-search-input');
                if (searchInput) searchInput.focus();
            }, 100);
        }
    };

    return div;
}


function createStrategyBtn(id, strat) {
    const btn = document.createElement('button');
    const isMagic = id.includes('magia');
    const isAI = id.includes('ai') || isMagic;

    // AI strategies get ORANGE gradient, others get standard BLUE gradient
    const bgClass = isAI ? 'bg-gradient-to-br from-orange-500 to-amber-600' : 'bg-gradient-to-br from-indigo-600 to-indigo-800';

    // Compact padding and smaller typography for 2-column grid fit
    btn.className = `strategy-btn ${isMagic ? 'magic-ai' : ''} ${bgClass} text-white rounded-2xl p-3 shadow-lg w-full text-left relative overflow-hidden transition-transform active:scale-95 border border-white/10`;
    btn.onclick = () => window.showRanking(id, strat);

    btn.innerHTML = `
        <div class="relative z-10">
            <div class="text-lg font-black text-white leading-tight mb-0.5">${strat.name}</div>
            <div class="text-xs text-white/70 font-bold uppercase tracking-wider">${strat.totalMatches || strat.matches?.length || 0} Partite</div>
        </div>
        <div class="absolute right-[-8px] bottom-[-8px] text-5xl opacity-10 rotate-12">
            ${isAI ? '🪄' : '⚽'}
        </div>
    `;
    return btn;
}

function createTopDelGiornoBox() {
    const topStrat = window.strategiesData?.['top_del_giorno'];
    const adminMatches = topStrat?.matches || topStrat?.partite_by_tip?.all || [];
    const count = adminMatches.length;

    // Check for ACTUALLY LIVE matches (in corso = 1H, 2H, HT)
    const liveHubMap = window.liveScoresHub || {};
    const hubMatches = Object.values(liveHubMap);
    const LIVE_STATUSES = ['1H', '2H', 'HT', 'LIVE', 'ET', 'P'];
    const hasLive = adminMatches.some(am => {
        const hubMatch = liveHubMap[am.id] || hubMatches.find(h => h.matchName === am.partita || h.fixtureId === am.fixtureId);
        if (!hubMatch) return false;
        const status = (hubMatch.status || '').toUpperCase();
        return LIVE_STATUSES.includes(status);
    });

    const div = document.createElement('div');
    div.className = `bg-gradient-to-br from-emerald-500 to-teal-600 text-white rounded-2xl p-3 shadow-lg w-full text-left relative overflow-hidden border border-emerald-400/30 cursor-pointer transition-transform active:scale-95`;
    div.onclick = () => {
        if (topStrat) window.showRanking('top_del_giorno', topStrat);
        else window.showPage('page-live');
    };

    // Simple layout like other strategy buttons
    div.innerHTML = `
        <div class="relative z-10">
            <div class="text-lg font-black text-white leading-tight mb-0.5">🏆 Top Live</div>
            <div class="text-xs text-white/70 font-bold uppercase tracking-wider">${count} Partite</div>
            ${hasLive ? `<div class="absolute top-0 right-0 flex items-center gap-1 bg-white/20 px-1.5 py-0.5 rounded-full">
                <span class="relative flex h-2 w-2">
                    <span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-white opacity-75"></span>
                    <span class="relative inline-flex rounded-full h-2 w-2 bg-white"></span>
                </span>
                <span class="text-[10px] font-bold">Live Ora</span>
            </div>` : ''}
        </div>
        <div class="absolute right-[-8px] bottom-[-8px] text-5xl opacity-10 rotate-12">🏆</div>
    `;
    return div;
}



// ==================== LIVE HUB CARD RENDERER (Unified for Trading) ====================
window.renderLiveHubCard = function (match) {
    // 🟩 UNIFICAZIONE UI (Fase Finale): Una Partita = Una Identità
    // createUniversalCard ora gestisce tutto internamente tramite isTradingPick(match)

    // 1. Data Normalization (createUniversalCard relies on match.partita)
    if (!match.partita) {
        if (match.matchName) {
            match.partita = match.matchName.replace(' vs ', ' - ');
        } else if (match.homeTeam && match.awayTeam) {
            match.partita = `${match.homeTeam} - ${match.awayTeam}`;
        }
    }

    // 2. Delegate to Unified Card Creator
    // Passiamo 'live_hub' come stratId per indicare il contesto Live
    return window.createUniversalCard(match, 0, 'live_hub', {
        detailedTrading: true // Sempre dettagliato nel Live Hub
    }).outerHTML;
};


window.showRanking = function (stratId, data, sortMode = 'confidence') {
    if (!stratId) return;

    // VIRTUAL STRATEGIES: Italia/Europa/Mondo don't need external data
    const isVirtualStrategy = ['italia', 'europa', 'mondo'].includes(stratId);

    // If strat is missing, try to recover from global data (but skip for virtual strategies)
    if (!data && !isVirtualStrategy) data = window.strategiesData[stratId] || window.strategiesData['all'];
    if (!data && !isVirtualStrategy) return;

    // If switching strategy, reset sub-filter to 'all'
    if (currentStrategyId !== stratId) {
        currentSubFilter = 'all';
        document.querySelectorAll('.filter-chip').forEach(c => {
            c.classList.toggle('active', c.dataset.filter === 'all');
        });
    }

    currentStrategyId = stratId;
    window.showPage('ranking');
    const container = document.getElementById('matches-container');
    if (!container) return;

    // --- INTERNAL FILTERS UI LOGIC ---
    const filterBar = document.getElementById('internal-filter-bar');
    const europaFilters = document.getElementById('filters-europa');
    const mondoFilters = document.getElementById('filters-mondo');
    const titleNode = document.getElementById('strategy-title');

    if (filterBar) {
        const italiaFilters = document.getElementById('filters-italia');
        if (stratId === 'europa' || stratId === 'mondo' || stratId === 'italia' || stratId === 'top_del_giorno') {
            filterBar.classList.remove('hidden');
            if (europaFilters) europaFilters.classList.toggle('hidden', stratId !== 'europa');
            if (italiaFilters) italiaFilters.classList.toggle('hidden', stratId !== 'italia');
            if (mondoFilters) mondoFilters.classList.toggle('hidden', stratId !== 'mondo');

            if (stratId === 'europa') titleNode.textContent = '🇪🇺 Europa & AI';
            else if (stratId === 'italia') titleNode.textContent = '🇮🇹 Calcio Italiano';
            else if (stratId === 'mondo') titleNode.textContent = '🌎 Resto del Mondo';
            else titleNode.textContent = '🚀 TRADING TOP';
        } else {
            filterBar.classList.add('hidden');
            titleNode.textContent = data?.name || 'Strategia';
        }
    }

    // BASE FILTERING (Italia vs Europa vs Mondo)
    let filtered = [];
    if (stratId === 'europa' || stratId === 'mondo' || stratId === 'italia') {
        filtered = getUnifiedMatches();
    } else {
        filtered = [...(data.matches || [])];
    }

    if (stratId === 'italia') {
        filtered = filtered.filter(m => (m.lega || '').toLowerCase().startsWith('eu-ita'));
    } else if (stratId === 'europa') {
        filtered = filtered.filter(m => {
            const l = m.lega || '';
            return l.toLowerCase().startsWith('eu-') && !l.toLowerCase().startsWith('eu-ita');
        });
    } else if (stratId === 'mondo') {
        filtered = filtered.filter(m => (m.lega || '') !== '' && !(m.lega || '').toLowerCase().startsWith('eu-'));
    }

    // SUB-FILTERING (Italiane, Coppe, AI, etc.)
    filtered = applyInternalFiltering(filtered, currentSubFilter);

    // SEARCH FILTERING
    const searchInput = document.getElementById('internal-search-input');
    const query = (searchInput?.value || '').toLowerCase().trim();
    const clearBtn = document.getElementById('clear-search-btn');

    if (query) {
        if (clearBtn) clearBtn.classList.remove('hidden');
        filtered = filtered.filter(m => {
            const league = (m.lega || '').toLowerCase();
            const home = (m.home || m.homeTeam || '').toLowerCase();
            const away = (m.away || m.awayTeam || '').toLowerCase();
            const matchName = (m.matchName || m.partita || '').toLowerCase();
            return league.includes(query) || home.includes(query) || away.includes(query) || matchName.includes(query);
        });
    } else {
        if (clearBtn) clearBtn.classList.add('hidden');
    }

    // ANTI-FLICKER
    const dataHash = getDataHash(filtered) + getDataHash(window.liveScoresHub) + currentSubFilter;
    if (_lastRenderCache.rankingHash === dataHash) {
        return;
    }
    _lastRenderCache.rankingHash = dataHash;

    const oldScroll = window.scrollY;
    const oldHeight = container.offsetHeight;

    // 🛡️ ELIMINAZIONE FLASH: No visibility = 'hidden'
    if (oldHeight > 0) container.style.minHeight = `${oldHeight}px`;

    if (filtered.length === 0) {
        container.replaceChildren();
        const msg = document.createElement('div');
        msg.className = 'text-center py-10 text-gray-400';
        msg.textContent = 'Nessuna partita per questo filtro.';
        container.appendChild(msg);
    } else {
        const sorted = [...filtered].sort((a, b) => (a.ora || '').localeCompare(b.ora || ''));

        const enrichedMatches = sorted.map(m => {
            // MERGE LIVE DATA (Universal for all strategies)
            const fId = m.fixtureId ? String(m.fixtureId) : null;
            let liveData = null;

            // 1. Try ID Match
            if (fId && window.liveScoresHub) {
                liveData = window.liveScoresHub[fId] || Object.values(window.liveScoresHub).find(h => String(h.fixtureId) === fId);
            }
            // 2. Try Name Match (Fallback)
            if (!liveData && window.liveScoresHub && m.partita) {
                const cleanName = m.partita.toLowerCase().replace(/[^a-z]/g, '');
                liveData = Object.values(window.liveScoresHub).find(h => {
                    const hubName = (h.matchName || '').toLowerCase().replace(/[^a-z]/g, '');
                    return hubName.includes(cleanName) || cleanName.includes(hubName);
                });
            }

            // Normalizzazione base
            const teamParts = (m.partita || '').split(' - ');

            // Un oggetto base unificato
            const merged = {
                ...m,
                // Prioritize Live Data
                homeScore: liveData && (liveData.homeScore ?? (liveData.score ? parseInt(liveData.score.split('-')[0]) : null)) !== null ? liveData.homeScore : m.homeScore,
                awayScore: liveData && (liveData.awayScore ?? (liveData.score ? parseInt(liveData.score.split('-')[1]) : null)) !== null ? liveData.awayScore : m.awayScore,
                elapsed: liveData?.elapsed ?? m.elapsed ?? 0,
                status: liveData?.status ?? m.status ?? 'NS',
                liveStats: liveData?.liveStats || m.liveStats || {},
                events: liveData?.events || m.events || [],
                // Fallback a valori calcolati se mancano
                home: m.home || m.homeTeam || teamParts[0]?.trim() || 'Home',
                away: m.away || m.awayTeam || teamParts[1]?.trim() || 'Away',
                homeLogo: liveData?.homeLogo || m.homeLogo || window.DEFAULT_LOGO_BASE64,
                awayLogo: liveData?.awayLogo || m.awayLogo || window.DEFAULT_LOGO_BASE64,
                matchName: m.partita || liveData?.matchName || `${teamParts[0]} - ${teamParts[1]}`
            };

            // Se i punteggi sono ancora null/undefined, prova a parsare m.risultato
            if (merged.homeScore == null && m.risultato) {
                const parts = m.risultato.split('-');
                if (parts.length === 2) {
                    merged.homeScore = parseInt(parts[0]);
                    merged.awayScore = parseInt(parts[1]);
                }
            }
            // Default finale a 0
            if (merged.homeScore == null) merged.homeScore = 0;
            if (merged.awayScore == null) merged.awayScore = 0;

            return merged;
        });

        // SOCIO: Se siamo nel Trading (top_del_giorno) O è una strategia di trading, usiamo la scheda Live Hub
        const isTradingPage = stratId === 'top_del_giorno' ||
            ['OVER25', 'OVER_25', 'BACK_OVER_25', 'LAY_THE_DRAW', 'LTD', 'HT_SNIPER', 'LTD_V2'].includes(stratId);

        if (isTradingPage) {
            let html = '';
            enrichedMatches.forEach((mergedMatch) => {
                mergedMatch.hasTradingStrategy = true;
                try {
                    html += window.renderLiveHubCard(mergedMatch);
                } catch (e) { console.error(e); }
            });

            if (!html) html = '<div class="text-center py-10 text-gray-400">Nessuna partita disponibile al momento.</div>';

            if (container.innerHTML !== html) {
                container.innerHTML = html;
            }
        } else {
            const children = enrichedMatches.map((m, idx) => {
                const isTradingMatch = m.isTrading || window.isTradingPick(m);
                return createUniversalCard(m, idx, stratId, {
                    detailedTrading: isTradingMatch,
                    isTrading: isTradingMatch
                });
            });
            const newHtml = children.map(c => c.outerHTML).join('');
            if (container.innerHTML !== newHtml) {
                container.innerHTML = newHtml;
            }
        }
    }

    container.style.minHeight = '';

    // RESTORE SCROLL (More aggressive)
    if (oldScroll > 0) {
        requestAnimationFrame(() => {
            window.scrollTo({ top: oldScroll, behavior: 'instant' });
        });
    }
}


// window.toggleFlag refactored above to redirect to toggleMatchFavorite

// Live Refresh Loop
let tradingLiveInterval = null;

function startTradingLiveRefresh() {
    if (tradingLiveInterval) clearInterval(tradingLiveInterval);
    tradingLiveInterval = setInterval(() => {
        // If we are on trading page, refresh main list
        if (document.getElementById('page-trading-sportivo')?.classList.contains('active')) {
            if (window.currentTradingDate) window.loadTradingPicks(window.currentTradingDate);
        }
        // If we are on star page, refresh favorites
        if (document.getElementById('page-my-matches')?.classList.contains('active') ||
            document.getElementById('page-star')?.classList.contains('active')) {
            if (window.renderTradingFavoritesInStarTab) window.renderTradingFavoritesInStarTab();
        }
    }, 60000);
}

window.showPage = function (pageId) {
    // Account Page Injection Hook
    if (pageId === 'account') {
        if (typeof window.injectAccountPage === 'function') window.injectAccountPage();
        if (typeof window.populateAccountPage === 'function') window.populateAccountPage();
    }

    // If trying to show ranking without a strategy selected, default to 'all'
    if (pageId === 'ranking' && !currentStrategyId) {
        window.showRanking('all', window.strategiesData['all']);
        return; // Exit to prevent re-showing the page
    }

    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));

    // Normalize IDs: account button uses data-page="account", map to index.html ID
    const domId = pageId === 'account' ? 'account-page' : `page-${pageId}`;
    const pageEl = document.getElementById(domId);

    if (pageEl) pageEl.classList.add('active');
    window.scrollTo(0, 0);

    if (pageId === 'star' || pageId === 'my-matches') {
        window.showMyMatches();
        if (window.renderTradingFavoritesInStarTab) window.renderTradingFavoritesInStarTab();
        startTradingLiveRefresh();
    } else if (pageId === 'tips' || pageId === 'trading-sportivo') {
        loadTipsPage();
        startTradingLiveRefresh();
    } else if (pageId === 'history') {
        window.loadHistory();
    } else if (pageId === 'live') {
        loadLiveHubMatches();
    } else {
        if (tradingLiveInterval) clearInterval(tradingLiveInterval);
    }
};

window.updateMyMatchesCount = function () {
    const navBtn = document.querySelector('[data-page="star"]') || document.querySelector('[data-page="my-matches"]');
    if (!navBtn) return;

    let countBadge = navBtn.querySelector('.count-badge');

    // Count BOTH Betting favorites AND Trading favorites
    // 🏆 CRITICAL: Exclude trading picks from betting count to avoid duplicates
    const bettingCount = (window.selectedMatches || []).filter(m => {
        if (window.isTradingPick(m)) return false;
        return m.data === window.currentAppDate;
    }).length;

    // 🏆 FIX: Only count Trading favorites that are present in today's active list
    const activeTradingCount = (window.lastTradingPicksCache || []).filter(p => {
        const pId = window.getTradingPickId ? window.getTradingPickId(p) : (p.partita || "");
        return (window.tradingFavorites || []).includes(pId);
    }).length;

    const totalCount = bettingCount + activeTradingCount;

    if (totalCount > 0) {
        if (!countBadge) {
            countBadge = document.createElement('span');
            countBadge.className = 'count-badge absolute -top-1 -right-1 bg-red-500 text-white text-xs rounded-full w-5 h-5 flex items-center justify-center font-bold z-50';
            navBtn.style.position = 'relative';
            navBtn.appendChild(countBadge);
        }
        countBadge.textContent = totalCount;
    } else if (countBadge) {
        countBadge.remove();
    }
};

window.showMyMatches = function (sortMode = 'score') {
    // 🔥 NEW: Sincronizzazione automatica quando l'utente entra nella tab
    if (window.syncAllFavoritesToSubscribers) window.syncAllFavoritesToSubscribers();

    const container = document.getElementById('my-matches-container');
    if (!container) return;

    // ANTI-FLICKER: Skip render if data hasn't changed
    const dataHash = getDataHash(window.selectedMatches);
    if (_lastRenderCache.myMatchesHash === dataHash) {
        console.log('[MyMatches Render] ⏭️ SKIPPED (data unchanged)');
        return;
    }
    _lastRenderCache.myMatchesHash = dataHash;

    // 1. Refresh scores from current strategiesData (if available)
    if (window.strategiesData) {
        window.selectedMatches = window.selectedMatches.map(sm => {
            const smId = sm.id || `${sm.data}_${sm.partita} `;
            let latestMatch = null;

            // STRATEGY-AWARE LOOKUP
            // 1. If it's a "Magia" strategy (any variation), check that specific list first/only to preserve its unique Tips.
            // 2. Otherwise, check 'all' (Source of Truth for standard matches).

            let sourceStrat = null;
            const isMagiaPick = sm.strategyId && sm.strategyId.toLowerCase().includes('magia');

            if (isMagiaPick) {
                // Try to find the exact Magia strategy loaded (could be ___magia_ai, magic_ai, etc.)
                // We search for a key in strategiesData that matches the saved ID or contains 'magia'
                sourceStrat = window.strategiesData[sm.strategyId] ||
                    Object.values(window.strategiesData).find(s => s.name && s.name.toLowerCase().includes('magia'));
            } else {
                sourceStrat = window.strategiesData['all'];
            }

            if (sourceStrat && sourceStrat.matches) {
                // Try Exact ID Match (using universal ID logic)
                let found = sourceStrat.matches.find(m => window.generateUniversalMatchId(m) === smId);

                // Fallback: Fuzzy Name Match
                if (!found) {
                    found = sourceStrat.matches.find(m => m.partita === sm.partita && m.data === sm.data);
                }

                if (found) {
                    latestMatch = found;
                }
            } else if (!isMagiaPick && window.strategiesData['all']) {
                // Double safety: if intended strategy not found, fallback to ALL for standard picks
                let found = window.strategiesData['all'].matches?.find(m => window.generateUniversalMatchId(m) === smId);
                if (found) latestMatch = found;
            }

            if (latestMatch) {
                // Merge everything relevant for live status
                return {
                    ...sm,
                    risultato: latestMatch.risultato || null,
                    esito: latestMatch.esito || null,
                    liveData: latestMatch.liveData || null,
                    liveStats: latestMatch.liveStats || null,
                    minute: latestMatch.minute || latestMatch.liveData?.minute || null
                };
            }
            return sm;
        });
    }

    // 2. Filter Betting Matches by DATE & STALENESS
    // 🏆 CRITICAL: Exclude trading picks (they go to tradingFavorites section)
    const bettingMatches = (window.selectedMatches || []).filter(m => {
        if (window.isTradingPick(m)) return false; // Trading picks handled separately
        return m.data === window.currentAppDate && !isMatchStale(m);

    });

    // Betting Favorites Section
    if (bettingMatches.length === 0) {
        const msg = document.createElement('div');
        msg.className = 'text-center text-gray-300 py-4 opacity-50';
        msg.textContent = 'Nessun pronostico salvato';
        container.replaceChildren(msg);
    } else {
        const sectionHeader = document.createElement('div');
        sectionHeader.className = 'mb-4';
        sectionHeader.innerHTML = '<div class="text-sm font-bold text-purple-300 flex items-center gap-2">⭐ PRONOSTICI SALVATI <span class="bg-purple-600 px-2 py-0.5 rounded text-xs">' + bettingMatches.length + '</span></div>';
        container.appendChild(sectionHeader);

        let sortedMatches = [...bettingMatches].sort((a, b) => {
            // ALWAYS sort by time as per user request to avoid UI instability
            if (!a.ora && !b.ora) return 0;
            if (!a.ora) return 1;
            if (!b.ora) return -1;
            return a.ora.localeCompare(b.ora);
        });

        const cards = sortedMatches.map((m, idx) => {
            try {
                const card = window.createUniversalCard(m, idx, m.strategyId || null, { detailedTrading: !!m.liveStats });

                // Replace flag button with delete button
                const flagBtn = card.querySelector('.flag-btn, button[data-match-id]');
                if (flagBtn) {
                    const matchId = window.generateUniversalMatchId(m);
                    flagBtn.innerHTML = '<i class="fa-solid fa-trash"></i>';
                    flagBtn.className = 'text-red-400 hover:text-red-600 transition text-xl ml-2';
                    flagBtn.onclick = (e) => {
                        e.stopPropagation();
                        window.removeMatch(matchId);
                    };
                }
                return card;
            } catch (e) {
                console.error('[showMyMatches] Error creating card:', e, m);
                return null;
            }
        }).filter(c => c !== null);

        container.replaceChildren(sectionHeader, ...cards);
    }
};

// Redundant sorting listeners removed as per request (Time is now the only sort)
// initMyMatchesListeners();

window.removeTradingFavorite = async function (pickId) {
    const idx = tradingFavorites.indexOf(pickId);
    if (idx >= 0) {
        tradingFavorites.splice(idx, 1);
        window.tradingFavorites = tradingFavorites; // Keep in sync
        window.updateMyMatchesCount();
        if (window.renderTradingFavoritesInStarTab) window.renderTradingFavoritesInStarTab();

        if (window.currentUser) {
            try {
                await setDoc(doc(db, "user_favorites", window.currentUser.uid), {
                    tradingPicks: tradingFavorites,
                    updatedAt: new Date().toISOString()
                }, { merge: true });
            } catch (e) {
                console.error("Error removing trading favorite:", e);
            }
        }
    }
};

window.removeMatch = async function (matchId) {
    const idx = window.selectedMatches.findIndex(m => {
        const id = window.generateUniversalMatchId(m);
        return id === matchId;
    });

    if (idx >= 0) {
        window.selectedMatches.splice(idx, 1);
        window.updateMyMatchesCount();

        // Re-render the list
        window.showMyMatches();

        // Save to Firebase
        if (window.currentUser) {
            try {
                // Sanitize to avoid "undefined" errors in Firestore
                const sanitizedMatches = JSON.parse(JSON.stringify(window.selectedMatches, (key, value) => {
                    return value === undefined ? null : value;
                }));

                await setDoc(doc(db, "users", window.currentUser.uid, "data", "selected_matches"), {
                    matches: sanitizedMatches,
                    updated: Date.now()
                });
            } catch (e) {
                console.error("Error removing match:", e);
            }
        }
    }
};



const STANDARD_STRATEGIES = ['all', 'italia', 'top_eu', 'cups', 'best_05_ht'];


// ==================== euGENIO CHATBOT LOGIC ====================
(function () {
    const chatWindow = document.getElementById('ai-chat-window');
    const toggleBtn = document.getElementById('toggle-chat-btn');
    const closeBtn = document.getElementById('close-chat-btn');
    const form = document.getElementById('chat-form');
    const input = document.getElementById('chat-input');
    const messagesContainer = document.getElementById('chat-messages');

    if (!chatWindow || !toggleBtn) return;

    let isOpen = false;
    let chatHistory = [];
    let hasWelcomed = false;
    let eugenioPromptCache = null;

    window.loadEugenioPrompt = async function () {
        try {
            const promptDoc = await window.getDoc(window.doc(window.db, "system_prompts", "eugenio"));
            if (promptDoc.exists()) {
                eugenioPromptCache = promptDoc.data();
                console.log('[Eugenio] ✅ Prompt loaded from Firebase');
            }
        } catch (e) {
            console.error('[Eugenio] ❌ Error loading prompt:', e);
        }
    };

    function getUserName() {
        if (window.currentUserProfile && window.currentUserProfile.name) {
            return window.currentUserProfile.name;
        }
        if (window.currentUser && window.currentUser.email) {
            const name = window.currentUser.email.split('@')[0];
            return name.charAt(0).toUpperCase() + name.slice(1);
        }
        return "Amico";
    }

    function buildSystemPrompt() {
        const userName = getUserName();
        const strategies = window.strategiesData || {};
        const stats = window.globalStats || { total: 0, wins: 0, losses: 0, winrate: 0 };

        const strategyDefinitions = {
            'magia_ai': 'Analisi LLM in tempo reale su pattern complessi e asimmetrie.',
            'special_ai': 'Algoritmi proprietari ad alta affidabilità.',
            'winrate_80': 'Storico vittorie superiore all\'80%.',
            'i_consigli': 'Socio Engine v5.0: Parlay (x2, x3, x4) con filtri tematici (Safe, Motivation, Over, Quota 5).',
            'elite_surge': 'Nuovo segnale Trading ad altissima confidenza basato su gap ELO massivo (>250).',
            'ht_sniper': 'Trading Over 0.5 HT. Ultra-selettivo: richiede confidenza 72% o spinte motivazionali.',
            'second_half_surge': 'Trading Over 1.5 o 2.5 nel secondo tempo con pressione estrema.',
            'lay_the_draw': 'Trading Exchange: Bancata del pareggio in match chiave (evita i "biscotti" negli scontri diretti).'
        };

        const liveTradingPersona = `Sei un esperto di TRADING SPORTIVO PROFESSIONALE (Elite Mode).
Quando analizzi dati live(DA, SOG, xG), focalizzati su:
1. Pressione offensiva(Goal Cooking).
2. Valore della quota rispetto al tempo rimanente.
3. Consigli operativi secchi(Entra, Resta, Cashout).
4. **ELO & Motivazione**: Spiega i gap tecnici (ELO Diff) e la "fame di punti" (Badges Titolo/Salvezza).
5. **Anti-Black Swan**: Sei nemico giurato delle quote "esca"(sotto 1.25). Portano rischio inutile.`;

        let strategiesText = Object.entries(strategies)
            .map(([id, s]) => {
                const def = strategyDefinitions[id] || s.description || 'Analisi statistica.';
                return `- ** ${s.name}**: ${def} `;
            })
            .join('\n') || "Strategie standard attive.";

        const basePrompt = eugenioPromptCache?.prompt ||
            `Sei ** euGENIO 🧞‍♂️**, l'interfaccia AI di Tipster-AI. Accompagni il trader nelle scelte quotidiane.

    ** IDENTITÀ:**
        - Tu: euGENIO(AI Trader Pro e Socio)
            - Utente: ** ${userName}** (il tuo Socio)

** FILOSOFIA OPERATIVA(Socio Engine v5.0):**
- ** No Junk Odds **: Puliamo il palinsesto dai "Cigni Neri"(quote < 1.25).
- ** ROI Target **: Puntiamo a raddoppiare(@2.00 +) ogni ticket consigliato.
- ** Data - Driven **: Analizzi xG, Pressione Gol, DA, SOG per trovare valore reale.

** TUE COMPETENZE:**
    ${liveTradingPersona}

** PERFORMANCE APP:**
    - ${stats.total} match analizzati | Winrate ${stats.winrate}%
        - Logica Parlay: Cassa Sicura(x2), Tridente(x3), Multiplona(x4).

** STRATEGIE DISPONIBILI OGGI:**
    ${strategiesText} `;

        return `${basePrompt}

${eugenioPromptCache?.customInstructions || ''}
${eugenioPromptCache?.additionalContext || ''}
${eugenioPromptCache?.tradingKnowledge || ''}

** REGOLE COMUNICAZIONE:**
    1. Conversazione normale: saluta ${userName} solo al primo messaggio
2. Analisi Profonda Live:
- Inizia con "Ok ${userName}:"
    - NO presentazioni, NO saluti ripetuti
        - Vai dritto ai dati e alle indicazioni
3. NON ripetere mai dati visibili(minuto, punteggio)
4. SPIEGA SEMPRE il PERCHÉ basandoti sui dati tecnici
5. Usa linguaggio professionale ma empatico
6. NO limiti di lunghezza - scrivi tutto quello che serve
7. Chiudi con indicazione operativa chiara e motivata`;



        return prompt;
    }

    function toggleChat() {
        isOpen = !isOpen;
        if (isOpen) {
            chatWindow.classList.remove('hidden');
            toggleBtn.classList.add('hidden');
            setTimeout(() => input.focus(), 100);

            if (!hasWelcomed) {
                const welcomeMsg = `Ciao ${getUserName()} ! 👋 Sono euGENIO 🧞‍♂️. Come posso aiutarti oggi ? `;
                appendMessage(welcomeMsg, 'ai');
                hasWelcomed = true;
            }
        } else {
            chatWindow.classList.add('hidden');
            toggleBtn.classList.remove('hidden');
        }
    }

    function appendMessage(text, sender) {
        const div = document.createElement('div');
        div.className = `flex ${sender === 'user' ? 'justify-end' : 'justify-start'} `;
        const bubble = document.createElement('div');
        bubble.className = sender === 'user'
            ? 'bg-purple-600 text-white rounded-2xl rounded-tr-none p-3 shadow-sm max-w-[85%]'
            : 'bg-white border border-gray-200 rounded-2xl rounded-tl-none p-3 shadow-sm max-w-[85%] text-gray-800';
        bubble.innerHTML = text;
        div.appendChild(bubble);
        messagesContainer.appendChild(div);
        setTimeout(() => {
            messagesContainer.scrollTo({ top: messagesContainer.scrollHeight, behavior: 'smooth' });
        }, 100);
    }


    function showLoading() {
        const div = document.createElement('div');
        div.id = 'ai-loading';
        div.className = 'flex justify-start';
        div.innerHTML = `<div class="bg-white border border-gray-200 rounded-2xl rounded-tl-none p-3 shadow-sm">
    <div class="flex gap-1">
        <div class="w-2 h-2 bg-gray-400 rounded-full animate-bounce"></div>
        <div class="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style="animation-delay: 0.2s"></div>
        <div class="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style="animation-delay: 0.4s"></div>
    </div>
        </div>`;
        messagesContainer.appendChild(div);
        messagesContainer.scrollTop = messagesContainer.scrollHeight;
    }

    toggleBtn.addEventListener('click', toggleChat);
    closeBtn.addEventListener('click', toggleChat);

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const text = input.value.trim();
        if (!text) return;

        input.value = '';
        appendMessage(text, 'user');
        processMessage(text);
    });

    // Unified message processor v2.3
    async function processMessage(text, hiddenAIPrompt = null) {
        showLoading();
        try {
            if (chatHistory.length === 0) {
                if (!eugenioPromptCache) await window.loadEugenioPrompt();
                chatHistory.push({ role: "user", parts: [{ text: buildSystemPrompt() }] });
                chatHistory.push({ role: "model", parts: [{ text: "Certamente! Sono pronto ad aiutarti." }] });
            }

            // Use hidden prompt if provided (from "Deep Analysis" buttons), else use user text
            const promptToSend = hiddenAIPrompt || text;
            chatHistory.push({ role: "user", parts: [{ text: promptToSend }] });

            const result = await window.chatWithGemini({
                contents: chatHistory,
                generationConfig: { temperature: 0.7, maxOutputTokens: 2048 }
            });


            const loading = document.getElementById('ai-loading');
            if (loading) loading.remove();

            const responseText = result.data?.candidates?.[0]?.content?.parts?.[0]?.text || "Scusa, non ho capito. 🧞‍♂️";
            chatHistory.push({ role: "model", parts: [{ text: responseText }] });

            const htmlText = responseText.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>').replace(/\n/g, '<br>');
            appendMessage(htmlText, 'ai'); // Typewriter disabled for now to prevent flickering

        } catch (err) {
            const loading = document.getElementById('ai-loading');
            if (loading) loading.remove();
            appendMessage("Ops! C'è stato un errore nel contattare euGENIO. 🧞‍♂️", 'ai');
        }
    }

    // Typewriter effect function v2.27
    async function typewriterMessage(htmlText, sender) {
        const div = document.createElement('div');
        div.className = `flex ${sender === 'user' ? 'justify-end' : 'justify-start'} `;
        const bubble = document.createElement('div');
        bubble.className = sender === 'user'
            ? 'bg-purple-600 text-white rounded-2xl rounded-tr-none p-3 shadow-sm max-w-[85%]'
            : 'bg-white border border-gray-200 rounded-2xl rounded-tl-none p-3 shadow-sm max-w-[85%] text-gray-800';
        bubble.innerHTML = ''; // Start empty
        div.appendChild(bubble);
        messagesContainer.appendChild(div);

        // Typewriter effect - write character by character
        let currentText = '';
        const speed = 15; // milliseconds per character

        for (let i = 0; i < htmlText.length; i++) {
            currentText += htmlText[i];
            bubble.innerHTML = currentText;

            // Auto-scroll while typing
            if (i % 5 === 0) { // Scroll every 5 characters for smoothness
                messagesContainer.scrollTo({ top: messagesContainer.scrollHeight, behavior: 'smooth' });
            }

            await new Promise(resolve => setTimeout(resolve, speed));
        }

        // Final scroll
        setTimeout(() => {
            messagesContainer.scrollTo({ top: messagesContainer.scrollHeight, behavior: 'smooth' });
        }, 100);
    }

    // NEW Component: Secret Payload Handler v2.3
    window.askEugenioDetailed = async function (visibleText, hiddenAIPrompt) {
        if (!isOpen) toggleChat();
        // Force history reset for specific match analysis to avoid confusion and token bloat
        chatHistory = [];
        appendMessage(visibleText, 'user');
        await processMessage(visibleText, hiddenAIPrompt);
    };


})();


// ==================== HISTORY (7 DAYS) LOGIC ====================
window.loadHistory = async function () {
    const container = document.getElementById('history-list');
    if (!container) return;
    container.innerHTML = '<div class="text-center text-gray-400 py-8">Caricamento storico...</div>';

    try {
        const today = new Date();
        const dates = [];

        // Last 7 COMPLETE days
        for (let i = 1; i <= 7; i++) {
            const date = new Date(today);
            date.setDate(date.getDate() - i);
            dates.push(date.toISOString().split('T')[0]);
        }

        const dateData = [];
        for (const date of dates) {
            let strategies = {};
            let hasStrategies = false;

            try {
                // NEW SOURCE: daily_strategies/{date}/strategies subcollection
                const parentDocRef = doc(db, "daily_strategies", date);
                const strategiesSubCol = collection(parentDocRef, "strategies");
                const querySnap = await getDocs(strategiesSubCol);

                console.log(`[History] Date: ${date} | Found ${querySnap.size} strategies in daily_strategies/${date}`);

                if (!querySnap.empty) {
                    querySnap.forEach(docSnap => {
                        const stratData = docSnap.data();
                        const stratId = docSnap.id;
                        // Map structure to expected format: stratData.name, stratData.matches
                        strategies[stratId] = { id: stratId, ...stratData };
                    });
                    hasStrategies = Object.keys(strategies).length > 0;
                }
            } catch (e) {
                console.warn(`[History] Failed to load from daily_strategies for ${date}`, e);
            }

            if (hasStrategies) {
                let totalWins = 0, totalLosses = 0, totalPending = 0;

                Object.values(strategies).forEach(strat => {
                    // Support both array and object formats for matches
                    let matchesRaw = strat.matches || strat.partite_by_tip || [];
                    let matches = [];

                    if (Array.isArray(matchesRaw)) {
                        matches = matchesRaw;
                    } else if (typeof matchesRaw === 'object' && matchesRaw !== null) {
                        // If it's an object grouped by tip, flatten it
                        matches = Object.values(matchesRaw).flat();
                    }

                    if (matches.length === 0) {
                        console.log(`[History] Strategy ${strat.id || 'unknown'} has no matches. Raw type: ${Array.isArray(matchesRaw) ? 'array' : typeof matchesRaw}`);
                    }

                    matches.forEach(m => {
                        // Fallback: calculate esito locally if missing but risultato exists
                        let esito = m.esito;
                        if (!esito && m.risultato && m.tip) {
                            esito = evaluateTipLocally(m.tip, m.risultato);
                            // Save computed esito back to object for display logic
                            m.esito = esito;
                        }

                        if (esito === 'Vinto') totalWins++;
                        else if (esito === 'Perso') totalLosses++;
                        else totalPending++;
                    });
                });

                dateData.push({ date, strategies, totalWins, totalLosses, totalPending, hasData: true });
            } else {
                dateData.push({ date, hasData: false });
            }

        }

        if (dateData.length === 0) {
            container.innerHTML = '<div class="text-center text-gray-400 py-8">Nessuno storico disponibile</div>';
            return;
        }

        container.innerHTML = dateData.map((data, index) => createHistoryDateCard(data, index)).join('');

        // Listeners for expand/collapse
        dateData.forEach((data, index) => {
            if (data.hasData) {
                const card = container.querySelector(`[data-date="${data.date}"]`);
                card.addEventListener('click', () => toggleDateDetails(data.date, data.strategies, card));
            }
        });

    } catch (e) {
        console.error('[History] Error:', e);
        container.innerHTML = '<div class="text-center text-red-400 py-8">Errore storico</div>';
    }
};

function createHistoryDateCard(data, index) {
    const { date, totalWins, totalLosses, totalPending, hasData } = data;
    const dateObj = new Date(date + 'T12:00:00');
    const dayName = ['Dom', 'Lun', 'Mar', 'Mer', 'Gio', 'Ven', 'Sab'][dateObj.getDay()];
    const dayNum = dateObj.getDate();
    const monthName = ['Gen', 'Feb', 'Mar', 'Apr', 'Mag', 'Giu', 'Lug', 'Ago', 'Set', 'Ott', 'Nov', 'Dic'][dateObj.getMonth()];

    if (!hasData) {
        return `<div class="bg-gray-800/50 rounded-xl p-4 opacity-50 mb-3"><div class="flex justify-between"><div><div class="text-sm text-gray-500">${dayName}, ${dayNum} ${monthName}</div></div><div class="text-sm text-gray-500">Nessun dato</div></div></div>`;
    }

    const totalMatches = totalWins + totalLosses;
    const winrate = totalMatches > 0 ? Math.round((totalWins / totalMatches) * 100) : 0;
    let winrateColor = winrate >= 70 ? 'text-green-400' : (winrate >= 50 ? 'text-yellow-400' : 'text-red-400');

    return `
    <div data-date="${date}" class="bg-gradient-to-r from-blue-900/50 to-purple-900/50 rounded-xl p-4 cursor-pointer hover:scale-[1.02] transition-transform mb-3">
            <div class="flex items-center justify-between mb-2">
                <div class="text-lg font-bold">${dayName}, ${dayNum} ${monthName}</div>
                <div class="text-right">
                    <div class="text-2xl font-black ${winrateColor}">${winrate}%</div>
                    <div class="text-xs text-gray-400 uppercase">winrate</div>
                </div>
            </div>
            <div class="flex items-center gap-4 text-sm font-bold">
                <span class="text-green-400">🟢 ${totalWins}V</span>
                <span class="text-red-400">🔴 ${totalLosses}P</span>
                ${totalPending > 0 ? `<span class="text-gray-400">⏳ ${totalPending}</span>` : ''}
            </div>
            <div id="details-${date}" class="hidden mt-4 pt-4 border-t border-white/20"></div>
        </div>
    `;
}

function toggleDateDetails(date, strategies, card) {
    const container = card.querySelector(`#details-${date}`);
    if (!container.classList.contains('hidden')) { container.classList.add('hidden'); return; }

    container.innerHTML = Object.entries(strategies).map(([id, strat]) => {
        // Sanitize ID for DOM selectors (remove spaces)
        const safeId = id.replace(/\s+/g, '_');

        const matches = strat.matches || [];
        const closed = matches.filter(m => m.risultato);
        if (closed.length === 0) return '';

        let wins = 0, losses = 0;
        closed.forEach(m => {
            if (m.esito === 'Vinto') wins++;
            else if (m.esito === 'Perso') losses++;
        });
        const wr = (wins + losses) > 0 ? Math.round((wins / (wins + losses)) * 100) : 0;
        let wrColor = wr >= 70 ? 'text-green-400' : (wr >= 50 ? 'text-yellow-400' : 'text-red-400');


        return `
    <div class="strategy-card bg-white/10 rounded-lg p-3 mb-2" data-strategy="${id}" data-date="${date}">
                <div class="flex justify-between items-center cursor-pointer" onclick="event.stopPropagation(); window.toggleStrategyMatchesHistory('${safeId}', '${date}', this)">
                    <div>
                        <div class="font-bold text-purple-300">${strat.name || id}</div>
                        <div class="text-xs text-gray-400">${wins}V - ${losses}P</div>
                    </div>
                    <div class="text-right">
                        <div class="text-xl font-black ${wrColor}">${wr}%</div>
                    </div>
                </div>
                <div id="matches-${safeId}-${date}" class="hidden mt-3 pt-3 border-t border-white/10 space-y-2">
                    ${closed.map(m => {
            const isWin = m.esito === 'Vinto';
            const isLoss = m.esito === 'Perso';
            const bgColor = isWin ? 'bg-green-600/30' : (isLoss ? 'bg-red-600/30' : 'bg-gray-600/30');
            const icon = isWin ? '✅' : (isLoss ? '❌' : '⏳');

            return `
                        <div class="${bgColor} p-2 rounded text-xs flex justify-between items-center">
                            <div><div class="font-bold">${m.partita}</div><div class="opacity-70">${m.tip} (@${m.quota || '-'})</div></div>
                            <div class="text-right font-black">${m.risultato} ${icon}</div>
                        </div>`;
        }).join('')}
                </div>

            </div>`;
    }).join('');
    container.classList.remove('hidden');
}

window.toggleStrategyMatchesHistory = function (id, date, el) {
    const container = el.parentElement.querySelector(`#matches-${id}-${date}`);

    if (container) container.classList.toggle('hidden');
};

window.loadTradingHistory = async function () {
    const container = document.getElementById('trading-history-list');
    if (!container) return;
    container.innerHTML = '<div class="text-center text-gray-400 py-8">Caricamento trading...</div>';

    try {
        const today = new Date();
        const dates = [];
        for (let i = 0; i <= 7; i++) {
            const date = new Date(today);
            date.setDate(date.getDate() - i);
            dates.push(date.toISOString().split('T')[0]);
        }

        const dateData = [];
        for (const date of dates) {
            const docSnap = await getDoc(doc(db, "daily_trading_picks", date));
            if (docSnap.exists()) {
                const picks = docSnap.data().picks || [];
                let v = 0, c = 0, s = 0, p = 0;
                picks.forEach(x => {
                    if (x.esitoColor === 'green') v++;
                    else if (x.esitoColor === 'yellow') c++;
                    else if (x.esitoColor === 'red') s++;
                    else p++;
                });
                dateData.push({ date, picks, v, c, s, p, hasData: true });
            } else {
                dateData.push({ date, hasData: false });
            }
        }

        container.innerHTML = dateData.map(d => {
            if (!d.hasData || d.picks.length === 0) return `<div class="bg-gray-800/50 rounded-xl p-4 opacity-50 mb-3 text-sm text-gray-500">${d.date}: Nessun dato</div>`;
            return `
                <div class="bg-gradient-to-r from-orange-900/40 to-red-900/40 border border-orange-500/20 rounded-xl p-4 mb-3 cursor-pointer" onclick="this.querySelector('.details').classList.toggle('hidden')">
                    <div class="flex justify-between items-center">
                        <div class="font-bold">${d.date}</div>
                        <div class="flex gap-1">
                            ${'🟢'.repeat(d.v)}${'🟡'.repeat(d.c)}${'🔴'.repeat(d.s)}
                        </div>
                    </div>
                    <div class="details hidden mt-4 space-y-2">
                        ${d.picks.map(x => `
                            <div class="bg-white/5 p-2 rounded text-xs flex justify-between">
                                <div><div class="font-bold">${x.partita}</div><div>${x.strategy} - ${x.tip}</div></div>
                                <div class="text-right uppercase font-bold text-gray-400">${x.risultato || '-'}</div>
                            </div>
                        `).join('')}
                    </div>
                </div>`;
        }).join('');
    } catch (e) {
        console.error(e);
        container.innerHTML = 'Errore caricamento.';
    }
};

// Event Listeners for History Tabs
const initHistoryTabs = () => {
    const tabPronostici = document.getElementById('history-tab-pronostici');
    const tabTrading = document.getElementById('history-tab-trading');
    const tabTips = document.getElementById('history-tab-tips');
    const listPronostici = document.getElementById('history-list');
    const listTrading = document.getElementById('trading-history-list');
    const listTips = document.getElementById('tips-history-list');

    if (tabPronostici && tabTrading && tabTips) {
        const resetTabs = () => {
            [tabPronostici, tabTrading, tabTips].forEach(t => {
                t.className = 'flex-1 py-3 px-1 rounded-xl font-bold text-[10px] sm:text-xs md:text-sm transition-all bg-gray-700 text-gray-300 hover:bg-gray-600';
            });
            [listPronostici, listTrading, listTips].forEach(l => l.classList.add('hidden'));
        };

        tabPronostici.onclick = () => {
            resetTabs();
            tabPronostici.className = 'flex-1 py-3 px-1 rounded-xl font-bold text-[10px] sm:text-xs md:text-sm transition-all bg-gradient-to-r from-purple-600 to-blue-600 text-white shadow-lg';
            listPronostici.classList.remove('hidden');
        };

        tabTrading.onclick = () => {
            resetTabs();
            tabTrading.className = 'flex-1 py-3 px-1 rounded-xl font-bold text-[10px] sm:text-xs md:text-sm transition-all bg-gradient-to-r from-orange-500 to-red-500 text-white shadow-lg';
            listTrading.classList.remove('hidden');
            window.loadTradingHistory();
        };

        tabTips.onclick = () => {
            resetTabs();
            tabTips.className = 'flex-1 py-3 px-1 rounded-xl font-bold text-[10px] sm:text-xs md:text-sm transition-all bg-gradient-to-r from-amber-500 to-orange-500 text-white shadow-lg';
            listTips.classList.remove('hidden');
            window.loadTipsHistory();
        };
    }
};

window.loadTipsHistory = async function () {
    const container = document.getElementById('tips-history-list');
    if (!container) return;
    container.innerHTML = '<div class="text-center text-orange-400 py-8"><i class="fa-solid fa-spinner fa-spin mr-2"></i>Caricamento consigli...</div>';

    try {
        const today = new Date();
        const dates = [];
        for (let i = 0; i <= 7; i++) {
            const date = new Date(today);
            date.setDate(date.getDate() - i);
            dates.push(date.toISOString().split('T')[0]);
        }

        const dateData = [];
        for (const date of dates) {
            const docSnap = await getDoc(doc(db, "daily_parlays", date));
            if (docSnap.exists()) {
                const parlays = docSnap.data().parlays || {};
                dateData.push({ date, parlays, hasData: true });
            } else {
                dateData.push({ date, hasData: false });
            }
        }

        container.innerHTML = dateData.map(d => {
            if (!d.hasData || Object.keys(d.parlays).length === 0) {
                return `<div class="bg-gray-800/50 rounded-xl p-4 opacity-50 mb-3 text-sm text-gray-500">${formatDateShort(d.date)}: Nessun consiglio</div>`;
            }

            let parlaysHtml = Object.values(d.parlays).map(p => {
                // Determine parlay outcome based on picks
                const results = p.picks.map(m => {
                    let esito = (m.esito || '').toLowerCase();
                    if (!esito && m.risultato && m.tip) {
                        esito = (window.evaluateTipLocally ? window.evaluateTipLocally(m.tip, m.risultato) : '').toLowerCase();
                    }
                    return esito;
                });

                const isVinto = results.length > 0 && results.every(r => r === 'vinto' || r === 'win');
                const isPerso = results.some(r => r === 'perso' || r === 'lose');
                const pStatus = isVinto ? 'VINTO ✅' : (isPerso ? 'PERSO ❌' : 'IN CORSO ⏳');
                const pColor = isVinto ? 'text-emerald-400' : (isPerso ? 'text-rose-400' : 'text-blue-400');
                const pBorder = isVinto ? 'border-emerald-500/30 bg-emerald-500/5' : (isPerso ? 'border-rose-500/20 opacity-70' : 'border-white/10 bg-white/5');

                return `
                    <div class="p-3 rounded-xl border ${pBorder} mb-2 shadow-sm transition-all">
                        <div class="flex justify-between items-center mb-2">
                            <span class="text-[9px] font-black uppercase text-white/40 tracking-widest">${p.label}</span>
                            <span class="text-[10px] font-black ${pColor} italic">${pStatus}</span>
                        </div>
                        <div class="space-y-1.5">
                            ${p.picks.map(m => `
                                <div class="flex justify-between items-center text-[11px]">
                                    <div class="max-w-[70%]">
                                        <div class="text-white/80 font-bold truncate">${m.partita}</div>
                                        <div class="text-[9px] text-white/40 uppercase">${m.lega || ''}</div>
                                    </div>
                                    <div class="text-right">
                                        <div class="text-amber-300 font-black">${m.tip} (@${m.quota})</div>
                                        <div class="text-[9px] text-white/60 font-bold">${m.risultato || '-'}</div>
                                    </div>
                                </div>
                            `).join('')}
                        </div>
                        <div class="mt-3 flex justify-between items-center border-t border-white/5 pt-2">
                             <div class="text-[9px] text-white/30 truncate">AI Conf: ${p.avgConfidence}%</div>
                             <div class="text-[10px] font-black text-white/70">QUOTA: @${p.totalOdds.toFixed(2)}</div>
                        </div>
                    </div>
                `;
            }).join('');

            return `
                <div class="bg-gradient-to-br from-indigo-900/40 via-purple-900/40 to-orange-900/40 border border-white/10 rounded-2xl p-4 mb-3 cursor-pointer shadow-lg hover:ring-1 hover:ring-orange-500/30 transition-all" 
                     onclick="this.querySelector('.details').classList.toggle('hidden')">
                    <div class="flex justify-between items-center">
                        <div class="flex items-center gap-2">
                            <div class="w-8 h-8 rounded-full bg-orange-500/20 flex items-center justify-center">
                                <i class="fa-solid fa-wand-magic-sparkles text-orange-400 text-sm"></i>
                            </div>
                            <div>
                                <div class="font-black text-white text-sm tracking-tight">${formatDateLong(d.date)}</div>
                                <div class="text-[9px] text-white/50 font-bold uppercase tracking-widest">${Object.keys(d.parlays).length} Pacchetti Suggeriti</div>
                            </div>
                        </div>
                        <i class="fa-solid fa-chevron-down text-white/20 text-xs shadow-icon"></i>
                    </div>
                    <div class="details hidden mt-4 space-y-2 animate-slide-down">
                        ${parlaysHtml}
                    </div>
                </div>`;
        }).join('');
    } catch (e) {
        console.error('[loadTipsHistory] Error:', e);
        container.innerHTML = '<div class="text-center text-red-400 py-8">Errore caricamento storico consigli</div>';
    }
};
initHistoryTabs();

// ==================== LIVE HUB COMMAND CENTER (EX SERIE A) ====================
async function loadLiveHubMatches() {
    const container = document.getElementById('live-hub-container');
    if (!container) return;

    const allGames = Object.values(window.liveScoresHub);

    // FILTER: Only matches from TODAY
    const today = new Date().toISOString().split('T')[0]; // "2026-01-04"
    const todayGames = allGames.filter(match => {
        const matchDate = match.matchDate || '';
        return matchDate === today || matchDate.startsWith(today);
    });

    // FILTER: Only LIVE or recent matches (not FT from hours ago)
    let liveGames = todayGames.filter(match => {
        const status = (match.status || '').toUpperCase();
        // Show ONLY matches in play: 1H, 2H, HT, ET, P, LIVE, or BT
        // Exclude: NS (Not Started), FT/AET/PEN (Finished)
        return ['1H', '2H', 'HT', 'ET', 'P', 'LIVE', 'BT'].includes(status);
    });

    // DE-DUPLICATION: Remove duplicate matches by normalized matchName
    const seenMatches = new Map();
    liveGames = liveGames.filter(match => {
        // Normalize: lowercase, remove spaces, sort team names alphabetically
        const name = (match.matchName || '').toLowerCase().replace(/\s+/g, '');
        // Create a stable key regardless of home/away order
        const teams = name.split(/vs|-|:/).map(t => t.trim()).sort().join('_');
        if (seenMatches.has(teams)) {
            console.log(`[LiveHub] Skipping duplicate: ${match.matchName} `);
            return false;
        }
        seenMatches.set(teams, true);
        return true;
    });

    // FILTER: Only MAJOR LEAGUES (Serie A/B, Premier, La Liga, Bundesliga, etc.)
    const MAJOR_LEAGUES = [
        135, 136,       // Italia: Serie A, Serie B
        39, 40, 41,     // Inghilterra: Premier League, Championship, League One
        140,            // Spagna: La Liga
        78, 79,         // Germania: Bundesliga, 2. Bundesliga
        61,             // Francia: Ligue 1
        88,             // Olanda: Eredivisie
        94,             // Portogallo: Primeira Liga
        207,            // Svizzera: Super League
        235,            // Austria: Bundesliga
        144,            // Belgio: Pro League
        203,            // Turchia: Super Lig
        2, 3, 848,      // Coppe Europee: UCL, UEL, Conference League
        137, 45, 143    // Coppe Nazionali: Coppa Italia, FA Cup, Copa del Rey
    ];

    const majorLeagueGames = liveGames.filter(match => {
        // If no leagueId, allow it (old data without leagueId)
        if (!match.leagueId) return true;
        return MAJOR_LEAGUES.includes(match.leagueId);
    });

    console.log(`[LiveHub] All: ${allGames.length}, Today: ${todayGames.length}, Unique: ${liveGames.length}, Major Leagues: ${majorLeagueGames.length} `);

    // 🛡️ CRITICAL FIX: Only show matches that belong to TRADING (Box Verde)
    const tradingPicks = window.strategiesData?.['top_del_giorno']?.matches || [];
    const tradingPicksNames = new Set(tradingPicks.map(p => (p.partita || '').toLowerCase().replace(/\s+/g, '')));
    const tradingPicksIds = new Set(tradingPicks.map(p => String(p.fixtureId || '')));

    const finalLiveGames = majorLeagueGames.filter(match => {
        const matchNameNorm = (match.matchName || '').toLowerCase().replace(/\s+/g, '');
        const fixtureId = String(match.fixtureId || '');
        return tradingPicksNames.has(matchNameNorm) || tradingPicksIds.has(fixtureId);
    });

    console.log(`[LiveHub] Total Live: ${liveGames.length}, Filtered by Trading: ${finalLiveGames.length}`);

    if (finalLiveGames.length === 0) {
        container.innerHTML = `
            <div class="col-span-full text-center py-20 bg-white/10 backdrop-blur-md border border-white/20 rounded-3xl">
                <i class="fa-solid fa-radar text-6xl mb-4 text-white/70 animate-pulse"></i>
                <p class="font-black text-xl text-white">Nessun match attivo oggi</p>
                <p class="text-sm text-white/60 mt-2 max-w-xs mx-auto">Il radar sta scansionando i campionati principali. Torna più tardi!</p>
            </div>`;
        return;
    }

    // SORT: By status (LIVE first), then by kickoff time or pressure
    const sorted = [...finalLiveGames].sort((a, b) => {
        const statusOrder = { '1H': 1, '2H': 1, 'HT': 2, 'LIVE': 1, 'ET': 1, 'P': 1, 'BT': 2, 'NS': 3, 'FT': 4 };
        const orderA = statusOrder[a.status?.toUpperCase()] || 5;
        const orderB = statusOrder[b.status?.toUpperCase()] || 5;
        if (orderA !== orderB) return orderA - orderB;

        // If same status, sort by kickoff time first
        const timeA = a.ora || a.matchTime || '';
        const timeB = b.ora || b.matchTime || '';
        if (timeA !== timeB) return timeA.localeCompare(timeB);

        // Then by pressure (high first for live)
        const pA = a.liveStats?.pressureValue || 0;
        const pB = b.liveStats?.pressureValue || 0;
        return pB - pA;
    });

    let html = '';

    // Use existing tradingPicks to merge trading instructions

    sorted.forEach(match => {
        // Try to find matching trading pick by fixtureId or matchName
        let tradingPick = null;
        const matchNameNorm = (match.matchName || '').toLowerCase().replace(/\s+/g, '');

        if (match.fixtureId) {
            tradingPick = tradingPicks.find(p => String(p.fixtureId) === String(match.fixtureId));

        }
        // REMOVED: Name-based fuzzy matching (caused false positives)

        // Prepare match for unified card renderer - merge trading data if found
        const preparedMatch = {
            ...match, // Includes events from liveScoresHub
            home: match.homeTeam || match.matchName?.split(/\s*[-vs]+\s*/)?.[0] || '',
            away: match.awayTeam || match.matchName?.split(/\s*[-vs]+\s*/)?.[1] || '',
            // Handle multiple score formats including tradingPick.risultato
            homeScore: match.homeScore ??
                (match.score ? parseInt(match.score.split('-')[0]) : null) ??
                (tradingPick?.risultato ? parseInt(tradingPick.risultato.split('-')[0]) : null) ??
                tradingPick?.homeScore ?? 0,
            awayScore: match.awayScore ??
                (match.score ? parseInt(match.score.split('-')[1]) : null) ??
                (tradingPick?.risultato ? parseInt(tradingPick.risultato.split('-')[1]) : null) ??
                tradingPick?.awayScore ?? 0,
            // Merge trading data
            hasTradingStrategy: !!tradingPick || !!(match.tip && (match.tip.toLowerCase().includes('back') || match.tip.toLowerCase().includes('lay'))),
            tradingInstruction: tradingPick?.tradingInstruction || match.tip || '',
            strategy: tradingPick?.strategy || match.strategy || 'TRADING',
            reasoning: tradingPick?.reasoning || match.reasoning || '',
            liveStats: match.liveStats || {},
            events: match.events || [], // EXPLICIT PROPAGATION
            elapsed: match.elapsed || 0,
            // 🛡️ LEGA FIX: Propagate league name from trading pick or match
            lega: tradingPick?.lega || match.lega || match.league?.name || '',
            id: window.getMantraId(match),
            fixtureId: match.fixtureId || tradingPick?.fixtureId
        };
        html += window.renderLiveHubCard(preparedMatch);
    });

    // 🛡️ NO-FLASH UPDATE: Only update DOM if HTML content changed
    if (window._lastLiveHubHTML !== html) {
        container.innerHTML = html;
        window._lastLiveHubHTML = html;
        console.log(`[LiveHub] UI Updated (${majorLeagueGames.length} cards)`);
    } else {
        console.log(`[LiveHub] Skip update (No changes)`);
    }
}



window.toggleLiveFavorite = async function (matchName, tip) {
    if (!window.currentUser) return alert("Accedi per attivare i preferiti");

    // 🏆 Mantra Redirect: Cerchiamo il match nel Live Hub o nelle strategie
    let matchToToggle = null;

    // Try Live Hub first
    if (window.liveScoresHub) {
        matchToToggle = Object.values(window.liveScoresHub).find(m =>
            (m.matchName === matchName || m.partita === matchName)
        );
    }

    // Fallback: search by name in strategies
    if (!matchToToggle && window.strategiesData) {
        for (const stratId in window.strategiesData) {
            const found = window.strategiesData[stratId].matches?.find(m => m.partita === matchName);
            if (found) { matchToToggle = found; break; }
        }
    }

    if (matchToToggle) {
        await window.toggleMatchFavorite(matchToToggle);
    } else {
        // Emergency synthetic match
        const fixtureIdMatch = matchName.match(/\[(\d+)\]/); // Sometimes added in logs
        await window.toggleMatchFavorite({
            partita: matchName,
            tip: tip || '',
            fixtureId: fixtureIdMatch ? fixtureIdMatch[1] : null,
            isLiveOnly: true
        });
    }

    // Force re-render of Live Hub to update star status
    window.loadLiveHubMatches();
};



console.log('[App] Live Terminal Logic Initialized.');

console.log('[App] Logic Initialized.');

// 📦 Load Strategy Templates at startup
loadStrategyTemplates();

// ==================== ACCOUNT PAGE POPULATION ====================

window.populateAccountPage = async function () {
    if (!window.currentUser) return;
    const p = window.currentUserProfile || {};
    const u = window.currentUser || {};

    // Profile Baselines
    const name = p.name || u.displayName || u.email?.split('@')[0] || 'Utente';
    const email = u.email || p.email || '-';

    let createdTimestamp = '-';
    const rawCreated = p.createdAt || p.registeredAt || u.metadata?.creationTime;
    if (rawCreated) {
        try {
            const date = rawCreated.toDate ? rawCreated.toDate() : new Date(rawCreated);
            createdTimestamp = date.toLocaleDateString('it-IT');
        } catch (e) { console.warn("Created date error", e); }
    }

    // Populate UI (Targeting IDs from index.html)
    const elName = document.getElementById('account-name');
    const elEmail = document.getElementById('account-email');
    const elAvatar = document.getElementById('account-avatar');
    const elCreated = document.getElementById('account-created');

    console.log('[Account] UI Elements:', { elName, elEmail, elAvatar, elCreated });
    console.log('[Account] Data to set:', { name, email, createdTimestamp });

    if (elName) elName.textContent = name;
    if (elEmail) elEmail.textContent = email;
    if (elAvatar) elAvatar.textContent = name.charAt(0).toUpperCase();
    if (elCreated) elCreated.textContent = createdTimestamp;

    // Telegram UI
    const telegramCondition = p.telegramLinked || p.telegramChatId;
    const elNotLinked = document.getElementById('telegram-not-linked');
    const elLinked = document.getElementById('telegram-linked');

    if (telegramCondition) {
        elNotLinked?.classList.add('hidden');
        elLinked?.classList.remove('hidden');
        const elUser = document.getElementById('telegram-username');
        if (elUser) elUser.textContent = p.telegramUsername ? `@${p.telegramUsername} ` : 'Attivo';

        // Checkbox states
        if (document.getElementById('notify-kickoff')) document.getElementById('notify-kickoff').checked = p.notifyKickoff !== false;
        if (document.getElementById('notify-goal')) document.getElementById('notify-goal').checked = p.notifyGoal !== false;
        if (document.getElementById('notify-result')) document.getElementById('notify-result').checked = p.notifyResult !== false;
        if (document.getElementById('notify-live')) document.getElementById('notify-live').checked = p.notifyLive !== false;
    } else {
        elNotLinked?.classList.remove('hidden');
        elLinked?.classList.add('hidden');
    }

    // --- Listeners (Attach once) ---
    if (window.accountListenersInitialized) return;

    // Nickname Update
    document.getElementById('edit-nickname-form')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const newNick = document.getElementById('edit-nickname-input').value.trim();
        if (!newNick) return;
        try {
            await setDoc(doc(db, "users", window.currentUser.uid), { name: newNick }, { merge: true });
            alert("Nickname aggiornato! Ricarica la pagina per vederlo dappertutto.");
            location.reload();
        } catch (err) { console.error(err); alert("Ops, errore salvataggio."); }
    });

    // Telegram Code Generation
    document.getElementById('generate-telegram-code-btn')?.addEventListener('click', async () => {
        const btn = document.getElementById('generate-telegram-code-btn');
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Attendere...';
        try {
            const generateFn = httpsCallable(functions, 'generateTelegramLinkCode');
            const res = await generateFn();
            document.getElementById('telegram-link-code').textContent = res.data.code;
            document.getElementById('telegram-code-display').classList.remove('hidden');
        } catch (err) { console.error(err); alert("Errore generazione codice."); }
        btn.disabled = false;
        btn.innerHTML = '<i class="fa-solid fa-link"></i> Genera Codice';
    });

    // Telegram Notifications Toggle
    ['notify-kickoff', 'notify-goal', 'notify-result', 'notify-live'].forEach(id => {
        document.getElementById(id)?.addEventListener('change', async (e) => {
            const dbField = id === 'notify-kickoff' ? 'notifyKickoff' :
                id === 'notify-goal' ? 'notifyGoal' :
                    id === 'notify-result' ? 'notifyResult' : 'notifyLive';
            try {
                await setDoc(doc(db, "users", window.currentUser.uid), { [dbField]: e.target.checked }, { merge: true });
            } catch (err) { console.error(err); }
        });
    });

    // Unlink Telegram
    document.getElementById('unlink-telegram-btn')?.addEventListener('click', async () => {
        if (!confirm("Scollegare il bot Telegram? Non riceverai più notifiche.")) return;
        try {
            await setDoc(doc(db, "users", window.currentUser.uid), {
                telegramLinked: false,
                telegramChatId: null,
                telegramUsername: null
            }, { merge: true });
            alert("Telegram scollegato.");
            location.reload();
        } catch (err) { console.error(err); }
    });

    window.accountListenersInitialized = true;
};


// HELPER: APPLY INTERNAL FILTERING (Geo-specific chips)
function applyInternalFiltering(matches, filter) {
    if (!filter || filter === 'all') return matches;

    if (filter === 'italiane') {
        return matches.filter(m => (m.lega || '').toLowerCase().startsWith('eu-ita'));
    }

    if (filter === 'coppe') {
        const coppeKeywords = ['Champions League', 'Europa League', 'Conference League', 'UCL', 'UEL', 'Conference'];
        return matches.filter(m => {
            const l = (m.lega || '').toLowerCase();
            return coppeKeywords.some(kw => l.includes(kw.toLowerCase()));
        });
    }

    if (filter === 'principali') {
        // Premier, Liga, Bundesliga, Ligue 1, Eredivisie, Super League Swiss
        const topLeagues = ['Premier League', 'La Liga', 'Bundesliga', 'Ligue 1', 'Eredivisie', 'Super League'];
        return matches.filter(m => {
            const l = (m.lega || '').toLowerCase();
            return topLeagues.some(tl => l.includes(tl.toLowerCase()));
        });
    }

    if (filter === 'ai') {
        // AI Choices (Special AI + Magia AI) - Precise flags from getUnifiedMatches
        return matches.filter(m => m.isSpecialAI || m.isMagiaAI);
    }

    return matches;
}

// HELPER: GET UNIFIED MATCHES (Merge all strategies to preserve AI metadata)
function getUnifiedMatches() {
    if (!window.strategiesData) return [];

    const masterMap = new Map();
    const approved = ['all', 'winrate_80', 'italia', 'top_eu', 'cups', 'best_05_ht', '___magia_ai', 'magia_ai_raw', 'over_2_5_ai', 'top_del_giorno'];

    Object.entries(window.strategiesData).forEach(([id, strat]) => {
        if (!strat || !strat.matches) return;

        const isMagia = id === '___magia_ai' || id === 'magia_ai_raw';
        const isApproved = approved.includes(id) || isMagia;
        if (!isApproved) return;

        strat.matches.forEach(m => {
            // ID-PURE PROTOCOL: Use Mantra ID as the only source of truth.
            const mId = window.getMantraId(m);
            if (!mId) {
                console.warn(`[getUnifiedMatches] ⚠️ Missing Mantra ID for ${m.partita || 'Unknown'} in strategy ${id}. Skipping.`);
                return;
            }

            if (!masterMap.has(mId)) {
                const newEntry = { ...m };
                updateEntry(newEntry, id, m);
                masterMap.set(mId, newEntry);
            } else {
                updateEntry(masterMap.get(mId), id, m);
            }
        });
    });

    const finalMatches = Array.from(masterMap.values());
    // 🔥 POPOLA CACHE PER DEBUG REPORT
    window.unifiedMatchesCache = finalMatches;
    return finalMatches;
}

function updateEntry(entry, id, m) {
    // 🛡️ RICH DATA PROTECTION PROTOCOL 🛡️
    // Don't overwrite rich stats with null/undefined from other sources
    if (m.expertStats && !entry.expertStats) entry.expertStats = m.expertStats;
    if (m.rankH && !entry.rankH) entry.rankH = m.rankH;
    if (m.rankA && !entry.rankA) entry.rankA = m.rankA;
    if (m.motivationBadges && (!entry.motivationBadges || entry.motivationBadges.length === 0)) {
        entry.motivationBadges = m.motivationBadges;
    }
    if (m.magicStats && !entry.magicStats) entry.magicStats = m.magicStats;

    // Logical insights
    const why = m.why || m.spiegazione || m.insight || "";
    if (why && !(entry.why || entry.spiegazione || entry.insight)) entry.why = why;

    // 🏆 TRADING SUPREMACY 🏆
    const isTradingSource = (id === 'top_del_giorno' || m.isTrading === true);
    if (isTradingSource) {
        entry.isTrading = true;
        if (m.tradingInstruction) entry.tradingInstruction = m.tradingInstruction;
        if (m.strategy) entry.strategy = m.strategy;
    }

    // 🏆 MAGIA AI SUPREMACY PROTOCOL 🏆
    const isMagia = id === 'magia_ai_raw';
    const isSpecialAI = id === '___magia_ai';
    const isGeneric = !isMagia && !isSpecialAI && !isTradingSource;

    // If Magia AI already spoke, prevent generic strategies from overwriting core fields
    if (entry.isMagiaAI && !isMagia) {
        if (m.tradingInstruction && !entry.tradingInstruction) entry.tradingInstruction = m.tradingInstruction;
        return;
    } else if (isSpecialAI || isMagia) {
        // PROTOCOLLO CONSENSO: isMagiaAI/isSpecialAI activated only if tip matches 'all'
        const baseMatch = window.strategiesData?.['all']?.matches?.find(ref => window.getMantraId(ref) === String(m.fixtureId));
        const baseTip = (baseMatch?.tip || '').toUpperCase().trim();
        const aiTip = (m.tip || m.magicStats?.tipMagiaAI || '').toUpperCase().trim();

        if (baseTip && aiTip && baseTip === aiTip && baseTip !== '-') {
            if (isMagia) entry.isMagiaAI = true;
            if (isSpecialAI) entry.isSpecialAI = true;

            entry.magiaTip = m.tip;
            entry.tip = m.tip;
            if (m.quota) entry.quota = m.quota;
            if (m.confidence) entry.confidence = m.confidence;
            if (m.score) entry.score = m.score;
            if (m.tradingInstruction) entry.tradingInstruction = m.tradingInstruction;
        }
    } else if (isGeneric) {
        entry.dbTip = m.tip;
        // SOCIO: Only allow real Tips to overwrite. If current is '-' or empty, take the new one.
        const currentTip = (entry.tip || '').trim();
        if (!currentTip || currentTip === '-') entry.tip = m.tip;

        if (!entry.quota || entry.quota === '-') entry.quota = m.quota;
        if (m.confidence && !entry.confidence) entry.confidence = m.confidence;
        if (m.probabilita && !entry.probabilita) entry.probabilita = m.probabilita;
    }

    // Cumulative fallback for missing basics
    if (!entry.confidence && m.confidence) entry.confidence = m.confidence;
    if (!entry.probabilita && m.probabilita) entry.probabilita = m.probabilita;
}
