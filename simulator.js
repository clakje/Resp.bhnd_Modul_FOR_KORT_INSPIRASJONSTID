/**
 * simulator.js - Fysikkmotor for NIV Ventilatorsimulator (Hamilton-stil)
 * 
 * Løser bevegelsesligningen for lungemekanikk i sanntid med en fysisk ventilatormodell:
 * Paw(t) + Pmus(t) = V(t) / C + Flow(t) * R
 * 
 * FASE 1:
 * - A8: Fast internt tidssteg DT = 0.2 ms for full numerisk stabilitet
 * - A1: Kontinuerlig lungevolum (V over FRC) som aldri tvangsnullstilles, med auto-PEEP og VTI/VTE
 * - A2: Andreordens dempet servoregulator (P_servo), blåserimpedans (R_out) og flowbegrensning (Qmax)
 * 
 * FASE 2:
 * - A3: Pasientens eget respirasjonssenter (patientDrive) med egen klokke, P_mus-kurve og variabilitet
 * - A4: Ekte triggeralgoritme (Flow / Trykk), Q_leak_estimert, refraktærtid, autotrigger og dobbeltrigger
 * - A5: Ekte cyclingalgoritme på lekkasjekorrigert flow (Q_meas), Ti-max og sporing av avslutningsårsak
 * 
 * FASE 3:
 * - A6: Separat ekspiratorisk motstand (R_exp = R_insp * expRatio + R_valve), ekspiratorisk flowbegrensning (Starling/KOLS), PEEPi
 * - A7: Fysisk kontinuerlig lekkasjemodell (rot-lov), linearisert konduktans G_leak, skille mellom Q_lunge, Q_total og Q_meas, dobbel volumvisning
 */

const DT = 0.0002; // Fast internt tidssteg: 0.2 ms (5000 Hz) for numerisk stabilitet

/**
 * C14: Navngitte grenseverdier og sikkerhetsklipp
 * Samlet her for å gjøre alle numeriske begrensninger synlige og sporbare.
 * Hver grense har en fysisk eller numerisk begrunnelse.
 */
const GRENSER = {
    MIN_RISETIME: 0.03,          // s — under dette blir andreordens servoregulator numerisk ustabil (omega → ∞)
    FALLTID_SERVO: 0.10,         // s — fast referansetid for trykkfall til EPAP. Stigetidsinnstillingen gjelder trykksetting under innpust og ikke fallet til EPAP, slik det er på kliniske respiratorer.
    PRETRIGGER_VINDU: 0.15,      // s — klinisk asynkroniskåring regner et pust som pasientutløst når trigging og nevral innsats faller innenfor et fysiologisk vindu. Kjent iboende feilrate: rrSpont / 400 (5 % ved 20/min, 7,5 % ved 30/min, 10 % ved 40/min).
    MIN_PAW_FOR_LEAK: 0.5,       // cmH₂O — unngår divisjon på ~0 i G_leak (linearisert lekkasjekonduktans)
    MIN_RRSPONT_DIVISOR: 1,      // /min — unngår divisjon på 0 i pustesyklusberegning (60 / rrSpont)
    MIN_CYCLE_DURATION: 0.4,     // s — korteste mulige pustesyklus for å unngå numerisk ustabilitet
    MIN_TI_NEURAL: 0.2,          // s — korteste mulige nevrale inspirasjonstid (fysiologisk minimumsgrense)
    MIN_IBW: 30,                 // kg — minste realistiske idealvekt (unngår urealistisk lave verdier)
    MIN_TE_MEASURED: 0.1,        // s — minimums Te for å unngå 0-divisjon i I:E-beregning
    MAX_SUBSTEPS_PER_FRAME: 2500,// — maks 0.5 s simulert tid per frame (forhindrer ekstrem belastning)

    // 6.1 Volumkontroll
    VC_FLOW_TAU: 0.03,           // s — tidskonstant for flowregulatorens oppramping til innstilt flow. Ekte volumkontrollerte respiratorer når settpunktet på noen få titalls millisekunder; uten en myk start blir flowkurven en matematisk diskontinuitet.
    VC_DECEL_END_FRAC: 0.5,      // — desellererende rampe ender på 50 % av toppflow (klinisk konvensjon). Middelflow blir da 0,75 × toppflow.
    VC_MIN_PEAK_FLOW: 0.05,      // L/s — nedre grense for innstilt toppflow (unngår 0-divisjon i Ti-estimatet)

    // 6.2 Ikke-lineær trykk/volum-kurve
    ELASTANS_FAKTOR_MIN: 0.3,    // — nedre klipp på stress index-multiplikatoren. Uten klipp går den mot uendelig når tidalvolumet nærmer seg null (dV^(SI-1) er singulær i 0).
    ELASTANS_FAKTOR_MAKS: 3.0,   // — øvre klipp på samme multiplikator
    UIP_COMPLIANCE_ANDEL: 0.35,  // — ettergivelighet over øvre knekkpunkt som andel av ettergivelighet under. 0,35 gir den karakteristiske «beaking»-formen ved overdistensjon.
    REKRUTTERING_TAU: 0.20,      // s — tidskonstant for at rekruttert volum fylles og tømmes
    LUKKETRYKK_ANDEL: 0.6,       // — luftveien lukker seg igjen når alveolærtrykket faller under denne andelen av åpningstrykket (hysterese i trykk/volum-sløyfen)
    R_LUKKET_LUFTVEI: 1e4,       // cmH2O/(L/s) — motstand i en lukket luftvei (praktisk talt ingen flow)

    // 6.3 Entrainment / omvendt trigging
    ENTRAINMENT_LATENS: 0.15,    // s — forsinkelse fra insufflasjonen starter til den nevrale innsatsen utløses
    ENTRAINMENT_TIMEOUT: 10.0    // s — uten maskinpust i dette tidsrommet går pasienten tilbake til fri egenfrekvens
};

/**
 * Pasientens eget respirasjonssenter (A3)
 * Har uavhengig tidsakse og genererer kontinuerlig P_mus(t) og nevrale pustesykluser
 */
class PatientDrive {
    constructor() {
        this.rrSpont = 12;         // /min - Pasientens spontane frekvens (0 = passiv)
        this.pmusMax = 5.0;        // cmH2O - Inspiratorisk muskelkraft (0–20)
        this.pmusOffset = 0.0;     // s - 5.5 Tidsforskyvning av pasientinnsats (-1.0 til +1.0 s, standard 0)
        this.responsive = false;   // boolean - 5.2 Responsiv pasientinnsats (standard av)
        this.responsiveness = 50;  // % - 5.2 Følsomhet (10–100, standard 50)
        this.baselineSupport = null; // cmH2O - Forankret referanse for støttenivå (IPAP - EPAP)
        this.baselinePmusMax = null; // cmH2O - Forankret referanse for pmusMax
        this.effectivePmusMax = 5.0; // cmH2O - Effektiv muskelkraft justert pust for pust
        this._lastPmusMax = 5.0;   // Sporing av manuell endring
        this.tiNeural = 1.0;       // sekunder - Nevral inspirasjonstid (0.4–1.6)
        this.triseNeural = null;   // sekunder - Stigetid innsats (null = utledes fra tiNeural)
        this.tholdNeural = null;   // sekunder - Holdetid innsats (null = utledes fra tiNeural)
        this.tdecayNeural = null;  // sekunder - Relaksasjonstid innsats (null = utledes fra tiNeural)
        this.kobleTiNeural = true; // boolean - Utled fra nevral inspirasjonstid (standard true)
        this.pmusExp = 0.0;        // cmH2O - Ekspiratorisk muskelkraft / aktiv utpust (0–10)
        this.variability = 15;     // % - Tilfeldig variasjon i frekvens og kraft (0–30)
        this.cardiacArtifact = 0.0;// L/min - Svak flowoscillasjon fra hjerteslag (0–3)

        // 6.3: Entrainment / omvendt trigging (reverse triggering)
        this.entrainmentEnabled = false; // boolean - Nevral syklus låses til maskinpustet
        this.entrainmentRatio = 1;       // Antall maskinpust per nevral innsats (1, 2 eller 3)
        this._entrainCounter = 0;        // Teller maskinpust siden forrige entrainede innsats
        this._entrainPending = false;    // En entrainet innsats venter på latenstiden
        this._entrainTimer = 0.0;        // sekunder igjen av latenstiden
        this._entrainLastSignal = -1e9;  // Tidspunkt for siste maskinpust (frihjulsfallback)

        this.timeInCycle = 0;      // sekunder i gjeldende nevrale syklus
        this.currentCycleDuration = 60 / 12;
        this.currentPmusMax = 5.0;
        this.currentTiNeural = 1.0;
        this.currentTriseNeural = 0.30;
        this.currentTholdNeural = 0.00;
        this.currentTdecayNeural = 0.40;
        this.currentPmusExp = 0.0;
        this.currentEffort = null; // Peker til aktivt objekt i state.efforts
        this.pretriggeredEffort = false;
        this.P_mus = 0.0;          // cmH2O - Gjeldende muskelkraft
    }

    reset() {
        this.timeInCycle = 0;
        this.P_mus = 0.0;
        this.currentEffort = null;
        this.pretriggeredEffort = false;
        this.effectivePmusMax = this.pmusMax;
        this.baselineSupport = null;
        this.baselinePmusMax = null;
        this._lastPmusMax = this.pmusMax;
        this._entrainCounter = 0;
        this._entrainPending = false;
        this._entrainTimer = 0.0;
        this._entrainLastSignal = -1e9;
        this._startNewCycle(0, null);
    }

    /**
     * 6.3: Signal om at maskinen har levert et pust (kalles fra _startInspiration).
     * Ved entrainment låses pasientens nevrale syklus til maskinen: hver n-te
     * insufflasjon utløser en ny innsats etter en kort latenstid. Dette er
     * mekanismen bak omvendt trigging (reverse triggering).
     */
    onMachineBreath(totalTime) {
        if (!this.entrainmentEnabled || this.rrSpont <= 0) return;
        this._entrainLastSignal = totalTime;
        this._entrainCounter++;
        const ratio = Math.max(1, Math.round(this.entrainmentRatio || 1));
        if (this._entrainCounter >= ratio) {
            this._entrainCounter = 0;
            this._entrainPending = true;
            this._entrainTimer = GRENSER.ENTRAINMENT_LATENS;
        }
    }

    /**
     * 6.3: Sann når entrainment styrer den nevrale klokken akkurat nå.
     * Faller tilbake til frihjul hvis maskinen ikke har levert pust på en stund,
     * slik at pasienten ikke blir stående stille ved apné eller stans.
     */
    erEntrainet(totalTime) {
        return this.entrainmentEnabled
            && this.rrSpont > 0
            && (totalTime - this._entrainLastSignal) < GRENSER.ENTRAINMENT_TIMEOUT;
    }

    _startNewCycle(totalTime, effortsList, currentSupport) {
        if (this.rrSpont <= 0) {
            this.currentCycleDuration = Infinity;
            this.currentPmusMax = 0;
            this.effectivePmusMax = 0;
            this.currentTiNeural = this.tiNeural;
            this.currentTriseNeural = 0.30 * this.tiNeural;
            this.currentTholdNeural = 0.00 * this.tiNeural;
            this.currentTdecayNeural = 0.40 * this.tiNeural;
            this.currentPmusExp = 0;
            this.timeInCycle = 0;
            this.currentEffort = null;
            return;
        }

        // 5.2 Responsiv muskelinnsats: forankre referanse og juster pust-for-pust
        if (currentSupport !== undefined) {
            if (this._lastPmusMax !== this.pmusMax || this.baselineSupport === null) {
                this.baselineSupport = currentSupport;
                this.baselinePmusMax = this.pmusMax;
                this.effectivePmusMax = this.pmusMax;
                this._lastPmusMax = this.pmusMax;
            }

            if (this.responsive && this.baselineSupport !== null) {
                const deltaSupport = currentSupport - this.baselineSupport;
                const targetPmus = Math.max(0, Math.min(25, this.baselinePmusMax - deltaSupport * (this.responsiveness / 100)));
                const maxChange = 1.0;
                const diff = targetPmus - this.effectivePmusMax;
                const change = Math.sign(diff) * Math.min(Math.abs(diff), maxChange);
                this.effectivePmusMax += change;
            } else {
                this.effectivePmusMax = this.pmusMax;
            }
        }

        const basePeriod = 60 / Math.max(GRENSER.MIN_RRSPONT_DIVISOR, this.rrSpont);
        const vFactor = (this.variability / 100);
        // Tilfeldig variasjon innenfor +/- variability %
        const randPeriod = 1.0 + (Math.random() * 2.0 - 1.0) * vFactor;
        const randForce  = 1.0 + (Math.random() * 2.0 - 1.0) * vFactor;

        this.currentCycleDuration = Math.max(GRENSER.MIN_CYCLE_DURATION, basePeriod * randPeriod);
        this.currentPmusMax = Math.max(0, this.effectivePmusMax * randForce);

        // Skaler nevrale tider proporsjonalt med innsatsen (5.2)
        const scale = (this.baselinePmusMax > 0.01) ? (this.effectivePmusMax / this.baselinePmusMax) : 1.0;
        const clampedScale = Math.max(0.2, Math.min(2.0, scale));

        this.currentTiNeural = Math.max(GRENSER.MIN_TI_NEURAL, Math.min(this.currentCycleDuration * 0.8, this.tiNeural * randPeriod));

        if (this.kobleTiNeural) {
            this.currentTriseNeural = 0.30 * this.currentTiNeural * clampedScale;
            this.currentTholdNeural = 0.00 * this.currentTiNeural * clampedScale;
            this.currentTdecayNeural = 0.40 * this.currentTiNeural * clampedScale;
        } else {
            const triseBase = (this.triseNeural !== null) ? this.triseNeural : 0.30 * this.tiNeural;
            const tholdBase = (this.tholdNeural !== null) ? this.tholdNeural : 0.00 * this.tiNeural;
            const tdecayBase = (this.tdecayNeural !== null) ? this.tdecayNeural : 0.40 * this.tiNeural;
            this.currentTriseNeural = Math.max(0.01, triseBase * randPeriod * clampedScale);
            this.currentTholdNeural = Math.max(0.0, tholdBase * randPeriod * clampedScale);
            this.currentTdecayNeural = Math.max(0.01, tdecayBase * randPeriod * clampedScale);
        }

        this.currentPmusExp = this.pmusExp;
        this.timeInCycle = 0;

        if (effortsList) {
            if (this.pretriggeredEffort) {
                this.currentEffort = {
                    t: totalTime,
                    detected: true,
                    type: 'assist',
                    markerEmitted: false
                };
                this.pretriggeredEffort = false;
            } else {
                this.currentEffort = {
                    t: totalTime,
                    detected: false,
                    type: 'missed',
                    markerEmitted: false
                };
            }
            effortsList.push(this.currentEffort);
        }
    }

