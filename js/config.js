// Configurazione Centralizzata per Strategie e Soglie
// Ultimo aggiornamento: 11/01/2026

window.STRATEGY_CONFIG = {
    // 1. Magia AI (Soglie per selezione Best Pick)
    MAGIA_AI: {
        MAX_ODD: 1.90,          // 🔥 Tetto massimo quota v4.1
        MIN_SMART_SCORE: 60,   // 🔥 Veto assoluto sotto 60 v4.1
        THRESHOLDS: [
            { type: 'DC', label: '12', minProb: 90, minOdd: 1.18 },         // Alzata al 90% per sicurezza
            { type: 'DC', label: '1X', minProb: 85, minOdd: 1.18 },
            { type: 'DC', label: 'X2', minProb: 85, minOdd: 1.18 },
            { type: 'GOALS', label: 'Over 1.5', minProb: 75, minOdd: 1.22 },
            { type: '1X2', label: '1X2 / BTTS', minProb: 65, minOdd: 1.60 },
            { type: 'GOALS', label: 'Gol', minProb: 75, minOdd: 1.60 },
            { type: 'GOALS', label: 'Over 2.5', minProb: 82, minOdd: 1.50 }  // Alzata soglia v4.4 richiesto socio
        ],
        // Fallback se nessuna strategia passa le soglie
        FALLBACK: {
            type: 'HT_FALLBACK',
            label: 'Over 0.5 HT',
            minProb: 88
        }
    },

    // 2. Trading 3.0 (Soglie per Value Betting)
    TRADING: {
        MIN_VALUE_EDGE: 3.0, // 3% di vantaggio minimo sul mercato
        STRATEGIES: {
            BACK_OVER_25: {
                minProb: 40,
                minConfidence: 50
            },
            LAY_THE_DRAW: {
                minOdd: 3.40,
                drawProbRange: [22, 38], // Goldilocks zone
                maxHistDraw: 35
            },
            SECOND_HALF_SURGE: {
                minProb: 65,
                maxProb: 90
            },
            UNDER_35_SCALPING: {
                minUnderProb: 60
            }
        }
    },

    // 3. Monte Carlo Engine
    ENGINE: {
        ITERATIONS: 10000,
        DIXON_COLES_RHO: -0.11,
        HYBRID_DRAW_WEIGHT_SIM: 0.7, // 70% Simulazione
        HYBRID_DRAW_WEIGHT_HIST: 0.3 // 30% Storico
    }
};

// Export per compatibilità (se usato in moduli futuri e test runner)
if (typeof module !== 'undefined' && module.exports) {
    module.exports = STRATEGY_CONFIG;
}