    isNeuralActive() {
        if (this.rrSpont <= 0) return false;
        const tn = this.timeInCycle - Math.max(0, this.pmusOffset);
        if (tn < 0) return false;
        const activeDuration = this.currentTriseNeural + this.currentTholdNeural + 0.5 * this.currentTdecayNeural;
        return (tn < activeDuration && this.currentPmusMax > 0.05);
    }

    erNevraltNaer() {
        if (this.rrSpont <= 0) return false;
        if (this.isNeuralActive()) return true;
        const remaining = this.currentCycleDuration - this.timeInCycle;
        return (remaining > 0 && remaining < GRENSER.PRETRIGGER_VINDU);
    }

    step(dt, totalTime, effortsList, currentSupport) {
        if (this.rrSpont <= 0) {
            this.P_mus = 0;
            this.currentEffort = null;
            this.timeInCycle = 0;
            return;
        }

        // 6.3: Entrainment overstyrer den frie klokken — innsatsen utløses av maskinpustet
        const entrainet = this.erEntrainet(totalTime);
        if (this.entrainmentEnabled && this._entrainPending) {
            this._entrainTimer -= dt;
            if (this._entrainTimer <= 0) {
                this._entrainPending = false;
                this._startNewCycle(totalTime, effortsList, currentSupport);
            }
        }

        // Start ny syklus ved utløpt syklustid (frihjul).
        // Ved aktiv entrainment hoppes dette over, slik at kun maskinen setter takten.
        if (!entrainet && (this.timeInCycle >= this.currentCycleDuration || this.currentCycleDuration === Infinity)) {
            this._startNewCycle(totalTime, effortsList, currentSupport);
        }

        let tn       = this.timeInCycle;
        if (this.pmusOffset > 0) {
            tn = tn - this.pmusOffset;
        }
        const trise  = this.currentTriseNeural;
        const thold  = this.currentTholdNeural;
        const tdecay = this.currentTdecayNeural;
        const pMax   = this.currentPmusMax;
        const pExp   = this.currentPmusExp;

        // Fysiologisk P_mus(t_n) kurveform: smoothstep stigning, hold, speilvendt smoothstep relaksasjon
        let pmus = 0.0;
        const tExpStart = trise + thold + tdecay;

        if (tn < 0) {
            pmus = 0.0;
        } else if (tn < trise) {
            // Stigning: smoothstep x^2 * (3 - 2x)
            const x = (trise > 0) ? Math.min(1.0, Math.max(0.0, tn / trise)) : 1.0;
            pmus = pMax * x * x * (3.0 - 2.0 * x);
        } else if (tn < trise + thold) {
            // Hold: konstant pMax
            pmus = pMax;
        } else if (tn < tExpStart) {
            // Relaksasjon: smoothstep speilvendt over tdecay
            const tRel = tn - (trise + thold);
            const y = (tdecay > 0) ? Math.min(1.0, Math.max(0.0, tRel / tdecay)) : 1.0;
            const s = y * y * (3.0 - 2.0 * y);
            pmus = pMax * (1.0 - s);
        } else {
            // Inspiratorisk innsats fullført
            pmus = 0.0;
        }

        // Aktiv ekspirasjon (pmusExp) starter fra slutten av tdecayNeural
        if (pExp > 0 && tn >= tExpStart) {
            const teN = Math.max(0.3, this.currentCycleDuration - tExpStart);
            const dtn = tn - tExpStart;
            if (dtn < teN) {
                const expPart = -pExp
                    * Math.min(1.0, dtn / 0.15)        // rampe opp
                    * Math.min(1.0, (teN - dtn) / 0.20); // slipp mot slutten
                pmus += expPart;
            }
        }

        this.P_mus = pmus;
        this.timeInCycle += dt;
    }
}

class VentilatorSimulator {
    constructor() {
        // Maskinkonstanter for blåser og ventilasjonskrets (A2, A6)
        this.machine = {
            R_out: 0.3,   // cmH2O/(L/s) - laminært ledd i 22 mm slangesett + maske (0.3 cmH₂O ved 60 L/min, 0.6 ved 120 L/min)
            K_out: 0.2,   // cmH2O/(L/s)^2 - turbulent Rohrer-ledd (totalt ~0.5 cmH₂O ved 60 L/min, ~1.4 cmH₂O ved 120 L/min)
            R_valve: 2.0, // cmH2O/(L/s) - Ekspirasjonsventilens motstand i NIV-kretsen (A6)
            Qmax: 3.0,    // L/s (~180 L/min) - Maksimal flowkapasitet for NIV-blåser

            // 7.1: Turbinens dynamiske utgangsimpedans mot uforutsett pasientdrag.
            // Foroverkoblingen kompenserer det maskinen kan forutsi fra sin egen
            // trykkommando; pasientens innsats er ukjent for regulatoren og møter
            // derfor turbinens treghet før den er hentet inn.
            R_dyn: 2.6,      // cmH2O/(L/s) - transient impedans mot pasientdrevet flow
            tauBlower: 0.12, // s - turbinens oppspinningstid (hvor lenge dippen varer)
            tauBlowerNed: 0.025, // s - nedtrapping er en ren reguleringshandling og går raskt
            sagMax: 6.0      // cmH2O - metning; turbinen kollapser ikke ubegrenset
        };

        // Respiratorinnstillinger (Klinisk NIV / Hamilton standard)
        this.settings = {
            mode: 'PS',             // 'PS' (trykkstøtte, standard), 'PC' (trykkontroll) eller 'VC' (volumkontroll)
            ipap: 8,                // cmH2O (Inspiratory Positive Airway Pressure / PC over PEEP)

            // FASE 6 (6.1): Volumkontroll (VC)
            vcTidalVolume: 500,        // ml - Innstilt tidalvolum som skal leveres
            vcPeakFlow: 60,            // L/min - Innstilt inspiratorisk toppflow
            vcFlowPattern: 'constant', // 'constant' (firkant) eller 'decelerating' (desellererende rampe)
            inspPause: 0.0,            // sekunder - Inspiratorisk pause etter levert volum (0–1.0 s)

            epap: 5,                // cmH2O (Expiratory Positive Airway Pressure / PEEP)
            rr: 12,                 // /min (Innstilt frekvens / A/C)
            fio2: 30,               // % Oksygenfraksjon
            riseTime: 0.15,         // sekunder (Tid for å nå IPAP, 0.05 - 0.90 s)
            cyclingPercent: 0.25,   // 25% av toppflow avslutter innpust (E-Sense, 5–90%)
            tiSet: 1.0,             // sekunder - Innstilt inspirasjonstid i PC-modus (0.6–2.0 s)
            tiMax: 2.0,             // sekunder - Maksimal inspirasjonstid i PS-modus (0.8–3.0 s)
            tiMin: 0.25,            // sekunder - Minimal inspirasjonstid
            leak: 0,                // L/min @ 10 cmH2O (Maskelekkasje, A7)
            triggerMode: 'flow',    // 'flow' eller 'pressure'
            triggerFlow: 1.5,       // L/min (Flow-trigger terskel: 1.0 - 5.0 L/min)
            triggerPressure: 1.0,   // cmH2O (Trykk-trigger terskel: 0.2 - 5.0 cmH2O)
            
            // FASE 6 (D2): ST-backup innstillinger
            backupRate: 12,         // /min (Backup-frekvens ved fravær av pasientpust: 0–30 /min)
            stActive: false,        // boolean - ST-modus inaktiv (standard av)
            
            // FASE 4 (C3): Alarmgrenser med kliniske standardverdier
            apneaDelay: 20,         // sekunder - forsinkelse før apné-alarm utløses (5–30 s)
            alarmLeakUnit: 'lmin',  // 'lmin' | 'percent'
            alarmLeakLimit: 40,     // L/min - grense for høy maskelekkasje (10–60 L/min)
            alarmLeakPercentLimit: 50, // % - grense for høy maskelekkasje i prosent (10–80 %)
            alarmLowVtLimit: 300,   // ml - grense for lavt tidalvolum (100–600 ml)
            alarmHighVtLimit: 800,  // ml - grense for høyt tidalvolum (300–1000 ml)
            alarmLowRrLimit: 0,     // /min - grense for lav respirasjonsfrekvens (0–25 /min, 0 = av)
            alarmHighRrLimit: 30,   // /min - grense for høy respirasjonsfrekvens (20–50 /min)
            alarmHighPpeak: 40,     // cmH2O - innstilt øvre alarmgrense (0–50 cmH2O, effektiv kuttgrense er 10 cmH2O under)
            alarmHighPpeakDelta: 5  // cmH2O - beholdes for bakoverkompatibilitet
        };

        // Pasientfysiologi (A6 & D5)
        this.patient = {
            compliance: 90,         // ml / cmH2O (Lungenettverkets ettergivelighet)
            resistance: 5,          // cmH2O / (L/s) (Inspiratorisk luftveismotstand, R_insp)
            expRatio: 1.0,          // Forhold ekspiratorisk / inspiratorisk motstand (1.0–3.0, standard 1.0: R_exp = 5)
            flowLimitation: 0.0,    // Ekspiratorisk flowbegrensning (avledet felt, 0–1, standard 0, KOLS = 0.70)
            criticalClosingPressure: 0.0, // cmH2O (5.3: trykk under hvilket luftveiene kollapser, 0–20, KOLS = 8.0)
            flowConductance: 1.0,         // (5.3: konduktans i det kollapsbare segmentet, 0.1–2.0, KOLS = 0.5)
            peepStenting: 0,              // % (5.3: hvor effektivt EPAP hindrer kollaps, 0–100 %, KOLS = 70 %)
            recoilStrength: 25,     // Elastisk tilbakefjæring brystvegg (0–50 %, standard 0 ved passiv, 25 ved aktiv)
            preset: 'normal',       // 'normal', 'copd', 'restrictive', 'custom'
            height: 175,            // cm - Pasienthøyde for beregning av idealvekt (IBW)
            gender: 'male',         // 'male' | 'female'

            // FASE 6 (6.2): Ikke-lineær trykk/volum-kurve
            stressIndexEnabled: false,  // boolean - Volumavhengig ettergivelighet av/på
            stressIndex: 1.0,           // 0.6–1.6 (1.0 = lineær, >1 = overdistensjon, <1 = tidal rekruttering)
            uipEnabled: false,          // boolean - Øvre knekkpunkt av/på
            uipThreshold: 30,           // cmH2O - Trykk der ettergivelighet faller brått (overdistensjon)
            airwayOpeningPressure: 0,   // cmH2O - Åpningstrykk (0 = av). Under dette er luftveien lukket.
            recruitedVolume: 0          // ml - Volum som rekrutteres når luftveien åpner seg
        };

        // Pasientens autonome respirasjonssenter (A3)
        this.patientDrive = new PatientDrive();

        // Akkumulatorer for VTI og VTE
        this._vtiAccum = 0; // ml
        this._vteAccum = 0; // ml
        this._pawInspBuffer = []; // Buffer for siste 100 ms under inspirasjon (Pplat-beregning)

        // 5.4: Holdmanøvrer (Inspiratorisk og ekspiratorisk hold)
        this._inspHoldRequested = false;
        this._inspHoldActive = false;
        this._inspHoldTimer = 0.0;
        this._expHoldRequested = false;
        this._expHoldActive = false;
        this._expHoldTimer = 0.0;

        // 5.5: Tidsforskyvning av pasientinnsats
        this._pmusTriggerDelayTimer = 0.0;
        this._pmusTriggerPending = false;

        // 6.1: Volumkontroll — inspiratorisk pause
        this._vcPauseActive = false;   // boolean - pausen pågår (luftveien holdt, flow = 0)
        this._vcFlowEndTime = 0.0;     // s - tidspunkt i fasen da volumleveransen ble fullført

        // 6.2: Åpningstrykk og rekruttert volum
        this._lungOpen = true;         // boolean - luftveien er åpen (false = under åpningstrykket)
        this._V_recruit = 0.0;         // Liter - rekruttert volum som ligger inne akkurat nå
        this._Q_blower = 0.0;          // L/s - 7.1 turbinens innhentede andel av pasientdrevet flow

        // Simulatortilstand
        const C_L = this.patient.compliance / 1000;
        const initLeak = (this.settings.leak / 60) * Math.sqrt(this.settings.epap / 10);
        const initIbw = this.getPatientIBW();
        const initDrivingP = this.settings.ipap - this.settings.epap;
        const initTheoVt = Math.round(this.patient.compliance * initDrivingP);
        const initRr = (this.settings.mode === 'PC') ? this.settings.rr : (this.patientDrive.rrSpont || this.settings.backupRate || 12);
        const initMv = parseFloat(((initTheoVt * initRr) / 1000).toFixed(2));
        const initTi = (this.settings.mode === 'PC') ? this.settings.tiSet : 0.9;
        const initTe = Math.max(0.5, (60 / Math.max(1, initRr)) - initTi);
        const initIe = (initTe >= initTi) ? `1:${(initTe / initTi).toFixed(1).replace('.', ',')}` : `${(initTi / initTe).toFixed(1).replace('.', ',')}:1`;

        this.state = {
            phase: 'expiration',    // 'inspiration' eller 'expiration'
            timeInPhase: 0,         // sekunder i gjeldende fase
            totalTime: 0,           // total simuleringstid

            // A2 & A7: Trykk- og flowtilstander
            P_target: this.settings.epap, // cmH2O - Måltrykk fra maskinen
            P_servo: this.settings.epap,  // cmH2O - Andreordens servoregulator
            dP_servo: 0.0,                // cmH2O/s - Derivert av P_servo
            I_servo: 0.0,                 // cmH2O - lastkompensasjon i trykkregulatoren
            P_sag: 0.0,                   // cmH2O - 7.1 trykkfall fra turbinens treghet mot pasientdrag
            P_aw: this.settings.epap,     // cmH2O - Masketrykk
            P_mus: 0.0,                   // cmH2O - Pasientens muskelinnsats
            P_el: this.settings.epap,     // cmH2O - Elastisk lunge-tilbakefjæring (V / C_L)
            Q_lunge: 0.0,                 // L/s - Lungeflow (sann flow inn/ut av lungen, A7)
            Q_lekk: 0.0,                  // L/s - Lekkasjeflow (A7)
            Q_total: 0.0,                 // L/s - Total flow levert av maskinen (Q_lunge + Q_lekk)
            Q_meas: 0.0,                  // L/s - Målt flow korrigert for lekkasjeestimat (A4, A5, A7)
            Q_leak_estimert: initLeak,    // L/s - Maskinens glidende lekkasje-estimat

            // A1 & A7: Kontinuerlig volum og målte volumstørrelser
            V: C_L * this.settings.epap,  // Liter over FRC (initialiseres til likevekt ved EPAP)
            volume_lung: 0.0,             // ml over EPAP (sant lungevolum: (V - C_L * epap) * 1000)
            volume_meas: 0.0,             // ml - maskinmålt volum integrert fra Q_meas (returnerer ikke til 0 ved lekkasje)
            lastV_endExp_meas: 0.0,       // ml - slutt-ekspiratorisk maskinvolum før ny pust
            VTI: initTheoVt,              // ml - integralet av positiv lungeflow gjennom innpustet
            VTE: initTheoVt,              // ml - integralet av negativ lungeflow gjennom utpustet
            V_endExp: C_L * this.settings.epap, // Liter over FRC ved starten av innpust
            PEEPi: 0.0,                   // cmH2O - Iboende PEEP (auto-PEEP, A1, A6)

            // A4, A5 & C5: Trigger, Cycling og Trykktopper
            peakTriggerFlow: 0.0,         // L/s - største Q_meas under ekspirasjon før trigging
            visPeakTriggerFlow: 0.0,      // L/s - toppholdt triggerflow for visning
            peakQmeas: 0.0,               // L/s - Toppflow av Q_meas i pågående innpust
            pawMaxInBreath: this.settings.epap, // cmH2O - Maksimalt trykk i innpustet (C5 PIP)
            lastPip: this.settings.ipap,  // cmH2O - Siste fullførte innpusts PIP (C5)
            lastPplat: this.settings.ipap,// cmH2O - Siste fullførte innpusts Pplat (C5)
            lastTi: initTi,               // s - Siste målte inspirasjonstid
            lastTe: parseFloat(initTe.toFixed(1)), // s - Siste målte ekspirasjonstid (C6)
            lastCycleReason: 'flow',      // 'flow' eller 'tiMax'
            lastTriggerType: 'assist',    // 'assist', 'missed', 'double', 'auto', 'mandatory'
            lastCycleTime: 0.0,           // Tidspunkt for forrige cycling til ekspirasjon
            efforts: [],                  // Innsatslogg over de siste 60 sekundene

            // A8: Numerisk restakkumulator
            dtCarry: 0.0,

            // Bakoverkompatibilitet og monitor-felter
            paw: this.settings.epap,      // cmH2O (= P_aw)
            volume: 0.0,                  // ml (= volume_meas, maskinmålt volum)
            flow: 0.0,                    // L/min (= Q_meas * 60, maskinmålt flow)
            flow_lung: 0.0,               // L/min (= Q_lunge * 60, sann lungeflow)
            pmus: 0.0,                    // cmH2O (= P_mus)

            breathStartTime: 0,
            lastSuccessfulBreathTime: 0,
            timeSinceLastBreath: 0,
            breathCount: 0,
            justTriggered: false,         // True i tidssteget et innpust trigges
            isApneaAlarm: false,          // True ved manglende pust over apneaDelay
            
            // FASE 4 (C3): Aktive alarmer og alarmtilstander
            activeAlarms: [],
            alarmState: {
                leakTimeAbove: 0,         // sekunder kontinuerlig over lekkasjegrense
                lowVtStreak: 0,           // antall påfølgende pust under lav Vt-grense
                highVtStreak: 0           // antall påfølgende pust over høy Vt-grense
            },

            // Kontinuerlige monitor-målinger (Fase 4 - fullt ut målte verdier)
            measured: {
                vt: initTheoVt,           // ml - VTE (glattet over 3 pust) (C1)
                vti: initTheoVt,          // ml - VTI (glattet over 3 pust)
                vte: initTheoVt,          // ml - VTE (glattet over 3 pust)
                mv: initMv,               // L/min - middel(VTE siste 60s) * RRtot / 1000 (C1)
                ppeak: this.settings.ipap,// cmH2O - PIP (glattet over 3 pust) (C5)
                pplat: this.settings.ipap,// cmH2O - Pplat siste 100ms før cycling (glattet) (C5)
                rrTotal: initRr,          // pust/min - faktiske leverte pust i siste 60s (C1)
                rrSpont: this.patientDrive.rrSpont, // pust/min - pasientutløste pust i siste 60s (C1)
                spontPercent: (this.patientDrive.rrSpont > 0) ? 100 : 0, // % - andel spontane pust i siste 60s (C1)
                ti: initTi,               // sekunder - målt inspirasjonstid (glattet) (C6)
                te: parseFloat(initTe.toFixed(1)), // sekunder - målt ekspirasjonstid (glattet) (C6)
                ieRatio: initIe,          // I:E-forhold (format 1:X,X) (C6)
                tiTtot: Math.round((initTi / (initTi + initTe)) * 100), // % - Ti / Ttot
                vtPerKg: parseFloat((initTheoVt / initIbw).toFixed(1)), // ml/kg IBW (D5)
                ibw: initIbw,             // kg - idealvekt (D5)
                leak: 0,                  // L/min (A7, D5)
                leakPercent: 0,           // % (A7, D5)
                peepi: 0.0,               // cmH2O (A6, D5)
                peepTotal: this.settings.epap, // cmH2O (5.4: målt PEEPtotal)
                holdPplat: null,          // cmH2O (5.4: avdekket platåtrykk ved hold)
                holdPeepTotal: null,      // cmH2O (5.4: avdekket PEEPtotal ved hold)
                p01: 0.0,                 // cmH2O (5.6: P0.1 okklusjonstrykk / respiratorisk drive)
                asynchronyIndex: 0        // % - asynkroni-indeks siste 60s (D5)
            }
        };

        // Historikk for 60 sekunders vindu (C1)
        this.recentBreaths = [];
        this.isRunning = true;

        // C7 & D3: Min/maks-konvolutt per frame og innsatshendelser
        this.frameSample = {
            pawMin: this.settings.epap,
            pawMax: this.settings.epap,
            pawLast: this.settings.epap,
            flowMin: 0,
            flowMax: 0,
            flowLast: 0,
            volMin: 0,
            volMax: 0,
            volLast: 0,
            pesMin: 0,
            pesMax: 0,
            pesLast: 0,
            flowLungMin: 0,
            flowLungMax: 0,
            flowLungLast: 0,
            volLungMin: 0,
            volLungMax: 0,
            volLungLast: 0
        };
        this.frameEvents = [];
    }

    /**
     * 6.2: Elastisk tilbakefjæringstrykk som funksjon av lungevolum.
     *
     * Erstatter det lineære V / C med en kurve som kan ha både stress index
     * (volumavhengig ettergivelighet) og et øvre knekkpunkt. Alt er forankret i
     * likevektsvolumet ved EPAP, slik at P_el(V0) = EPAP uansett innstilling —
     * da forblir hvilepunkt, PEEPi-beregning og initialisering konsistente, og
     * kurven er identisk med den lineære når begge funksjonene er avslått.
     *
     * @param {number} V Absolutt lungevolum over FRC (Liter), eksklusive rekruttert volum
     * @returns {number} Elastisk trykk (cmH2O)
     */
    _pElastic(V) {
        const C_L = this.patient.compliance / 1000;
        const epap = this.settings.epap;
        const V0 = C_L * epap;      // Likevektsvolum ved EPAP
        const dV = V - V0;          // Tidalt volumutslag over likevekt (Liter)

        // Under likevektsvolumet er kurven alltid lineær (ingen overdistensjon der nede)
        if (dV <= 0) return V / C_L;

        let P = epap + dV / C_L;

        // Stress index: P_el skal følge dV^SI. Multiplikatoren (dV/Vref)^(SI-1)
        // er singulær i dV = 0 og klippes derfor i begge ender.
        const si = this.patient.stressIndex;
        if (this.patient.stressIndexEnabled && si !== undefined && Math.abs(si - 1.0) > 0.01) {
            // Referansevolum: 8 ml/kg IBW. En ren pasientegenskap, uavhengig av maskininnstillingene,
            // slik at kurven ikke endrer seg når forfatteren justerer tidalvolumet.
            const Vref = Math.max(0.05, 0.008 * this.getPatientIBW());
            const raw = Math.pow(Math.max(1e-6, dV / Vref), si - 1.0);
            const k = Math.max(GRENSER.ELASTANS_FAKTOR_MIN, Math.min(GRENSER.ELASTANS_FAKTOR_MAKS, raw));
            P = epap + (dV / C_L) * k;
        }

        // Øvre knekkpunkt: over terskelen faller ettergivelighet til UIP_COMPLIANCE_ANDEL
        if (this.patient.uipEnabled) {
            const uip = this.patient.uipThreshold;
            if (uip !== undefined && P > uip) {
                P = uip + (P - uip) / GRENSER.UIP_COMPLIANCE_ANDEL;
            }
        }

        return P;
    }

    /**
     * 6.2: Volumet som faktisk strekker lungevevet.
     * Rekruttert volum holdes utenfor: poenget med rekruttering er at det er
     * volum vunnet uten at trykket stiger.
     */
    _elasticVolume() {
        return this.state.V - this._V_recruit;
    }

    /**
     * 6.1: Innstilt inspiratorisk flow i volumkontroll (L/s).
     *
     * Firkantflow holder settpunktet gjennom hele innpustet. Desellererende rampe
     * faller lineært mot VC_DECEL_END_FRAC av toppflow, styrt av hvor stor andel
     * av tidalvolumet som er levert — da treffer rampen sluttpunktet nøyaktig når
     * volumet er fullt, uansett hvordan motstand og ettergivelighet påvirker Ti.
     *
     * @returns {number} Målflow (L/s). Null under den inspiratoriske pausen.
     */
    _vcTargetFlow() {
        if (this._vcPauseActive) return 0;

        const Qpeak = Math.max(GRENSER.VC_MIN_PEAK_FLOW, (this.settings.vcPeakFlow || 60) / 60);
        let Q = Qpeak;

        if (this.settings.vcFlowPattern === 'decelerating') {
            const vt = Math.max(1, this.settings.vcTidalVolume || 500);
            const frac = Math.max(0, Math.min(1, this._vtiAccum / vt));
            Q = Qpeak * (1 - (1 - GRENSER.VC_DECEL_END_FRAC) * frac);
        }

        // Myk oppramping av flowregulatoren (unngår en diskontinuitet i flowkurven)
        const ramp = 1 - Math.exp(-this.state.timeInPhase / GRENSER.VC_FLOW_TAU);
        return Q * ramp;
    }

    // Beregn Ideal Body Weight (IBW) etter Devine-formelen (D5)
    getPatientIBW() {
        const h = (this.patient && this.patient.height) ? this.patient.height : 175;
        const g = (this.patient && this.patient.gender) ? this.patient.gender : 'male';
        const ibw = (g === 'female')
            ? 45.5 + 0.91 * (h - 152.4)
            : 50.0 + 0.91 * (h - 152.4);
        return Math.max(GRENSER.MIN_IBW, Math.round(ibw));
    }

    // Sett klinisk pasientprofil (Preset)
    setPreset(presetName) {
        if (presetName === 'copd') {
            // KOLS / Obstruktiv: Moderat profil som tømmer lungene ved lav frekvens (A6, 5.3)
            this.patient.compliance = 70;
            this.patient.resistance = 16;
            this.patient.expRatio = 1.4;
            this.patient.flowLimitation = 0.6; // A6: flowbegrensning for KOLS
            this.patient.criticalClosingPressure = 6.5; // 5.3: lukketrykk
            this.patient.flowConductance = 0.6;         // 5.3: konduktans
            this.patient.peepStenting = 70;             // 5.3: PEEP-stenting
            this.patient.recoilStrength = 25;  // 5.1: elastisk tilbakefjæring
            this.patient.preset = 'copd';
            this.patientDrive.rrSpont = 16;
            this.patientDrive.pmusMax = 3.0;
            this.patientDrive.tiNeural = 0.9;
            this.patientDrive.pmusExp = 0.0;
            this.patientDrive.variability = 10;
            this.patientDrive.cardiacArtifact = 0.0;
        } else if (presetName === 'restrictive') {
            // Pneumoni / Lungeødem / ARDS: Stiv lunge, lav compliance, rask grunn respirasjon (Fase 7)
            this.patient.compliance = 28;
            this.patient.resistance = 6;
            this.patient.expRatio = 1.3;
            this.patient.flowLimitation = 0.0;
            this.patient.criticalClosingPressure = 0.0;
            this.patient.flowConductance = 1.0;
            this.patient.peepStenting = 0;
            this.patient.recoilStrength = 25;  // 5.1: elastisk tilbakefjæring
            this.patient.preset = 'restrictive';
            this.patientDrive.rrSpont = 24;
            this.patientDrive.pmusMax = 7.0;
            this.patientDrive.tiNeural = 0.6;
            this.patientDrive.pmusExp = 0.0;
            this.patientDrive.variability = 10;
            this.patientDrive.cardiacArtifact = 0.3;
        } else {
            // Normal (Frisk pasient) (Fase 7)
            this.patient.compliance = 80;
            this.patient.resistance = 5;
            this.patient.expRatio = 1.0;
            this.patient.flowLimitation = 0.0;
            this.patient.criticalClosingPressure = 0.0;
            this.patient.flowConductance = 1.0;
            this.patient.peepStenting = 0;
            this.patient.recoilStrength = (this.patientDrive.rrSpont > 0) ? 25 : 0; // 5.1
            this.patient.preset = 'normal';
            this.patientDrive.rrSpont = 12;
            this.patientDrive.pmusMax = 4.0;
            this.patientDrive.tiNeural = 1.0;
            this.patientDrive.pmusExp = 0.0;
            this.patientDrive.variability = 15;
            this.patientDrive.cardiacArtifact = 0.0;
        }
    }

    // Nullstill simuleringstilstand (A1, A3, A6, A7, A8, C1, C3, C5, C6)
    reset() {
        const C_L = this.patient.compliance / 1000;
        const initLeak = (this.settings.leak / 60) * Math.sqrt(this.settings.epap / 10);
        const initIbw = this.getPatientIBW();
        const initDrivingP = this.settings.ipap - this.settings.epap;
        const initTheoVt = Math.round(this.patient.compliance * initDrivingP);
        const initRr = (this.settings.mode === 'PC') ? this.settings.rr : (this.patientDrive.rrSpont || this.settings.backupRate || 12);
        const initMv = parseFloat(((initTheoVt * initRr) / 1000).toFixed(2));
        const initTi = (this.settings.mode === 'PC') ? this.settings.tiSet : 0.9;
        const initTe = Math.max(0.5, (60 / Math.max(1, initRr)) - initTi);
        const initIe = (initTe >= initTi) ? `1:${(initTe / initTi).toFixed(1).replace('.', ',')}` : `${(initTi / initTe).toFixed(1).replace('.', ',')}:1`;

        this.state.phase = 'expiration';
        this.state.timeInPhase = 0;
        this.state.totalTime = 0;
        this.state.dtCarry = 0;
        this.state._vCyclingAboveRest = 0;

        // 5.4: Tilbakestill holdmanøvrer
        this._inspHoldRequested = false;
        this._inspHoldActive = false;
        this._inspHoldTimer = 0.0;
        this._expHoldRequested = false;
        this._expHoldActive = false;
        this._expHoldTimer = 0.0;
        this.state.PEEPtotal = this.settings.epap;

        // 5.5: Tilbakestill tidsforskyvning
        this._pmusTriggerDelayTimer = 0.0;
        this._pmusTriggerPending = false;

        // 6.1: Tilbakestill inspiratorisk pause
        this._vcPauseActive = false;
        this._vcFlowEndTime = 0.0;

        // 6.2: Tilbakestill luftveisåpning og rekruttert volum.
        // Lungen starter åpen bare hvis EPAP alene holder den over lukketrykket.
        const P_open_init = this.patient.airwayOpeningPressure || 0;
        this._lungOpen = (P_open_init <= 0) || (this.settings.epap >= P_open_init * GRENSER.LUKKETRYKK_ANDEL);
        this._V_recruit = 0.0;
        this._Q_blower = 0.0;

        this.state.P_target = this.settings.epap;
        this.state.P_servo = this.settings.epap;
        this.state.dP_servo = 0.0;
        this.state.I_servo = 0.0;
        this.state.P_sag = 0.0;
        this.state.P_aw = this.settings.epap;
        this.state.P_mus = 0.0;
        this.state.P_el = this.settings.epap;
        this.state.Q_lunge = 0.0;
        this.state.Q_lekk = 0.0;
        this.state.Q_total = 0.0;
        this.state.Q_meas = 0.0;
        this.state.Q_leak_estimert = initLeak;

        this.state.V = C_L * this.settings.epap;
        this.state.volume_lung = 0.0;
        this.state.volume_meas = 0.0;
        this.state.lastV_endExp_meas = 0.0;
        this.state.VTI = initTheoVt;
        this.state.VTE = initTheoVt;
        this.state.V_endExp = this.state.V;
        this.state.PEEPi = 0.0;

        this.state.peakTriggerFlow = 0.0;
        this.state.visPeakTriggerFlow = 0.0;
        this.state.peakQmeas = 0.0;
        this.state.pawMaxInBreath = this.settings.epap;
        this.state.lastPip = this.settings.ipap;
        this.state.lastPplat = this.settings.ipap;
        this.state.lastTi = initTi;
        this.state.lastTe = parseFloat(initTe.toFixed(1));
        this.state.lastCycleReason = 'flow';
        this.state.lastTriggerType = 'assist';
        this.state.lastCycleTime = 0.0;
        this.state.efforts = [];

        this.state.paw = this.settings.epap;
        this.state.volume = 0.0;
        this.state.flow = 0.0;
        this.state.flow_lung = 0.0;
        this.state.pmus = 0.0;

        this.state.breathStartTime = 0;
        this.state.lastSuccessfulBreathTime = 0;
        this.state.timeSinceLastBreath = 0;
        this.state.breathCount = 0;
        this.state.justTriggered = false;
        this.state.isApneaAlarm = false;

        this.state.activeAlarms = [];
        this.state.alarmState = {
            leakTimeAbove: 0,
            lowVtStreak: 0,
            highVtStreak: 0
        };

        this.state.measured.vt = initTheoVt;
        this.state.measured.vti = initTheoVt;
        this.state.measured.vte = initTheoVt;
        this.state.measured.mv = initMv;
        this.state.measured.ppeak = this.settings.ipap;
        this.state.measured.pplat = this.settings.ipap;
        this.state.measured.rrTotal = initRr;
        this.state.measured.rrSpont = this.patientDrive.rrSpont;
        this.state.measured.spontPercent = (this.patientDrive.rrSpont > 0) ? 100 : 0;
        this.state.measured.ti = initTi;
        this.state.measured.te = parseFloat(initTe.toFixed(1));
        this.state.measured.ieRatio = initIe;
        this.state.measured.tiTtot = Math.round((initTi / (initTi + initTe)) * 100);
        this.state.measured.vtPerKg = parseFloat((initTheoVt / initIbw).toFixed(1));
        this.state.measured.ibw = initIbw;
        this.state.measured.leak = 0.0;
        this.state.measured.leakPercent = 0.0;
        this.state.measured.peepi = 0.0;
        this.state.measured.peepTotal = this.settings.epap;
        this.state.measured.holdPplat = null;
        this.state.measured.holdPeepTotal = null;
        this.state.measured.p01 = 0.0;
        this.state.measured.asynchronyIndex = 0;

        this._vtiAccum = 0;
        this._vteAccum = 0;
        this._pawInspBuffer = [];
        this.recentBreaths = [];
        this.frameEvents = [];
        this.frameSample = {
            pawMin: this.settings.epap,
            pawMax: this.settings.epap,
            pawLast: this.settings.epap,
            flowMin: 0,
            flowMax: 0,
            flowLast: 0,
            volMin: 0,
            volMax: 0,
            volLast: 0,
            pesMin: 0,
            pesMax: 0,
            pesLast: 0,
            flowLungMin: 0,
            flowLungMax: 0,
            flowLungLast: 0,
            volLungMin: 0,
            volLungMax: 0,
            volLungLast: 0
        };
        this.patientDrive.reset();
    }

    // Oppdatering per frame med fast internt tidssteg DT (A8)
    step(frameDt) {
        if (!this.isRunning) return;

        // C7 & D3: Klargjør min/maks-akkumulering og hendelsesliste for denne framen
        this.frameEvents = [];
        this.frameSample = {
            pawMin: Infinity,
            pawMax: -Infinity,
            pawLast: this.state.paw,
            flowMin: Infinity,
            flowMax: -Infinity,
            flowLast: this.state.flow,
            volMin: Infinity,
            volMax: -Infinity,
            volLast: this.state.volume,
            pesMin: Infinity,
            pesMax: -Infinity,
            pesLast: -this.state.pmus,
            flowLungMin: Infinity,
            flowLungMax: -Infinity,
            flowLungLast: this.state.flow_lung,
            volLungMin: Infinity,
            volLungMax: -Infinity,
            volLungLast: this.state.volume_lung
        };

        // Er frameDt > 0.5 (fanen har vært i bakgrunnen), hopp over framen og fortsett
        if (frameDt > 0.5) {
            this.state.dtCarry = 0;
            this._finalizeFrameSample();
            return;
        }

        const totalDt = frameDt + (this.state.dtCarry || 0);
        let n = Math.round(totalDt / DT);
        if (n > GRENSER.MAX_SUBSTEPS_PER_FRAME) {
            n = GRENSER.MAX_SUBSTEPS_PER_FRAME; // Maks 0.5s simulert tid per frame
        }
        this.state.dtCarry = totalDt - n * DT;

        for (let i = 0; i < n; i++) {
            this._singleStep(DT);
        }

        this._finalizeFrameSample();

        // Sikkerhetsventil: hvis numerisk ustabilitet oppdages, nullstill og varsle
        if (Math.abs(this.state.P_aw) > 200 || !isFinite(this.state.V)) {
            console.warn('Sikkerhetsventil utløst i VentilatorSimulator: P_aw eller V er utenfor gyldig område. Tilbakestiller tilstand.', {
                P_aw: this.state.P_aw,
                V: this.state.V
            });
            this.reset();
        }
    }

    _finalizeFrameSample() {
        if (this.frameSample.pawMin === Infinity) {
            this.frameSample.pawMin = this.state.paw;
            this.frameSample.pawMax = this.state.paw;
            this.frameSample.pawLast = this.state.paw;
            this.frameSample.flowMin = this.state.flow;
            this.frameSample.flowMax = this.state.flow;
            this.frameSample.flowLast = this.state.flow;
            this.frameSample.volMin = this.state.volume;
            this.frameSample.volMax = this.state.volume;
            this.frameSample.volLast = this.state.volume;
            this.frameSample.pesMin = -this.state.pmus;
            this.frameSample.pesMax = -this.state.pmus;
            this.frameSample.pesLast = -this.state.pmus;
            this.frameSample.flowLungMin = this.state.flow_lung;
            this.frameSample.flowLungMax = this.state.flow_lung;
            this.frameSample.flowLungLast = this.state.flow_lung;
            this.frameSample.volLungMin = this.state.volume_lung;
            this.frameSample.volLungMax = this.state.volume_lung;
        }
    }

    // 5.4: Oppdatering av min/maks-konvolutt per frame
    _recordFrameSample(curPaw, curFlow, curVol, curPes, curFlowLung, curVolLung) {
        if (curPaw < this.frameSample.pawMin) this.frameSample.pawMin = curPaw;
        if (curPaw > this.frameSample.pawMax) this.frameSample.pawMax = curPaw;
        this.frameSample.pawLast = curPaw;

        if (curFlow < this.frameSample.flowMin) this.frameSample.flowMin = curFlow;
        if (curFlow > this.frameSample.flowMax) this.frameSample.flowMax = curFlow;
        this.frameSample.flowLast = curFlow;

        if (curVol < this.frameSample.volMin) this.frameSample.volMin = curVol;
        if (curVol > this.frameSample.volMax) this.frameSample.volMax = curVol;
        this.frameSample.volLast = curVol;

        if (curPes < this.frameSample.pesMin) this.frameSample.pesMin = curPes;
        if (curPes > this.frameSample.pesMax) this.frameSample.pesMax = curPes;
        this.frameSample.pesLast = curPes;

        if (curFlowLung < this.frameSample.flowLungMin) this.frameSample.flowLungMin = curFlowLung;
        if (curFlowLung > this.frameSample.flowLungMax) this.frameSample.flowLungMax = curFlowLung;
        this.frameSample.flowLungLast = curFlowLung;

        if (curVolLung < this.frameSample.volLungMin) this.frameSample.volLungMin = curVolLung;
        if (curVolLung > this.frameSample.volLungMax) this.frameSample.volLungMax = curVolLung;
        this.frameSample.volLungLast = curVolLung;
    }

    // 5.4: Inspiratorisk holdmanøver
    startInspiratoryHold() {
        this._inspHoldRequested = true;
    }

    stopInspiratoryHold() {
        this._inspHoldRequested = false;
        if (this._inspHoldActive) {
            this._inspHoldActive = false;
            this._inspHoldTimer = 0.0;
            this._startExpiration();
        }
    }

    isInspiratoryHoldActive() {
        return this._inspHoldActive;
    }

    getHoldPplat() {
        return (this.state.measured.holdPplat !== null) ? this.state.measured.holdPplat : this.state.measured.pplat;
    }

    // 5.4: Ekspiratorisk holdmanøver
    startExpiratoryHold() {
        this._expHoldRequested = true;
    }

    stopExpiratoryHold() {
        this._expHoldRequested = false;
        if (this._expHoldActive) {
            this._expHoldActive = false;
            this._expHoldTimer = 0.0;
        }
    }

    isExpiratoryHoldActive() {
        return this._expHoldActive;
    }

    getHoldPeepTotal() {
        return (this.state.measured.holdPeepTotal !== null) ? this.state.measured.holdPeepTotal : (this.state.PEEPtotal || (this.settings.epap + this.state.PEEPi));
    }

    // 5.6: P0.1 Okklusjonstrykk ved 100 ms (respiratorisk drive)
    getP01() {
        if (this.patientDrive.rrSpont <= 0 && this.patientDrive.cardiacArtifact <= 0) return 0.0;
        const pMax = (this.patientDrive.responsive && this.patientDrive.effectivePmusMax !== undefined)
            ? this.patientDrive.effectivePmusMax
            : this.patientDrive.currentPmusMax;
        if (pMax <= 0.01) return 0.0;
        const trise = (this.patientDrive.currentTriseNeural !== null && this.patientDrive.currentTriseNeural > 0)
            ? this.patientDrive.currentTriseNeural
            : 0.30 * this.patientDrive.currentTiNeural;
        const tn = 0.10; // 100 ms
        const x = (trise > 0) ? Math.min(1.0, Math.max(0.0, tn / trise)) : 1.0;
        const p01 = pMax * x * x * (3.0 - 2.0 * x);
        return parseFloat(p01.toFixed(2));
    }

    _singleStep(dt) {
        this.state.totalTime += dt;
        this.state.timeInPhase += dt;

        // 5.4: Sikkerhets-timeout for holdmanøvrer (maksimal varighet 5.0 sekunder)
        if (this._inspHoldActive) {
            this._inspHoldTimer += dt;
            if (this._inspHoldTimer >= 5.0) {
                this.stopInspiratoryHold();
            }
        }
        if (this._expHoldActive) {
            this._expHoldTimer += dt;
            if (this._expHoldTimer >= 5.0) {
                this.stopExpiratoryHold();
            }
        }

        // 5.4: Når inspiratorisk eller ekspiratorisk hold er aktivt, er luftveien låst med flow lik null
        if (this._inspHoldActive || this._expHoldActive) {
            const C_L = this.patient.compliance / 1000;
            const P_el = this._pElastic(this._elasticVolume());
            this.state.P_el = P_el;
            this.state.P_aw = P_el;
            this.state.paw = P_el;
            this.state.P_servo = P_el;
            this.state.dP_servo = 0.0;
            this.state.I_servo = 0.0;
            this.state.P_sag = 0.0;
            this.state.Q_lunge = 0.0;
            this.state.Q_lekk = 0.0;
            this.state.Q_total = 0.0;
            this.state.Q_meas = 0.0;
            this.state.flow = 0.0;
            this.state.flow_lung = 0.0;
            this.state.volume = this.state.volume_meas;
            this.state.volume_lung = (this.state.V - C_L * this.settings.epap) * 1000;

            if (this._inspHoldActive) {
                this.state.measured.pplat = parseFloat(P_el.toFixed(1));
                this.state.measured.holdPplat = parseFloat(P_el.toFixed(1));
            } else if (this._expHoldActive) {
                this.state.PEEPtotal = parseFloat(P_el.toFixed(1));
                this.state.measured.peepTotal = parseFloat(P_el.toFixed(1));
                this.state.measured.holdPeepTotal = parseFloat(P_el.toFixed(1));
            }

            this._recordFrameSample(P_el, 0.0, this.state.volume, -this.state.P_mus, 0.0, this.state.volume_lung);
            return;
        }

        const C_L = this.patient.compliance / 1000; // L / cmH2O
        const R_insp = this.patient.resistance;      // cmH2O / (L/s)
        const expRatio = (this.patient.expRatio !== undefined) ? this.patient.expRatio : 1.5;
        const R_valve = (this.machine.R_valve !== undefined) ? this.machine.R_valve : 2.0;
        const R_exp = this.patient.resistance * expRatio + R_valve; // A6

        // 1. Pasientens autonome respirasjonssenter (A3, 5.2)
        const currentSupport = Math.max(0, this.settings.ipap - this.settings.epap);
        this.patientDrive.step(dt, this.state.totalTime, this.state.efforts, currentSupport);
        this.state.P_mus = this.patientDrive.P_mus;

        // Begrens innsatslogg til siste 60 sekunder
        if (this.state.efforts.length > 0 && this.state.efforts[0].t < this.state.totalTime - 60) {
            this.state.efforts = this.state.efforts.filter(e => e.t >= this.state.totalTime - 60);
        }

        // Kardiogent artefakt (flowoscillasjon fra hjerteslag ved ca 75 bpm / 1.25 Hz)
        const Q_cardiac = (this.patientDrive.cardiacArtifact / 60) * Math.sin(2 * Math.PI * 1.25 * this.state.totalTime);

        // Pneumatisk flow-turbulens ved maskelekkasje (skaper realistisk autotrigging ved stor lekkasje + sensitiv trigger)
        const Q_leak_turb = (this.settings.leak > 0)
            ? (this.settings.leak / 60) * 0.035 * (Math.sin(17.3 * this.state.totalTime) + Math.cos(29.7 * this.state.totalTime))
            : 0.0;

        // 2. Apné-overvåking (C3, D2): spor tid siden forrige levert pust
        const timeSinceLast = this.state.totalTime - this.state.lastSuccessfulBreathTime;
        this.state.timeSinceLastBreath = timeSinceLast;
        
        // FASE 6 (D2): Apné-alarm skille
        // Ved ST-modus aktiv ventileres pasienten av maskinen (rrSpont=0 gir ingen apné-alarm)
        const isStActive = !!(this.settings.stActive && this.settings.backupRate > 0);
        this.state.isApneaAlarm = (!isStActive && timeSinceLast >= this.settings.apneaDelay);

        // 3. Faseavhengig logikk, A4 Trigger-sjekk og D2 ST-backup
        let P_target = this.settings.epap;

        if (this.state.phase === 'expiration') {
            P_target = this.settings.epap;

            // Oppdater maskinens glidende lekkasje-estimat i sen ekspirasjon (tau = 4.0 s, jf. Fase 2 A4)
            // Estimerer lekkasjen ved det rådende mottrykket i masken
            const epapLeakTarget = (this.settings.leak / 60) * Math.sqrt(Math.max(0, this.state.P_aw) / 10);
            if (this.state.timeInPhase > 0.15) {
                this.state.Q_leak_estimert += (epapLeakTarget - this.state.Q_leak_estimert) * (dt / 4.0);
            }

            // Målt flow tilgjengelig for trigging (A4, A7)
            const Q_meas = this.state.Q_total - this.state.Q_leak_estimert + Q_cardiac + Q_leak_turb;
            this.state.Q_meas = Q_meas;

            // Spor topp-flow pasienten skaper mot triggerterskelen etter refraktærtiden (0.15 s)
            if (this.state.timeInPhase >= 0.15 && Q_meas > this.state.peakTriggerFlow) {
                this.state.peakTriggerFlow = Q_meas;
            }

            // D1 & D2: Sjekk maskinutløst pust (PC-modus kontrollfrekvens eller ST-backup frekvens)
            let isMachineTrigger = false;
            if (this.settings.mode === 'PC' || this.settings.mode === 'VC') {
                const pcRate = Math.max(GRENSER.MIN_RRSPONT_DIVISOR, this.settings.rr || 15);
                const pcInterval = 60 / pcRate;
                if (timeSinceLast >= pcInterval) {
                    isMachineTrigger = true;
                }
            } else if (isStActive) {
                const backupRate = Math.max(GRENSER.MIN_RRSPONT_DIVISOR, this.settings.backupRate || 12);
                const backupInterval = 60 / backupRate;
                if (timeSinceLast >= backupInterval) {
                    isMachineTrigger = true;
                }
            }

            if (isMachineTrigger) {
                if (this._expHoldRequested) {
                    this._expHoldActive = true;
                    this._expHoldTimer = 0.0;
                } else {
                    this.state.lastTriggerType = 'mandatory';
                    this.state.efforts.push({
                        t: this.state.totalTime,
                        detected: true,
                        type: 'mandatory'
                    });
                    if (this.patientDrive.currentEffort && !this.patientDrive.currentEffort.detected) {
                        if (!this.patientDrive.isNeuralActive()) {
                            this.patientDrive.currentEffort.detected = true;
                            this.patientDrive.currentEffort.type = 'mandatory';
                        }
                    }
                    this._startInspiration();
                    P_target = this.settings.ipap;
                }
            }

            // 5.4: Sjekk om ekspiratorisk hold skal aktiveres ved fullført tømming hos passiv pasient
            if (this._expHoldRequested && !this._expHoldActive && this.state.phase === 'expiration') {
                if (this.patientDrive.rrSpont === 0 && this.state.timeInPhase >= 0.5 && Math.abs(this.state.Q_lunge) < 0.01) {
                    this._expHoldActive = true;
                    this._expHoldTimer = 0.0;
                }
            }

            // Ekte triggeralgoritme (A4):
            // Refraktærtid på 0.15 s etter forrige cycling for å unngå kaskadetrigger
            // Bare hvis vi fremdeles er i ekspirasjon (ikke akkurat trigget av backup)
            if (this.state.phase === 'expiration') {
                const refractoryPeriod = 0.15;
                if (this.state.timeInPhase >= refractoryPeriod) {
                    let isTriggered = false;

                    if (this.settings.triggerMode === 'flow') {
                        const trigFlowLps = this.settings.triggerFlow / 60; // L/s
                        isTriggered = (Q_meas > trigFlowLps);
                    } else if (this.settings.triggerMode === 'pressure') {
                        isTriggered = (this.state.P_aw < this.settings.epap - this.settings.triggerPressure);
                    }

                    // 5.5 Tidsforskyvning av pasientinnsats: forsink maskinpustet ved negativ offset
                    if (this.patientDrive.pmusOffset < -0.01) {
                        if (isTriggered && !this._pmusTriggerPending) {
                            this._pmusTriggerPending = true;
                            this._pmusTriggerDelayTimer = Math.abs(this.patientDrive.pmusOffset);
                        }
                        if (this._pmusTriggerPending) {
                            this._pmusTriggerDelayTimer -= dt;
                            isTriggered = false;
                            if (this._pmusTriggerDelayTimer <= 0) {
                                this._pmusTriggerPending = false;
                                isTriggered = true;
                            }
                        }
                    } else {
                        this._pmusTriggerPending = false;
                        this._pmusTriggerDelayTimer = 0.0;
                    }

                    if (isTriggered) {
                        this._pmusTriggerPending = false;
                        this._pmusTriggerDelayTimer = 0.0;

                        // Bestem triggertype
                        const isNeural = this.patientDrive.erNevraltNaer();
                        let triggerType = 'assist';

                        if (isNeural) {
                            if (!this.patientDrive.isNeuralActive()) {
                                // Trigging skjedde i pretrigger-vinduet rett før ny innsats
                                this.patientDrive.pretriggeredEffort = true;
                                triggerType = 'assist';
                            } else {
                                // Dobbeltrigger: ny trigging hvis pasientens pågående innsats allerede har utløst pust i denne syklusen eller innen 0.50s etter forrige cycling
                                const isSecondaryInEffort = !!(this.patientDrive.currentEffort && this.patientDrive.currentEffort.detected);
                                if (this.state.breathCount > 0 && isSecondaryInEffort) {
                                    // Samme nevrale innsats har alt utløst et pust — dette er
                                    // en ekte dobbelttrigger. Ingen ny innsatspost pushes;
                                    // den eksisterende merkes 'double' nedenfor, slik at
                                    // hendelsen telles én gang.
                                    triggerType = 'double';
                                } else {
                                    triggerType = 'assist';
                                }

                                if (this.patientDrive.currentEffort) {
                                    if (this.patientDrive.currentEffort.markerEmitted) {
                                        // Innsatsen ble allerede markert som mislykket (missed) under forsinkelsen
                                        // Det forsinkede maskinpustet leveres som et asynkront / autotrigget pust
                                        triggerType = 'auto';
                                        this.state.efforts.push({
                                            t: this.state.totalTime,
                                            detected: true,
                                            type: 'auto'
                                        });
                                    } else {
                                        this.patientDrive.currentEffort.detected = true;
                                        this.patientDrive.currentEffort.type = triggerType;
                                    }
                                }
                            }
                        } else {
                            // Autotrigger: terskel krysset uten aktiv nevral pasientinnsats
                            triggerType = 'auto';
                            this.state.efforts.push({
                                t: this.state.totalTime,
                                detected: true,
                                type: 'auto'
                            });
                        }

                        this.state.lastTriggerType = triggerType;
                        if (this._expHoldRequested) {
                            this._expHoldActive = true;
                            this._expHoldTimer = 0.0;
                        } else {
                            this._startInspiration();
                            P_target = this.settings.ipap;
                        }
                    }
                }
            }

        } else if (this.state.phase === 'inspiration') {
            P_target = this.settings.ipap;

            // Målt flow i inspirasjon (lekkasjekorrigert) (A5, A7)
            const Q_meas = this.state.Q_total - this.state.Q_leak_estimert;
            this.state.Q_meas = Q_meas;

            // Spor toppflow Q_meas i innpustet
            if (Q_meas > this.state.peakQmeas) {
                this.state.peakQmeas = Q_meas;
            }

            // C5: Spor maksimalt luftveistrykk (PIP) og samle samples til Pplat (siste 100 ms)
            if (this.state.P_aw > this.state.pawMaxInBreath) {
                this.state.pawMaxInBreath = this.state.P_aw;
            }
            this._pawInspBuffer.push(this.state.P_aw);
            const maxBufferSamples = Math.round(0.10 / dt);
            if (this._pawInspBuffer.length > maxBufferSamples) {
                this._pawInspBuffer.shift();
            }

            // Sikkerhetsgrense / Topptrykksgrense (High Pressure Limit / Sikkerhetsbrems):
            // Avbryter inspirasjonen umiddelbart hvis luftveistrykket når grensen (effektiv grense er 10 cmH2O under innstilt alarmgrense)
            const setLimit = this.settings.alarmHighPpeak !== undefined ? this.settings.alarmHighPpeak : 40;
            const pHighLimit = Math.max(this.settings.epap + 2, setLimit - 10);
            let shouldCycle = false;
            let cycleReason = 'flow';

            if (pHighLimit > 0 && this.state.P_aw >= pHighLimit) {
                shouldCycle = true;
                cycleReason = 'pressureLimit';
            } else if (this.settings.mode === 'VC') {
                // 6.1 VC-MODUS: Innpustet avsluttes på levert volum, ikke på tid eller flow.
                // Er en inspiratorisk pause satt, holdes luftveien lukket etterpå slik at
                // trykket får utjevne seg til platåtrykket før ekspirasjonen slippes.
                const vtTarget = Math.max(1, this.settings.vcTidalVolume || 500);
                const pause = Math.max(0, this.settings.inspPause || 0);
                // Sikkerhetstak på Ti, i tilfelle volumet aldri nås (trykktak, stor lekkasje)
                const vcTiMax = Math.max(this.settings.tiSet, 3.0);

                if (this._vcPauseActive) {
                    if (this.state.timeInPhase >= this._vcFlowEndTime + pause) {
                        shouldCycle = true;
                        cycleReason = 'pause';
                    }
                } else if (this._vtiAccum >= vtTarget) {
                    if (pause > 0) {
                        this._vcPauseActive = true;
                        this._vcFlowEndTime = this.state.timeInPhase;
                    } else {
                        shouldCycle = true;
                        cycleReason = 'volume';
                    }
                } else if (this.state.timeInPhase >= vcTiMax) {
                    shouldCycle = true;
                    cycleReason = 'tiMax';
                }
            } else if (this.settings.mode === 'PC') {
                // PC-MODUS: Ingen flow-cycling — avsluttes utelukkende på tid (tiSet)
                if (this.state.timeInPhase >= this.settings.tiSet) {
                    shouldCycle = true;
                    cycleReason = 'timeSet';
                }
            } else {
                // PS-MODUS: Flow-cycling med tiMax tak (og tiMax * 0.7 for maskinutløste backup-pust)
                const isMandatory = (this.state.lastTriggerType === 'mandatory');
                const targetTiLimit = isMandatory ? (this.settings.tiMax * 0.7) : this.settings.tiMax;

                if (isMandatory) {
                    // ST-backup pust er tidsavbrutt ved Ti = tiMax * 0.7
                    if (this.state.timeInPhase >= targetTiLimit) {
                        shouldCycle = true;
                        cycleReason = 'timeSet';
                    }
                } else {
                    // Spontane pust i PS har flow-cycling
                    if (this.state.timeInPhase >= this.settings.tiMin) {
                        const cyclingThreshold = this.state.peakQmeas * this.settings.cyclingPercent;

                        if (Q_meas <= cyclingThreshold) {
                            // Normal flow-avslutning (Flow cycling)
                            shouldCycle = true;
                            cycleReason = 'flow';
                        } else if (this.state.timeInPhase >= targetTiLimit) {
                            // Tidsavbrutt innpust (Ti max)
                            shouldCycle = true;
                            cycleReason = 'tiMax';
                        }
                    }
                }
            }

            if (shouldCycle) {
                this.state.lastCycleReason = cycleReason;
                // 5.4: Hvis inspiratorisk hold er forespurt, lås luftveien i stedet for å starte ekspirasjon
                if (this._inspHoldRequested) {
                    this._inspHoldActive = true;
                    this._inspHoldTimer = 0.0;
                } else {
                    this._startExpiration();
                    P_target = this.settings.epap;
                }
            }
        }

        // Toppholding for visning: løftes av nye topper, henfaller langsomt.
        // Uten dette nullstilles verdien ved hvert pust og innsiktsboksen viser 0
        // mesteparten av tiden — og aldri noe i det hele tatt for en pasient
        // hvis innsatser ikke fanges.
        if (this.state.peakTriggerFlow > this.state.visPeakTriggerFlow) {
            this.state.visPeakTriggerFlow = this.state.peakTriggerFlow;
        } else {
            this.state.visPeakTriggerFlow *= Math.exp(-dt / 15.0);
        }

        // =========================================================================
        // DE 5 STEGENE I DEN FYSISKE VENTILATORMODELLEN (Fase 1, 2 & 3)
        // =========================================================================

        // Steg 1 — Måltrykket P_target
        this.state.P_target = P_target;

        // Steg 2 — Regulatoren P_servo, en dempet andreordens sløyfe
        const clamp = (val, min, max) => Math.max(min, Math.min(max, val));
        let zeta  = clamp(0.35 + 0.70 * (this.settings.riseTime - 0.05) / 0.85, 0.35, 1.05);
        // Asymmetrisk demping: ved trykkfall (overgang til EPAP) settes zeta til
        // minst 1.0 for å unngå bump over EPAP i utpustet.
        const erFall = (P_target < this.state.P_servo);
        if (erFall) {
            zeta = Math.max(zeta, 1.0);
        }
        const tRef = erFall ? GRENSER.FALLTID_SERVO : Math.max(GRENSER.MIN_RISETIME, this.settings.riseTime);
        const omega = (1.0 + 2.8 * zeta) / tRef; // rad/s
        const accel = omega * omega * (P_target - this.state.P_servo) - 2 * zeta * omega * this.state.dP_servo;
        this.state.dP_servo += accel * dt;
        this.state.P_servo  += this.state.dP_servo * dt;

        // Slangekompensasjon med foroverkobling.
        // En ekte respirator kjenner slangekarakteristikken og legger på
        // det forventede trykkfallet umiddelbart, uten å vente på et målt
        // avvik. Tilbakekoblingen (Ki-integrator) ble fjernet fordi den
        // brukte ~300 ms på å hente inn tapet, og lot integralet ligge
        // igjen ved fallende flow — noe som ga oversving over IPAP og
        // ringing ved overgang til EPAP.
        const R_out_eff_prev = this.machine.R_out + this.machine.K_out * Math.abs(this.state.Q_total);
        const kompensasjon = clamp(R_out_eff_prev * this.state.Q_total, -15, 15);
        this.state.I_servo = kompensasjon; // Beholder feltet for kompatibilitet
        let P_out = this.state.P_servo + kompensasjon;
        // Blåserens takhøyde: maks ipap + 12 cmH₂O
        P_out = Math.min(P_out, this.settings.ipap + 12);

        // Steg 3 — Masketrykket P_aw, løst algebraisk med A6 & A7 (6.2: ikke-lineær P/V)
        const P_el = this._pElastic(this._elasticVolume());
        this.state.P_el = P_el;

        // 5.1: Elastisk tilbakefjæring fra brystvegg (avtakende over ~0.3 s i tidlig ekspirasjon)
        let P_recoil = 0.0;
        const recStr = (this.patient.recoilStrength !== undefined) ? this.patient.recoilStrength : (this.patientDrive.rrSpont > 0 ? 25 : 0);
        if (this.state.phase === 'expiration' && recStr > 0 && this.state.timeInPhase < 0.30 && (this.state._vCyclingAboveRest || 0) > 0) {
            const tDecay = 1.0 - (this.state.timeInPhase / 0.30);
            P_recoil = (recStr / 100) * (this.state._vCyclingAboveRest / C_L) * tDecay;
        }
        const P_el_eff = P_el + P_recoil;

        // A6 & 5.3: Detaljert ekspiratorisk flowbegrensning og PEEP-stenting
        let P_crit = this.patient.criticalClosingPressure;
        let G_fl = this.patient.flowConductance;
        let stentPct = this.patient.peepStenting;

        if (P_crit === undefined && G_fl === undefined && stentPct === undefined) {
            const fl = this.patient.flowLimitation || 0;
            P_crit = (fl / 0.70) * 7.5;
            G_fl = Math.max(0.1, 1.0 - (fl / 0.70) * 0.5);
            stentPct = fl > 0 ? 70 : 0;
        } else {
            if (P_crit === undefined) P_crit = ((this.patient.flowLimitation || 0) / 0.70) * 7.5;
            if (G_fl === undefined) G_fl = Math.max(0.1, 1.0 - ((this.patient.flowLimitation || 0) / 0.70) * 0.5);
            if (stentPct === undefined) stentPct = (this.patient.flowLimitation || 0) > 0 ? 70 : 0;
        }

        const P_stent = this.settings.epap * (Math.max(0, Math.min(100, stentPct)) / 100);
        const P_crit_eff = Math.max(0, P_crit - P_stent);
        const ratio = P_crit_eff / (Math.max(0.1, G_fl) * 8.0);
        const effLimFactor = Math.pow(ratio, 1.5) * 1.5;

        const drivingExp = Math.max(0, P_el_eff + Math.max(0, -this.state.P_mus) - this.settings.epap);
        const R_exp_eff  = R_exp * (1 + effLimFactor * drivingExp / 10);

        // Bestem retning ut fra forrige tidsstegs drivtrykk for å unngå sirkelavhengighet
        const isInspDirection = (this.state.P_aw + this.state.P_mus - P_el_eff) > 0;
        let R_eff = isInspDirection ? R_insp : R_exp_eff;

        // 6.2: Åpningstrykk (threshold opening) med hysterese.
        // Under åpningstrykket er luftveien lukket og slipper ikke gass gjennom.
        // Den lukker seg ikke igjen før alveolærtrykket faller godt under terskelen —
        // det er nettopp derfor PEEP over lukketrykket holder lungen åpen.
        const P_open = this.patient.airwayOpeningPressure || 0;
        if (P_open > 0) {
            const P_distending = this.state.P_aw + this.state.P_mus;
            if (this._lungOpen) {
                if (P_el_eff < P_open * GRENSER.LUKKETRYKK_ANDEL) {
                    this._lungOpen = false;
                }
            } else if (P_distending >= P_open) {
                this._lungOpen = true;
            }
            if (!this._lungOpen) {
                R_eff = GRENSER.R_LUKKET_LUFTVEI;
            }
        } else {
            this._lungOpen = true;
        }

        // 7.1: Blåserens dynamiske utgangsimpedans mot uforutsett pasientdrag.
        //
        // Foroverkoblingen over kompenserer det kretsfallet maskinen selv kan regne
        // ut fra sin egen trykkommando. Pasientens innsats kjenner den derimot ikke:
        // P_mus står ikke i noen av maskinens målinger, og den delen av flowen som
        // muskelen driver — P_mus / R — treffer turbinen som en ren lastforstyrrelse.
        // Turbinen har treghet og bruker tauBlower på å hente inn kravet, og i
        // mellomtiden faller masketrykket.
        //
        // Det er dette fallet som gir de kliniske kjennetegnene:
        //   • triggerdippen under EPAP rett før et assistert pust
        //   • den vedvarende dippen ved en mislykket innsats (missed effort)
        //   • skalloperingen i trykkurven når etterspørselen overgår leveransen
        //   • trykkspiken over IPAP ved aktiv utpust (P_mus < 0 snur fortegnet)
        //
        // Leddet er et ekte washout-filter: det går mot null i stasjonærtilstand,
        // og lar derfor platåtrykk, EPAP-nivå og stigetidskalibreringen stå urørt.

        // Motstanden innsatsen arbeider mot følger innsatsens egen retning, ikke den
        // gjeldende flowretningen. R_eff veksler mellom R_insp og R_exp i det flowen
        // snur, og et slikt sprang midt i en pågående innsats ville gitt et kunstig
        // hakk i trykkurven nettopp der dobbelttrigging avgjøres.
        const R_pat = (this.state.P_mus >= 0) ? R_insp : R_exp_eff;
        const Q_pat = this._lungOpen ? (this.state.P_mus / R_pat) : 0.0; // L/s — pasientdrevet flowkomponent

        // Etterslepet er asymmetrisk. Et *voksende* krav er tregt uansett retning: skal
        // maskinen levere mer, må turbinen spinne opp, og skal den ta imot gass pasienten
        // presser inn, finnes det ikke noe sluk i en lekkasjekrets i det hele tatt. Å
        // trappe *ned* et krav som faller er derimot bare en reguleringshandling på
        // turbinturtallet, og går raskt. Uten dette skillet ville hver eneste relaksasjon
        // mot slutten av innpustet løftet trykket over IPAP, noe ekte kurver ikke gjør.
        const voksendeKrav = Math.abs(Q_pat) > Math.abs(this._Q_blower);
        const tauEff = voksendeKrav ? this.machine.tauBlower : this.machine.tauBlowerNed;
        this._Q_blower += (Q_pat - this._Q_blower) * (dt / tauEff);
        const dQ_umoett = Q_pat - this._Q_blower;                 // L/s — det turbinen ennå ikke leverer
        const P_sag = clamp(this.machine.R_dyn * dQ_umoett, -this.machine.sagMax, this.machine.sagMax);
        this.state.P_sag = P_sag;
        P_out -= P_sag;

        // 6.2: Rekruttert volum fylles når luftveien er åpen og slippes når den lukker seg.
        // Det holdes utenfor den elastiske ligningen, så det gir volum uten trykkøkning.
        const V_recruit_target = (P_open > 0 && this._lungOpen)
            ? Math.max(0, (this.patient.recruitedVolume || 0)) / 1000
            : 0;
        const Q_recruit = (V_recruit_target - this._V_recruit) / GRENSER.REKRUTTERING_TAU;

        // A7: Kontinuerlig lekkasje og linearisert konduktans G_leak
        const Q_leak_prev = (this.settings.leak / 60) * Math.sqrt(Math.max(0, this.state.P_aw) / 10);
        const G_leak = (this.settings.leak > 0) ? (Q_leak_prev / Math.max(GRENSER.MIN_PAW_FOR_LEAK, this.state.P_aw)) : 0;

        // Kretsimpedans etter Rohrer: laminært pluss turbulent ledd.
        // Trykkfallet mot masken er R_out_eff * flow. Det er dette fallet som
        // gir flow starvation og skallopering når pasientens etterspørsel
        // overgår leveransen — fenomenet faller ut av fysikken selv og trenger
        // ingen egen stigetidsavhengig faktor.
        const R_out_eff = this.machine.R_out + this.machine.K_out * Math.abs(this.state.Q_total);

        let P_aw;
        if (this.settings.mode === 'VC' && this.state.phase === 'inspiration') {
            // 6.1: I volumkontroll er maskinen en flowkilde, ikke en trykkilde.
            // Vi løser motsatt vei: hvilket masketrykk gir nøyaktig innstilt flow?
            //   Q_set = (P_aw + P_mus - P_el) / R + G_leak * P_aw
            // Under den inspiratoriske pausen er Q_set = 0, og formelen gir da
            // P_aw = P_el - P_mus: nettopp platåtrykket. Ved lekkasje faller
            // trykket langsomt under pausen, slik det også gjør klinisk.
            const Q_set = this._vcTargetFlow();
            P_aw = (Q_set - (this.state.P_mus - P_el_eff) / R_eff) / (1 / R_eff + G_leak);

            // Trykkbegrensning: volumkontroll har alltid et trykktak
            const vcLimit = Math.max(this.settings.epap + 2, (this.settings.alarmHighPpeak || 40) - 10);
            P_aw = Math.min(P_aw, vcLimit);
            P_aw = Math.max(P_aw, 0);

            // Hold regulatortilstanden i takt med det faktiske trykket, slik at
            // overgangen til EPAP ved cycling starter fra riktig punkt.
            this.state.P_servo = P_aw;
            this.state.dP_servo = 0.0;
            this.state.P_target = P_aw;
        } else {
            const num = P_out - R_out_eff * (this.state.P_mus - P_el_eff) / R_eff;
            const den = 1 + R_out_eff / R_eff + R_out_eff * G_leak;
            P_aw = num / den;
        }

        // Steg 4 — Flowbegrensning (kapasitetsgrense på blåser)
        let Q_lunge_temp = (P_aw + this.state.P_mus - P_el_eff) / R_eff;
        let Q_leak_temp  = (this.settings.leak / 60) * Math.sqrt(Math.max(0, P_aw) / 10);
        let Q_total_temp = Q_lunge_temp + Q_leak_temp;

        if (Q_total_temp > this.machine.Qmax) {
            const Q_lung_max = this.machine.Qmax - Q_leak_temp;
            P_aw = P_el_eff - this.state.P_mus + Q_lung_max * R_eff;
        }

        // Steg 5 — Lungen (bevegelseslikningen løst med beregnet P_aw)
        // 6.2: Rekrutteringsflowen legges til den elastiske flowen. Den er gass som
        // går inn i nyåpnede lungeområder, og teller derfor som ekte lungeflow.
        const Q_elastic = (P_aw + this.state.P_mus - P_el_eff) / R_eff;                  // L/s (flow inn i det elastiske rommet)
        const Q_lunge = Q_elastic + Q_recruit;                                           // L/s (sant pasientflow)
        const Q_leak  = (this.settings.leak / 60) * Math.sqrt(Math.max(0, P_aw) / 10);   // L/s (kontinuerlig lekkasjeflow)
        const Q_total = Q_lunge + Q_leak;                                                // L/s (total flow levert)

        // Rekruttert volum følger sin egen tilstand, slik at det kan trekkes fra igjen
        this._V_recruit = Math.max(0, this._V_recruit + Q_recruit * dt);

        this.state.P_aw = P_aw;
        this.state.Q_lunge = Q_lunge;
        this.state.Q_lekk = Q_leak;
        this.state.Q_total = Q_total;

        // Oppdater Q_meas også i pågående steg
        if (this.state.phase === 'expiration') {
            this.state.Q_meas = Q_total - this.state.Q_leak_estimert + Q_cardiac + Q_leak_turb;
        } else {
            this.state.Q_meas = Q_total - this.state.Q_leak_estimert;
        }

        // Integrer sant lungevolum over FRC (A1: aldri tvangsnullstilt)
        this.state.V += Q_lunge * dt;

        // Integrer maskinmålt volum (A7: integrert Q_meas)
        this.state.volume_meas += this.state.Q_meas * dt * 1000;
        this.state.volume_lung = (this.state.V - C_L * this.settings.epap) * 1000;

        // Integrer VTI (maskinlevert inspirasjonsvolum inkludert lekkasje) og VTE (ekspirert pasientvolum)
        if (this.state.phase === 'inspiration') {
            if (Q_total > 0) {
                this._vtiAccum += Q_total * dt * 1000;
            }
        } else {
            if (Q_lunge < 0) {
                this._vteAccum += (-Q_lunge) * dt * 1000;
            }
        }

        // Oppdater monitor- og kompatibilitetsfelter
        this.state.paw = P_aw;
        this.state.pmus = this.state.P_mus;
        this.state.flow = this.state.Q_meas * 60; // L/min (Q_cardiac ligger allerede i Q_meas)
        this.state.flow_lung = (Q_lunge + (this.state.phase === 'expiration' ? Q_cardiac : 0)) * 60;      // L/min (sann lungekurve)
        this.state.volume = this.state.volume_meas; // ml (maskinmålt volumkurve i monitoren)

        // Oppdater kontinuerlige lekkasjemålinger (A7)
        this.state.measured.leak = parseFloat((Q_leak * 60).toFixed(1));

        // C3: Spor varighet over lekkasjegrense (% eller L/min)
        const isLeakOver = (this.settings.alarmLeakUnit === 'percent')
            ? ((this.state.measured.leakPercent || 0) > this.settings.alarmLeakPercentLimit)
            : (this.state.measured.leak > this.settings.alarmLeakLimit);

        if (isLeakOver) {
            this.state.alarmState.leakTimeAbove += dt;
        } else {
            this.state.alarmState.leakTimeAbove = Math.max(0, this.state.alarmState.leakTimeAbove - dt * 2);
        }

        // C1: Kontinuerlig rullerende 60-sekunders vindu med tidsnormalisering (S2)
        if (this.recentBreaths.length > 0 && this.recentBreaths[0].t < this.state.totalTime - 60) {
            this.recentBreaths = this.recentBreaths.filter(b => b.t >= this.state.totalTime - 60);
        }
        
        const b60 = this.recentBreaths;
        const windowSec = Math.min(60, Math.max(1, this.state.totalTime));
        const rrtot = (this.state.totalTime >= 60) ? b60.length : (b60.length > 0 ? Math.round((b60.length / windowSec) * 60) : (this.state.measured.rrTotal || 0));
        const rrspont_cnt = b60.filter(b => b.triggerType === 'assist' || b.triggerType === 'double').length;
        const rrspont = (this.state.totalTime >= 60) ? rrspont_cnt : (b60.length > 0 ? Math.round((rrspont_cnt / windowSec) * 60) : (this.state.measured.rrSpont || 0));
        const spontPct = (b60.length > 0) ? Math.round((rrspont_cnt / b60.length) * 100) : ((this.patientDrive.rrSpont > 0) ? 100 : 0);
        this.state.measured.rrTotal = rrtot;
        this.state.measured.rrSpont = rrspont;
        this.state.measured.spontPercent = Math.min(100, Math.max(0, spontPct));

        const meanVte60 = (b60.length > 0) ? (b60.reduce((s, b) => s + b.vte, 0) / b60.length) : (this.state.measured.vt || 0);
        this.state.measured.mv = parseFloat(((meanVte60 * rrtot) / 1000).toFixed(2));

        // D5: Asynkroni-indeks over siste 60 sekunder fra state.efforts
        const eff60 = this.state.efforts.filter(e => e.t >= this.state.totalTime - 60);
        const totalEff = eff60.length;
        const asynchCount = eff60.filter(e => e.type === 'missed' || e.type === 'auto' || e.type === 'double').length;
        this.state.measured.asynchronyIndex = (totalEff > 0) ? Math.round((asynchCount / totalEff) * 100) : 0;

        // C3: Evaluer alle aktive alarmer (prioriter apné øverst)
        const alarms = [];
        if (this.state.isApneaAlarm) {
            alarms.push({
                id: 'apnea',
                priority: 1,
                type: 'danger',
                title: 'APNÉ',
                msg: `APNÉ: ingen levert pust i ${Math.round(timeSinceLast)} sekunder. Kontroller pasientinnsats, trigger og lekkasje.`
            });
        }
        const setHighLimit = this.settings.alarmHighPpeak !== undefined ? this.settings.alarmHighPpeak : 40;
        const highPressureLimit = Math.max(this.settings.epap + 2, setHighLimit - 10);
        if (highPressureLimit > 0 && (this.state.measured.ppeak >= highPressureLimit || this.state.lastCycleReason === 'pressureLimit')) {
            alarms.push({
                id: 'high_pressure',
                priority: 2,
                type: 'warning',
                title: 'HØYT TOPPTRYKK',
                msg: `Topptrykk (${this.state.measured.ppeak.toFixed(1)} cmH₂O) nådde sikkerhetsgrensen (${highPressureLimit.toFixed(1)} cmH₂O, 10 cmH₂O under innstilt ${setHighLimit} cmH₂O). Inspirasjonen ble avbrutt som sikkerhetsbrems for å beskytte pasienten.`
            });
        }
        if (this.state.alarmState.lowVtStreak >= 3) {
            alarms.push({
                id: 'low_vt',
                priority: 3,
                type: 'warning',
                title: 'LAVT TIDALVOLUM',
                msg: `VTE under ${this.settings.alarmLowVtLimit} ml i 3 påfølgende pust (siste: ${this.state.measured.vt} ml).`
            });
        }
        if (this.state.alarmState.highVtStreak >= 3) {
            alarms.push({
                id: 'high_vt',
                priority: 3,
                type: 'warning',
                title: 'HØYT TIDALVOLUM',
                msg: `VTE over ${this.settings.alarmHighVtLimit} ml i 3 påfølgende pust (siste: ${this.state.measured.vt} ml).`
            });
        }
        if (this.settings.alarmLowRrLimit > 0 && this.state.measured.rrTotal < this.settings.alarmLowRrLimit && !this.state.isApneaAlarm) {
            alarms.push({
                id: 'low_rr',
                priority: 4,
                type: 'warning',
                title: 'LAV FREKVENS',
                msg: `Målt RRtot (${this.state.measured.rrTotal} /min) er under lav grense (${this.settings.alarmLowRrLimit} /min).`
            });
        }
        if (this.state.measured.rrTotal > this.settings.alarmHighRrLimit) {
            alarms.push({
                id: 'high_rr',
                priority: 4,
                type: 'warning',
                title: 'HØY FREKVENS',
                msg: `Målt RRtot (${this.state.measured.rrTotal} /min) overstiger grensen (${this.settings.alarmHighRrLimit} /min).`
            });
        }
        if (this.state.alarmState.leakTimeAbove >= 10.0) {
            const leakMsg = (this.settings.alarmLeakUnit === 'percent')
                ? `Lekkasje (${this.state.measured.leakPercent || 0} %) har oversteget ${this.settings.alarmLeakPercentLimit} % i mer enn 10 sekunder.`
                : `Lekkasje (${this.state.measured.leak.toFixed(1)} L/min) har oversteget ${this.settings.alarmLeakLimit} L/min i mer enn 10 sekunder.`;
            alarms.push({
                id: 'high_leak',
                priority: 5,
                type: 'warning',
                title: 'HØY LEKKASJE',
                msg: leakMsg
            });
        }
        this.state.activeAlarms = alarms;

        // C7 & D3: Akkumuler min/maks-konvolutt for denne framen
        const curPaw = this.state.P_aw;
        const curFlow = this.state.flow;
        const curVol = this.state.volume;
        const curPes = -this.state.P_mus;
        const curFlowLung = this.state.flow_lung;
        const curVolLung = this.state.volume_lung;

        this._recordFrameSample(curPaw, curFlow, curVol, curPes, curFlowLung, curVolLung);

        // 5.6: P0.1 oppdateres kontinuerlig
        this.state.measured.p01 = this.getP01();
        this.state.P01 = this.state.measured.p01;

        // Sporing av pasientinnsats-markører (D3)
        if (this.patientDrive.currentEffort && !this.patientDrive.currentEffort.detected && !this.patientDrive.currentEffort.markerEmitted) {
            const missedThreshold = Math.min(this.patientDrive.currentTriseNeural, this.patientDrive.currentTiNeural * 0.45);
            if (this.patientDrive.timeInCycle >= missedThreshold) {
                this.patientDrive.currentEffort.markerEmitted = true;
                this.patientDrive.currentEffort.type = 'missed';
                this.frameEvents.push({ type: 'missed', t: this.patientDrive.currentEffort.t });
            }
        }
    }

    _startInspiration() {
        this.state.phase = 'inspiration';
        this.state.timeInPhase = 0;
        this.state.breathStartTime = this.state.totalTime;
        this.state.lastSuccessfulBreathTime = this.state.totalTime;
        this.state.peakQmeas = 0.0;
        this.state.justTriggered = true;
        this.state.isApneaAlarm = false;
        this.state.breathCount++;

        // 6.1: Ny volumleveranse — eventuell pause fra forrige pust nullstilles
        this._vcPauseActive = false;
        this._vcFlowEndTime = 0.0;

        // 6.3: Maskinutløste pust kan dra pasientens respirasjonssenter med seg (omvendt trigging)
        if (this.state.lastTriggerType === 'mandatory') {
            this.patientDrive.onMachineBreath(this.state.totalTime);
        }

        // D3: Registrer markørhendelse for utløst innpust
        if (this.patientDrive.currentEffort) {
            this.patientDrive.currentEffort.markerEmitted = true;
        }
        this.frameEvents.push({ type: this.state.lastTriggerType, t: this.state.totalTime });

        // C6: Mål faktisk ekspirasjonstid Te mellom forrige cycling og dette innpustet
        if (this.state.lastCycleTime > 0) {
            this.state.lastTe = Math.max(GRENSER.MIN_TE_MEASURED, this.state.totalTime - this.state.lastCycleTime);
        }

        // A1 & A6: Volum over FRC nullstilles ALDRI! Registrer V_endExp og PEEPi ved pustestart
        const C_L = this.patient.compliance / 1000;
        this.state.V_endExp = this.state.V;
        this.state.PEEPi = Math.max(0, this._pElastic(this.state.V_endExp - this._V_recruit) - this.settings.epap);
        this.state.measured.peepi = parseFloat(this.state.PEEPi.toFixed(1));

        // A7: Maskinmålt volum lagres for slutt-ekspirasjon og nullstilles for ny pust
        this.state.lastV_endExp_meas = this.state.volume_meas;
        this.state.volume_meas = 0.0;

        // VTE fra det fullførte utpustet
        this.state.VTE = Math.round(this._vteAccum);

        // C3: Spor påfølgende pust med lavt eller høyt tidalvolum
        if (this.state.breathCount > 1) {
            if (this.state.VTE < this.settings.alarmLowVtLimit) {
                this.state.alarmState.lowVtStreak++;
                this.state.alarmState.highVtStreak = 0;
            } else if (this.state.VTE > this.settings.alarmHighVtLimit) {
                this.state.alarmState.highVtStreak++;
                this.state.alarmState.lowVtStreak = 0;
            } else {
                this.state.alarmState.lowVtStreak = 0;
                this.state.alarmState.highVtStreak = 0;
            }
        }

        // C1 & C5 & C6: Lagre det fullførte pustet i 60-sekunders historikken
        if (this.state.breathCount > 1) {
            const vtiVal = this.state.VTI;
            const vteVal = this.state.VTE;
            const breathLeakPct = (vtiVal > 0) ? Math.max(0, Math.min(100, Math.round(((vtiVal - vteVal) / vtiVal) * 100))) : 0;
            this.state.measured.leakPercent = breathLeakPct;

            this.recentBreaths.push({
                t: this.state.totalTime,
                vti: this.state.VTI,
                vte: this.state.VTE,
                pip: this.state.lastPip,
                pplat: this.state.lastPplat,
                ti: this.state.lastTi,
                te: this.state.lastTe,
                triggerType: this.state.lastTriggerType,
                cycleReason: this.state.lastCycleReason
            });

            // Begrens historikk til siste 60 sekunder
            this.recentBreaths = this.recentBreaths.filter(b => b.t >= this.state.totalTime - 60);

            // C1: Glatt enkeltpust-målinger over de siste 3 pustene
            this._updateSmoothedMetrics();
        }

        // Nullstill akkumulatorer for nytt innpust
        this._vtiAccum = 0;
        this._vteAccum = 0;
        this.state.pawMaxInBreath = this.state.P_aw;
        this._pawInspBuffer = [this.state.P_aw];
    }

    _startExpiration() {
        this.state.phase = 'expiration';
        this.state.peakTriggerFlow = 0.0;
        const ti = this.state.timeInPhase;
        this.state.lastTi = ti;
        this.state.timeInPhase = 0;
        this.state.lastCycleTime = this.state.totalTime;

        // 5.1: Registrer volum over hvilevolum ved cycling for elastisk tilbakefjæring
        const C_L = this.patient.compliance / 1000;
        this.state._vCyclingAboveRest = Math.max(0, this.state.V - C_L * this.settings.epap);

        // A1: Registrer VTI for avsluttet innpust
        this.state.VTI = Math.round(this._vtiAccum);

        // C5: PIP er maksimalt trykk gjennom hele innpustet
        this.state.lastPip = parseFloat(this.state.pawMaxInBreath.toFixed(1));

        // C5: Pplat er gjennomsnittet av P_aw de siste 100 ms før cycling
        const pplatCalc = (this._pawInspBuffer.length > 0)
            ? (this._pawInspBuffer.reduce((a, b) => a + b, 0) / this._pawInspBuffer.length)
            : this.state.P_aw;
        this.state.lastPplat = parseFloat(pplatCalc.toFixed(1));
    }

    // C1 & C6 & D5: Oppdater målinger glattet over de 3 siste pustene
    _updateSmoothedMetrics() {
        const last3 = this.recentBreaths.slice(-3);
        if (last3.length === 0) return;

        const avg = (key) => last3.reduce((sum, b) => sum + b[key], 0) / last3.length;

        this.state.measured.vti = Math.round(avg('vti'));
        this.state.measured.vte = Math.round(avg('vte'));
        this.state.measured.vt = this.state.measured.vte; // C1: Vt er VTE
        this.state.measured.ppeak = parseFloat(avg('pip').toFixed(1));
        this.state.measured.pplat = parseFloat(avg('pplat').toFixed(1));
        this.state.measured.ti = parseFloat(avg('ti').toFixed(2));
        this.state.measured.te = parseFloat(avg('te').toFixed(2));

        // C6: I:E-forhold og Ti/Ttot
        const tiVal = this.state.measured.ti;
        const teVal = this.state.measured.te;
        if (tiVal > 0 && teVal > 0) {
            if (teVal >= tiVal) {
                const ratio = (teVal / tiVal).toFixed(1).replace('.', ',');
                this.state.measured.ieRatio = `1:${ratio}`;
            } else {
                const ratio = (tiVal / teVal).toFixed(1).replace('.', ',');
                this.state.measured.ieRatio = `${ratio}:1`;
            }
            this.state.measured.tiTtot = Math.round((tiVal / (tiVal + teVal)) * 100);
        } else if (tiVal > 0) {
            this.state.measured.ieRatio = '1:0,0';
            this.state.measured.tiTtot = 100;
        } else {
            this.state.measured.ieRatio = '--:--';
            this.state.measured.tiTtot = 0;
        }

        // D5: Vt/kg IBW
        const ibw = this.getPatientIBW();
        this.state.measured.ibw = ibw;
        this.state.measured.vtPerKg = (ibw > 0 && this.state.measured.vt > 0)
            ? parseFloat((this.state.measured.vt / ibw).toFixed(1))
            : 0;
    }

    // FASE 6 (C12): Regelbasert fysiologisk analyse og klinisk innsikt
    getPhysiologicalInsights() {
        const C = this.patient.compliance;
        const R_insp = this.patient.resistance;
        const expRatio = (this.patient.expRatio !== undefined) ? this.patient.expRatio : 1.5;
        const R_valve = (this.machine.R_valve !== undefined) ? this.machine.R_valve : 2.0;
        const R_exp = R_insp * expRatio + R_valve;
        const tauInsp = (C * R_insp) / 1000; // Inspiratorisk tidskonstant: Tau = C * R
        const tauExp = (C * R_exp) / 1000;   // Ekspiratorisk tidskonstant
        const drivingPressure = this.settings.ipap - this.settings.epap;
        const peepi = this.state.PEEPi || 0;
        const erVolumkontroll = (this.settings.mode === 'VC');
        // 6.1: I volumkontroll er tidalvolumet innstilt, ikke et resultat av drivtrykket.
        // Da er det drivtrykket som er den avhengige størrelsen, og pasientens innsats
        // senker trykket i stedet for å øke volumet.
        const machineVt = erVolumkontroll
            ? Math.round(this.settings.vcTidalVolume || 500)
            : Math.round(C * Math.max(0, drivingPressure - peepi));
        // Pasientens eget bidrag ved gjeldende muskelkraft
        const patientVt = erVolumkontroll ? 0 : Math.round(C * this.patientDrive.pmusMax);
        const theoreticalVt = machineVt + patientVt;
        const timeFor95Expiration = (3 * tauExp).toFixed(2); // 3 * Tau gir 95% tømming

        const triggerFlow = this.settings.triggerFlow;
        // Faktisk målt topp-flow pasienten klarer å skape før trigging.
        // Denne er compliance- og rampebegrenset, ikke Pmus/R.
        const patientGeneratedFlow = parseFloat((this.state.visPeakTriggerFlow * 60).toFixed(1));
        const lastCycleReason = this.state.lastCycleReason;

        const rules = [];

        // Regel 1: Obstruksjon (R >= 12)
        if (R_insp >= 12) {
            rules.push(`⚠️ <strong>Obstruksjon (R = ${R_insp} cmH₂O/(L/s)):</strong> Høy luftveismotstand gir forlenget ekspirasjonstidskonstant (τ<sub>exp</sub> = ${tauExp.toFixed(2)} s) og forsinket tømming (tar minst ${timeFor95Expiration} s å nå 95 % tømming). Karakteristisk langstrakt flow-hale.`);
        }

        // Regel 2: Restriksjon (C <= 30)
        if (C <= 30) {
            rules.push(`⚠️ <strong>Restriksjon (C = ${C} ml/cmH₂O):</strong> Stive lunger med lav ettergivelighet gir rask trykkutjevning, men krever vesentlig høyere drivtrykk (ΔP) for å oppnå fysiologisk tidalvolum (forventet kun ca. ${theoreticalVt} ml ved ΔP ${drivingPressure} cmH₂O).`);
        }

        // Regel 3: Auto-PEEP (PEEPi > 2)
        if (peepi > 2.0) {
            rules.push(`🚨 <strong>Dynamisk hyperinflasjon / Auto-PEEP (PEEPi = ${peepi.toFixed(1)} cmH₂O):</strong> Fanget ekspiratorisk luft skaper et positivt indre mottrykk. Pasienten må trekke ned ${peepi.toFixed(1)} cmH₂O ekstra før triggerterskelen nås. Økning av EPAP eller forlenget ekspirasjonstid (lavere frekvens/kortere Ti) kan gjenopprette trigging.`);
        } else if (peepi > 0.8) {
            rules.push(`⚠️ <strong>Mild auto-PEEP (PEEPi = ${peepi.toFixed(1)} cmH₂O):</strong> Begynnende luftfanging pga. ufullstendig ekspirasjon.`);
        }

        // Regel 4: Asynkroni (asynkroni-indeks > 10%)
        const asynchIdx = this.state.measured.asynchronyIndex || 0;
        if (asynchIdx > 10) {
            const eff60 = this.state.efforts.filter(e => e.t >= this.state.totalTime - 60);
            const missedCount = eff60.filter(e => e.type === 'missed').length;
            const autoCount = eff60.filter(e => e.type === 'auto').length;
            const doubleCount = eff60.filter(e => e.type === 'double').length;
            let domType = 'Asynkroni';
            let causeText = 'Manglende samspill mellom pasient og maskin.';
            if (missedCount >= autoCount && missedCount >= doubleCount && missedCount > 0) {
                domType = 'Mislykkede triggere (Missed efforts)';
                causeText = peepi > 1.5
                    ? 'Skyldes primært auto-PEEP som pasienten ikke overvinner.'
                    : `Skyldes at pasientens innsats (målt topp-flow ${patientGeneratedFlow} L/min) ikke overstiger triggerterskelen (${triggerFlow} L/min). Flowen en innsats kan skape avhenger av både muskelkraft og lungenes ettergivelighet.`;
            } else if (autoCount >= missedCount && autoCount >= doubleCount && autoCount > 0) {
                domType = 'Autotrigging';
                causeText = 'Skyldes for sensitiv trigger, maskelekkasje eller kardiogene oscillasjoner.';
            } else if (doubleCount > 0) {
                domType = 'Dobbelttrigging';
                causeText = 'Skyldes for tidlig avslutning (for høy cycling eller for kort Ti) mens pasienten fortsatt har nevral inspirasjon.';
            }
            rules.push(`⚡ <strong>Betydelig asynkroni (${asynchIdx} %):</strong> Dominerende form: <em>${domType}</em>. ${causeText}`);
        }

        // Regel 5: Lekkasje (lekkasje % > 25 eller lekkasje > 25 L/min)
        const leakPct = this.state.measured.leakPercent || 0;
        const leakVal = this.state.measured.leak || 0;
        if (leakPct > 25 || leakVal > 25) {
            rules.push(`💨 <strong>Høy maskelekkasje (${leakVal.toFixed(1)} L/min, ${leakPct.toFixed(0)} %):</strong> Kan forsinke flow-cycling (fare for Ti-max avbrudd), utløse autotrigging og skape feilaktig avlesning av ekspirert tidalvolum.`);
        }

        // Regel 6: Cyclingårsak (lastCycleReason)
        if (lastCycleReason === 'pressureLimit') {
            const setLimit = this.settings.alarmHighPpeak !== undefined ? this.settings.alarmHighPpeak : 40;
            const pHighLim = Math.max(this.settings.epap + 2, setLimit - 10).toFixed(1);
            rules.push(`🛑 <strong>Topptrykksgrense nådd (Sikkerhetsbrems):</strong> Luftveistrykket nådde den effektive sikkerhetsgrensen (${pHighLim} cmH₂O, 10 cmH₂O under innstilt ${setLimit} cmH₂O). Inspirasjonen ble avbrutt umiddelbart for å beskytte lungene mot barotraume/skade.`);
        } else if (lastCycleReason === 'tiMax') {
            rules.push(`⏱️ <strong>Tidsavbrutt inspirasjon (Ti-max = ${this.settings.tiMax.toFixed(1)} s):</strong> Maskinen avsluttet innpustet på maksimal sikkerhetstid fordi flow ikke sank under cycling-grensen (${Math.round(this.settings.cyclingPercent * 100)} %). Typisk ved stor lekkasje eller lang tidskonstant.`);
        }

        // Regel 7: Vt per kg IBW (alltid inkludert)
        const vtPerKg = this.state.measured.vtPerKg || 0;
        const ibw = this.state.measured.ibw || 70;
        let vtComment = '';
        if (vtPerKg >= 6 && vtPerKg <= 8) {
            vtComment = `Fysiologisk lungeprotektivt volum (6–8 ml/kg IBW).`;
        } else if (vtPerKg < 6 && vtPerKg > 0) {
            vtComment = `Lavt tidalvolum (< 6 ml/kg IBW) — fare for hypoventilasjon / atelektaser.`;
        } else if (vtPerKg > 8) {
            vtComment = `Høyt tidalvolum (> 8 ml/kg IBW) — fare for volutrauma / overstrekk.`;
        } else {
            vtComment = `Beregnet mot idealvekt (${ibw} kg).`;
        }
        rules.push(`👤 <strong>Tidalvolum:</strong> Målt ${this.state.measured.vt} ml (${vtPerKg.toFixed(1)} ml/kg IBW for ${ibw} kg). ${vtComment}`);

        // Hvis verken obstruksjon eller restriksjon er aktiv, vis normalmekanikk
        if (R_insp < 12 && C > 30) {
            rules.unshift(`✅ <strong>Normal lungemekanikk:</strong> Normal ettergivelighet (C = ${C} ml/cmH₂O) og motstand (R = ${R_insp} cmH₂O/(L/s), τ = ${tauExp.toFixed(2)} s). Lungene tømmes uanstrengt.`);
        }

        const clinicalNote = rules.map(r => `<div style="margin-bottom: 5px;">${r}</div>`).join('');

        return {
            tau: tauExp.toFixed(2),
            tauInsp: tauInsp.toFixed(2),
            tauExp: tauExp.toFixed(2),
            theoreticalVt,
            machineVt,
            patientVt,
            timeFor95Expiration,
            // 6.1: I volumkontroll måles drivtrykket (Pplat − PEEPtotal) i stedet for å innstilles
            drivingPressure: erVolumkontroll
                ? parseFloat(Math.max(0, (this.state.measured.pplat || 0) - (this.settings.epap + peepi)).toFixed(1))
                : drivingPressure,
            erVolumkontroll,
            triggerFlow,
            patientGeneratedFlow,
            lastCycleReason,
            peepi: peepi.toFixed(1),
            clinicalNote
        };
    }
}

// Gjør tilgjengelig globalt
window.VentilatorSimulator = VentilatorSimulator;
