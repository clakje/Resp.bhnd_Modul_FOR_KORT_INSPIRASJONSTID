/**
 * app.js — Scenario-spiller for Respirator-simulatoren (kursdeltakerversjon)
 *
 * Spilleren har ingen egne innstillinger. Alt som vises kommer fra en scenario.json
 * eksportert fra Respirator Scenario-Generator:
 *
 *   • initialState.machine / .patient / .alarms  →  starttilstanden simulatoren settes til
 *   • uiConfig.visibleControls                   →  hvilke parametere deltakeren får justere
 *   • uiConfig.controls                          →  label, type, enhet, min/max/step og default
 *   • meta                                       →  tittel, beskrivelse, læringsmål og fasit
 *
 * Parametere som ikke står i visibleControls bygges aldri som kontroll. De blir stående
 * låst på verdien scenariet ga dem.
 *
 * Fysikken (simulator.js) og tegningen (renderer.js) brukes uforandret.
 */
document.addEventListener('DOMContentLoaded', () => {
    'use strict';

    // =========================================================================
    // 1. KJERNEKOMPONENTER
    // =========================================================================
    const simulator = new VentilatorSimulator();
    const renderer = new WaveformRenderer('waveformCanvas');

    // =========================================================================
    // 2. PARAMETERKART
    // =========================================================================
    // Nøklene i scenario.json er UI-nøkler og følger badgenes enheter. Simulatoren
    // bruker dels andre navn og dels andre enheter (cycling i prosent mot brøk,
    // stigetid i millisekunder mot sekunder, pasientens drive i et eget objekt).
    // Kartet under er den eneste oversettelsen mellom de to, og speiler nøyaktig
    // det generatorens egen app.js gjør når den skriver til simulatoren.
    //
    //   group  = hvilken bolk i initialState verdien hentes fra
    //   read   = les gjeldende verdi ut av simulatoren, i UI-enhet
    //
    // Selve skrivingen skjer samlet i commit(), fordi flere parametere henger
    // sammen (triggerfølsomhet avhenger av triggertype, innsatsformen av
    // Ti_neural, rekruttert volum av åpningstrykket).
    const PARAMS = {
        // ---------------------------------------------------------------- MASKIN
        mode:            { group: 'machine', read: s => s.settings.mode },
        ipap:            { group: 'machine', read: s => s.settings.ipap },
        epap:            { group: 'machine', read: s => s.settings.epap },
        vcTidalVolume:   { group: 'machine', read: s => s.settings.vcTidalVolume },
        vcPeakFlow:      { group: 'machine', read: s => s.settings.vcPeakFlow },
        vcFlowPattern:   { group: 'machine', read: s => s.settings.vcFlowPattern },
        inspPause:       { group: 'machine', read: s => s.settings.inspPause },
        tiSet:           { group: 'machine', read: s => s.settings.tiSet },
        backupRate:      { group: 'machine', read: s => s.settings.backupRate },
        stActive:        { group: 'machine', read: s => s.settings.stActive },
        fio2:            { group: 'machine', read: s => s.settings.fio2 },
        rr:              { group: 'machine', read: s => s.settings.rr },
        triggerMode:     { group: 'machine', read: s => s.settings.triggerMode },
        trigger:         { group: 'machine', read: s => (s.settings.triggerMode === 'pressure' ? s.settings.triggerPressure : s.settings.triggerFlow) },
        cycling:         { group: 'machine', read: s => s.settings.cyclingPercent * 100 },
        tiMax:           { group: 'machine', read: s => s.settings.tiMax },
        riseTime:        { group: 'machine', read: s => s.settings.riseTime * 1000 },
        leak:            { group: 'machine', read: s => s.settings.leak },

        // -------------------------------------------------------------- PASIENT
        height:                  { group: 'patient', read: s => s.patient.height },
        gender:                  { group: 'patient', read: s => s.patient.gender },
        compliance:              { group: 'patient', read: s => s.patient.compliance },
        resistance:              { group: 'patient', read: s => s.patient.resistance },
        rrSpont:                 { group: 'patient', read: s => s.patientDrive.rrSpont },
        pmus:                    { group: 'patient', read: s => s.patientDrive.pmusMax },
        responsiveness:          { group: 'patient', read: s => s.patientDrive.responsiveness },
        responsivePmus:          { group: 'patient', read: s => s.patientDrive.responsive },
        pmusOffset:              { group: 'patient', read: s => s.patientDrive.pmusOffset },
        tiNeural:                { group: 'patient', read: s => s.patientDrive.tiNeural },
        kobleTiNeural:           { group: 'patient', read: s => s.patientDrive.kobleTiNeural },
        triseNeural:             { group: 'patient', read: s => (s.patientDrive.triseNeural == null ? 0.30 : s.patientDrive.triseNeural) },
        tholdNeural:             { group: 'patient', read: s => (s.patientDrive.tholdNeural == null ? 0.00 : s.patientDrive.tholdNeural) },
        tdecayNeural:            { group: 'patient', read: s => (s.patientDrive.tdecayNeural == null ? 0.40 : s.patientDrive.tdecayNeural) },
        pmusExp:                 { group: 'patient', read: s => s.patientDrive.pmusExp },
        recoil:                  { group: 'patient', read: s => s.patient.recoilStrength },
        flowLimitation:          { group: 'patient', read: s => s.patient.flowLimitation },
        criticalClosingPressure: { group: 'patient', read: s => s.patient.criticalClosingPressure },
        flowConductance:         { group: 'patient', read: s => s.patient.flowConductance },
        peepStenting:            { group: 'patient', read: s => s.patient.peepStenting },
        expRatio:                { group: 'patient', read: s => s.patient.expRatio },
        variability:             { group: 'patient', read: s => s.patientDrive.variability },
        cardiacArtifact:         { group: 'patient', read: s => s.patientDrive.cardiacArtifact },
        stressIndex:             { group: 'patient', read: s => s.patient.stressIndex },
        stressIndexEnabled:      { group: 'patient', read: s => s.patient.stressIndexEnabled },
        uip:                     { group: 'patient', read: s => s.patient.uipThreshold },
        uipEnabled:              { group: 'patient', read: s => s.patient.uipEnabled },
        airwayOpening:           { group: 'patient', read: s => s.patient.airwayOpeningPressure },
        recruitedVolume:         { group: 'patient', read: s => s.patient.recruitedVolume },
        entrainmentRatio:        { group: 'patient', read: s => s.patientDrive.entrainmentRatio },
        entrainmentEnabled:      { group: 'patient', read: s => s.patientDrive.entrainmentEnabled },

        // --------------------------------------------------------------- ALARMER
        apneaDelay:     { group: 'alarms', read: s => s.settings.apneaDelay },
        alarmLeak:      { group: 'alarms', read: s => (s.settings.alarmLeakUnit === 'percent' ? s.settings.alarmLeakPercentLimit : s.settings.alarmLeakLimit) },
        alarmLowVt:     { group: 'alarms', read: s => s.settings.alarmLowVtLimit },
        alarmHighVt:    { group: 'alarms', read: s => s.settings.alarmHighVtLimit },
        alarmLowRr:     { group: 'alarms', read: s => s.settings.alarmLowRrLimit },
        alarmHighRr:    { group: 'alarms', read: s => s.settings.alarmHighRrLimit },
        alarmHighPpeak: { group: 'alarms', read: s => s.settings.alarmHighPpeak }
    };

    // Gjeldende verdi for hver parameter, i UI-enhet. Fylles fra simulatorens egne
    // standardverdier ved oppstart, overstyres av scenariet, og endres deretter bare
    // av kontrollene deltakeren faktisk har fått.
    const paramState = {};

    // Verdiene scenariet startet med — brukes av Nullstill-knappen.
    let initialParamState = {};

    function num(key, fallback) {
        const v = parseFloat(paramState[key]);
        return Number.isFinite(v) ? v : fallback;
    }
    function bool(key) { return !!paramState[key]; }

    /**
     * Skriver hele paramState inn i simulatoren. Rekkefølgen er ikke tilfeldig:
     * triggertype må stå før triggerfølsomheten tolkes, og de avledede feltene
     * settes til slutt.
     */
    function commit() {
        const S = simulator.settings;
        const P = simulator.patient;
        const D = simulator.patientDrive;

        // ---- Maskin
        S.mode = paramState.mode;
        S.ipap = num('ipap', S.ipap);
        S.epap = num('epap', S.epap);
        S.tiSet = num('tiSet', S.tiSet);
        S.backupRate = num('backupRate', S.backupRate);
        S.stActive = bool('stActive');
        S.rr = num('rr', S.rr);
        S.fio2 = num('fio2', S.fio2);
        S.riseTime = num('riseTime', 150) / 1000;      // ms i UI, sekunder i motoren
        S.cyclingPercent = num('cycling', 25) / 100;   // % i UI, brøk i motoren
        S.tiMax = num('tiMax', S.tiMax);
        S.leak = num('leak', 0);
        S.vcTidalVolume = num('vcTidalVolume', S.vcTidalVolume);
        S.vcPeakFlow = num('vcPeakFlow', S.vcPeakFlow);
        S.vcFlowPattern = paramState.vcFlowPattern;
        S.inspPause = num('inspPause', 0);

        // Triggerfølsomheten er én slider som betyr L/min eller cmH₂O ut fra triggertypen.
        S.triggerMode = paramState.triggerMode;
        const triggerVal = num('trigger', 1.5);
        if (S.triggerMode === 'pressure') S.triggerPressure = triggerVal;
        else S.triggerFlow = triggerVal;

        // ---- Alarmer
        S.apneaDelay = num('apneaDelay', S.apneaDelay);
        if (S.alarmLeakUnit === 'percent') S.alarmLeakPercentLimit = num('alarmLeak', S.alarmLeakPercentLimit);
        else S.alarmLeakLimit = num('alarmLeak', S.alarmLeakLimit);
        S.alarmLowVtLimit = num('alarmLowVt', S.alarmLowVtLimit);
        S.alarmHighVtLimit = num('alarmHighVt', S.alarmHighVtLimit);
        S.alarmLowRrLimit = num('alarmLowRr', S.alarmLowRrLimit);
        S.alarmHighRrLimit = num('alarmHighRr', S.alarmHighRrLimit);
        S.alarmHighPpeak = num('alarmHighPpeak', S.alarmHighPpeak);
        S.alarmHighPpeakDelta = S.alarmHighPpeak - S.ipap;

        // ---- Pasientens lungemekanikk
        P.height = num('height', P.height);
        P.gender = paramState.gender;
        P.compliance = num('compliance', P.compliance);
        P.resistance = num('resistance', P.resistance);
        P.expRatio = num('expRatio', P.expRatio);
        P.recoilStrength = num('recoil', P.recoilStrength);
        P.flowLimitation = num('flowLimitation', P.flowLimitation);
        P.criticalClosingPressure = num('criticalClosingPressure', P.criticalClosingPressure);
        P.flowConductance = num('flowConductance', P.flowConductance);
        P.peepStenting = num('peepStenting', P.peepStenting);
        P.stressIndexEnabled = bool('stressIndexEnabled');
        P.stressIndex = num('stressIndex', P.stressIndex);
        P.uipEnabled = bool('uipEnabled');
        P.uipThreshold = num('uip', P.uipThreshold);

        // Rekruttert volum har bare mening sammen med et åpningstrykk: uten en terskel
        // finnes det ingen kollaps å åpne opp.
        const airwayOpening = num('airwayOpening', 0);
        P.airwayOpeningPressure = airwayOpening;
        P.recruitedVolume = (airwayOpening > 0) ? num('recruitedVolume', 0) : 0;

        // ---- Pasientens respirasjonssenter
        const rrSpont = num('rrSpont', D.rrSpont);
        D.rrSpont = rrSpont;
        D.pmusMax = num('pmus', D.pmusMax);
        D.pmusExp = num('pmusExp', D.pmusExp);
        D.pmusOffset = num('pmusOffset', 0);
        D.variability = num('variability', D.variability);
        D.cardiacArtifact = num('cardiacArtifact', D.cardiacArtifact);
        D.responsive = (rrSpont > 0) && bool('responsivePmus');
        D.responsiveness = num('responsiveness', D.responsiveness);
        D.tiNeural = num('tiNeural', D.tiNeural);

        // Er innsatsformen koblet til Ti_neural, utleder motoren fasene selv (null).
        const koble = bool('kobleTiNeural');
        D.kobleTiNeural = koble;
        D.triseNeural = koble ? null : num('triseNeural', 0.30);
        D.tholdNeural = koble ? null : num('tholdNeural', 0.00);
        D.tdecayNeural = koble ? null : num('tdecayNeural', 0.40);

        D.entrainmentEnabled = bool('entrainmentEnabled');
        D.entrainmentRatio = num('entrainmentRatio', D.entrainmentRatio);

        updateModeBadge();
    }

    // =========================================================================
    // 3. DOM-REFERANSER
    // =========================================================================
    const metaContainer = document.getElementById('scenario-metadata');
    const controlsContainer = document.getElementById('dynamic-controls');
    const loaderSection = document.getElementById('scenarioLoader');
    const loaderHint = document.getElementById('loaderHint');
    const scenarioFileInput = document.getElementById('scenarioFileInput');

    const headerTitle = document.getElementById('headerTitle');
    const headerSubtitle = document.getElementById('headerSubtitle');
    const modeBadge = document.getElementById('modeBadge');
    const toast = document.getElementById('toastNotification');

    const btnShowFasit = document.getElementById('btnShowFasit');
    const btnPause = document.getElementById('btnPause');
    const pauseIcon = document.getElementById('pauseIcon');
    const pauseText = document.getElementById('pauseText');
    const btnReset = document.getElementById('btnReset');

    const fasitOverlay = document.getElementById('fasitOverlay');
    const fasitBody = document.getElementById('fasitBody');
    const btnCloseFasit = document.getElementById('btnCloseFasit');

    const alarmBanner = document.getElementById('alarmBanner');
    const alarmList = document.getElementById('alarmList');
    const checkShowTrueCurves = document.getElementById('checkShowTrueCurves');
    const checkShowPes = document.getElementById('checkShowPes');
    const btnInspHold = document.getElementById('btnInspHold');
    const btnExpHold = document.getElementById('btnExpHold');
    const holdStatusIndicator = document.getElementById('holdStatusIndicator');

    const valPpeak = document.getElementById('valPpeak');
    const valVt = document.getElementById('valVt');
    const valMv = document.getElementById('valMv');
    const valRR = document.getElementById('valRR');
    const cardMetricPpeak = document.getElementById('cardMetricPpeak');
    const cardMetricVt = document.getElementById('cardMetricVt');
    const cardMetricMv = document.getElementById('cardMetricMv');
    const cardMetricRR = document.getElementById('cardMetricRR');
    const titleSecPeep = document.getElementById('titleSecPeep');
    const dispPeepPeepi = document.getElementById('dispPeepPeepi');
    const dispPeepTot = document.getElementById('dispPeepTot');
    const titleSecPplat = document.getElementById('titleSecPplat');
    const dispPplatSec = document.getElementById('dispPplatSec');
    const dispPplatFoot = document.getElementById('dispPplatFoot');
    const dispP01Sec = document.getElementById('dispP01Sec');
    const dispP01Foot = document.getElementById('dispP01Foot');
    const dispLeakSec = document.getElementById('dispLeakSec');
    const dispLeakStatus = document.getElementById('dispLeakStatus');

    const MODE_LABELS = { PS: 'BPAP', PC: 'PC', VC: 'VC' };

    function escapeHtml(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    let toastTimer = null;
    function showToast(html) {
        if (!toast) return;
        toast.innerHTML = html;
        toast.classList.remove('hidden');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => toast.classList.add('hidden'), 3000);
    }

    function updateModeBadge() {
        if (modeBadge) modeBadge.innerHTML = `<span>Modus: ${MODE_LABELS[simulator.settings.mode] || simulator.settings.mode}</span>`;
    }

    // =========================================================================
    // 4. LASTING AV SCENARIO
    // =========================================================================
    let currentScenario = null;

    /**
     * Fyller spilleren med et scenario: starttilstand, metadata og kontroller.
     * @param {object} scenarioData — innholdet i en eksportert scenario.json
     */
    function loadScenario(scenarioData) {
        if (!scenarioData || typeof scenarioData !== 'object') {
            throw new Error('Scenariofilen er tom eller ikke gyldig JSON.');
        }
        currentScenario = scenarioData;

        const initialState = scenarioData.initialState || {};
        const uiConfig = scenarioData.uiConfig || {};
        const meta = scenarioData.meta || {};

        // ---- 4a. Starttilstand -------------------------------------------------
        // Alle parametere leses først ut av simulatorens egne standardverdier, slik at
        // en scenariofil som utelater et felt gir et definert utgangspunkt. Deretter
        // overstyrer scenariets machine/patient/alarms de feltene de faktisk oppgir.
        Object.keys(PARAMS).forEach(key => {
            paramState[key] = PARAMS[key].read(simulator);
        });

        Object.keys(PARAMS).forEach(key => {
            const group = initialState[PARAMS[key].group];
            if (group && Object.prototype.hasOwnProperty.call(group, key)) {
                paramState[key] = group[key];
            }
        });

        commit();
        initialParamState = Object.assign({}, paramState);

        // ---- 4b. Metadata ------------------------------------------------------
        renderMetadata(meta);

        // ---- 4c. Dynamisk grensesnitt -----------------------------------------
        renderControls(uiConfig);

        // ---- 4d. Start simuleringen på nytt med den nye tilstanden -------------
        simulator.reset();
        renderer.initCanvas();

        if (loaderSection) loaderSection.classList.add('hidden');
        if (btnShowFasit) btnShowFasit.disabled = false;
    }

    function renderMetadata(meta) {
        const title = meta.title || 'Scenario uten tittel';
        const objectives = Array.isArray(meta.learningObjectives)
            ? meta.learningObjectives.filter(o => String(o).trim() !== '')
            : [];

        if (headerTitle) headerTitle.textContent = title;
        if (headerSubtitle) headerSubtitle.textContent = meta.author ? `Scenario av ${meta.author}` : 'Respirator scenario-simulering';
        document.title = title + ' — Respirator Scenario-spiller';

        const parts = [];
        parts.push('<div class="control-card scenario-card">');
        parts.push('  <div class="control-header"><div>');
        parts.push(`    <div class="control-label scenario-title">${escapeHtml(title)}</div>`);
        if (meta.description) {
            parts.push(`    <div class="control-sublabel scenario-description">${escapeHtml(meta.description)}</div>`);
        }
        parts.push('  </div>');
        parts.push('  <span class="readout-type-badge badge-set">SCENARIO</span>');
        parts.push('  </div>');

        if (objectives.length) {
            parts.push('  <div class="scenario-objectives">');
            parts.push('    <div class="scenario-objectives-title">🎯 Læringsmål</div>');
            parts.push('    <ul>');
            objectives.forEach(o => parts.push(`      <li>${escapeHtml(o)}</li>`));
            parts.push('    </ul>');
            parts.push('  </div>');
        }
        parts.push('</div>');

        metaContainer.innerHTML = parts.join('\n');
    }

    // =========================================================================
    // 5. AUTOGENERERT GRENSESNITT
    // =========================================================================
    const GROUP_LABELS = {
        machine: 'Respiratorinnstillinger',
        patient: 'Pasientfysiologi',
        alarms: 'Alarmgrenser'
    };

    /**
     * Bygger én kontroll per ID i uiConfig.visibleControls. Definisjonen (label,
     * type, enhet, min/max/step, default, options) slås opp i uiConfig.controls.
     * Parametere som ikke står i listen får ingen kontroll og forblir låst på
     * verdien de fikk fra initialState.
     */
    function renderControls(uiConfig) {
        controlsContainer.innerHTML = '';

        const defs = Array.isArray(uiConfig.controls) ? uiConfig.controls : [];
        const byKey = {};
        defs.forEach(d => { if (d && d.key) byKey[d.key] = d; });

        const visibleKeys = Array.isArray(uiConfig.visibleControls) ? uiConfig.visibleControls : [];

        // Behold forfatterens rekkefølge, men grupper etter maskin / pasient / alarm.
        const buckets = { machine: [], patient: [], alarms: [] };
        visibleKeys.forEach(key => {
            const def = byKey[key];
            if (!def) return;                 // Ukjent ID i visibleControls — hopp over.
            if (!PARAMS[key]) return;         // Parameteren finnes ikke i denne motoren.
            const group = def.group || PARAMS[key].group;
            (buckets[group] || buckets.patient).push(def);
        });

        const header = document.createElement('div');
        header.className = 'readout-section-header controls-heading';
        header.innerHTML = '<span class="readout-group-title">Justerbare parametere</span>'
            + '<span class="readout-type-badge badge-set">INNSTILT</span>';
        controlsContainer.appendChild(header);

        let total = 0;
        ['machine', 'patient', 'alarms'].forEach(group => {
            const list = buckets[group];
            if (!list.length) return;
            total += list.length;

            const section = document.createElement('div');
            section.className = 'control-group';

            const label = document.createElement('div');
            label.className = 'control-group-title';
            label.textContent = GROUP_LABELS[group];
            section.appendChild(label);

            const grid = document.createElement('div');
            grid.className = 'control-grid';
            list.forEach(def => grid.appendChild(buildControl(def)));
            section.appendChild(grid);

            controlsContainer.appendChild(section);
        });

        if (total === 0) {
            const empty = document.createElement('div');
            empty.className = 'control-card';
            empty.innerHTML = '<div class="control-sublabel">Dette scenariet har ingen justerbare parametere. '
                + 'Observer kurvene og måleverdiene slik de er satt opp.</div>';
            controlsContainer.appendChild(empty);
        }
    }

    /** Bygger ett kort med riktig kontrolltype og kobler det til simulatoren. */
    function buildControl(def) {
        const key = def.key;
        const card = document.createElement('div');
        card.className = 'control-card';
        card.dataset.key = key;

        // --- Topplinje: etikett + verdivisning
        const head = document.createElement('div');
        head.className = 'control-header';

        const labelBox = document.createElement('div');
        const label = document.createElement('div');
        label.className = 'control-label';
        label.textContent = def.label || key;
        labelBox.appendChild(label);
        head.appendChild(labelBox);

        const pill = document.createElement('span');
        pill.className = 'control-value-pill';
        head.appendChild(pill);
        card.appendChild(head);

        // --- Valgfri av/på-boks som hører til samme parameter (f.eks. «UIP aktiv»)
        let enableBox = null;
        if (def.enabledKey && PARAMS[def.enabledKey]) {
            const wrap = document.createElement('label');
            wrap.className = 'control-enable-row';
            enableBox = document.createElement('input');
            enableBox.type = 'checkbox';
            enableBox.checked = !!paramState[def.enabledKey];
            const txt = document.createElement('span');
            txt.textContent = def.enabledLabel || 'Aktiv';
            wrap.appendChild(enableBox);
            wrap.appendChild(txt);
            card.appendChild(wrap);
        }

        const unit = def.unit ? ' ' + def.unit : '';
        let setPill = () => { pill.textContent = ''; };
        let syncDisabled = () => {};

        if (def.type === 'range') {
            const min = Number(def.min != null ? def.min : 0);
            const max = Number(def.max != null ? def.max : 100);
            const step = Number(def.step != null ? def.step : 1);
            const decimals = decimalsFor(step);

            const wrapper = document.createElement('div');
            wrapper.className = 'slider-wrapper';

            const minus = document.createElement('button');
            minus.type = 'button';
            minus.className = 'step-btn';
            minus.textContent = '-';

            const input = document.createElement('input');
            input.type = 'range';
            input.min = String(min);
            input.max = String(max);
            input.step = String(step);
            input.value = String(clamp(toNumber(paramState[key], def.default), min, max));

            const plus = document.createElement('button');
            plus.type = 'button';
            plus.className = 'step-btn';
            plus.textContent = '+';

            wrapper.appendChild(minus);
            wrapper.appendChild(input);
            wrapper.appendChild(plus);
            card.appendChild(wrapper);

            const limits = document.createElement('div');
            limits.className = 'slider-limits';
            limits.innerHTML = `<span>${min}${escapeHtml(unit)}</span><span>${max}${escapeHtml(unit)}</span>`;
            card.appendChild(limits);

            setPill = () => { pill.textContent = Number(input.value).toFixed(decimals) + unit; };

            const apply = () => {
                paramState[key] = parseFloat(input.value);
                setPill();
                commit();
            };
            input.addEventListener('input', apply);

            const nudge = dir => {
                const next = clamp(parseFloat(input.value) + dir * step, min, max);
                input.value = String(parseFloat(next.toFixed(decimals)));
                apply();
            };
            minus.addEventListener('click', () => nudge(-1));
            plus.addEventListener('click', () => nudge(1));

            syncDisabled = on => {
                input.disabled = !on;
                minus.disabled = !on;
                plus.disabled = !on;
                card.classList.toggle('control-disabled', !on);
            };
            card.__setValue = v => { input.value = String(clamp(toNumber(v, min), min, max)); setPill(); };

        } else if (def.type === 'checkbox') {
            const wrap = document.createElement('label');
            wrap.className = 'control-toggle-row';
            const input = document.createElement('input');
            input.type = 'checkbox';
            input.checked = !!paramState[key];
            const txt = document.createElement('span');
            txt.textContent = def.label || key;
            wrap.appendChild(input);
            wrap.appendChild(txt);
            card.appendChild(wrap);

            setPill = () => { pill.textContent = input.checked ? 'PÅ' : 'AV'; };
            input.addEventListener('change', () => {
                paramState[key] = input.checked;
                setPill();
                commit();
            });
            card.__setValue = v => { input.checked = !!v; setPill(); };

        } else if (def.type === 'buttons' || def.type === 'select') {
            const options = Array.isArray(def.options) ? def.options : [];

            if (def.type === 'select') {
                const select = document.createElement('select');
                select.className = 'control-select';
                options.forEach(o => {
                    const opt = document.createElement('option');
                    opt.value = String(o.value);
                    opt.textContent = o.label;
                    select.appendChild(opt);
                });
                select.value = String(paramState[key]);
                card.appendChild(select);

                setPill = () => {
                    const hit = options.find(o => String(o.value) === String(paramState[key]));
                    pill.textContent = hit ? hit.label : String(paramState[key]);
                };
                select.addEventListener('change', () => {
                    paramState[key] = coerceLike(select.value, options);
                    setPill();
                    commit();
                });
                card.__setValue = v => { select.value = String(v); setPill(); };

            } else {
                const group = document.createElement('div');
                group.className = 'btn-group-pill control-buttons';
                const buttons = [];

                options.forEach(o => {
                    const btn = document.createElement('button');
                    btn.type = 'button';
                    btn.className = 'btn-pill';
                    btn.textContent = o.label;
                    btn.dataset.value = String(o.value);
                    btn.addEventListener('click', () => {
                        paramState[key] = o.value;
                        buttons.forEach(b => b.classList.toggle('active', b === btn));
                        setPill();
                        commit();
                    });
                    buttons.push(btn);
                    group.appendChild(btn);
                });
                card.appendChild(group);

                const mark = () => buttons.forEach(b => b.classList.toggle('active', b.dataset.value === String(paramState[key])));
                mark();

                setPill = () => {
                    const hit = options.find(o => String(o.value) === String(paramState[key]));
                    pill.textContent = hit ? hit.label : String(paramState[key]);
                };
                syncDisabled = on => {
                    buttons.forEach(b => { b.disabled = !on; });
                    card.classList.toggle('control-disabled', !on);
                };
                card.__setValue = v => { paramState[key] = v; mark(); setPill(); };
            }

        } else {
            // Ukjent type: vis verdien skrivebeskyttet i stedet for å feile stille.
            setPill = () => { pill.textContent = String(paramState[key]) + unit; };
            const note = document.createElement('div');
            note.className = 'control-sublabel';
            note.textContent = `Kontrolltypen «${def.type}» støttes ikke — verdien er låst.`;
            card.appendChild(note);
        }

        setPill();

        // Av/på-boksen styrer både flagget i simulatoren og om selve kontrollen er aktiv.
        if (enableBox) {
            const applyEnable = () => {
                paramState[def.enabledKey] = enableBox.checked;
                syncDisabled(enableBox.checked);
                commit();
            };
            enableBox.addEventListener('change', applyEnable);
            syncDisabled(enableBox.checked);
            card.__setEnabled = v => { enableBox.checked = !!v; syncDisabled(enableBox.checked); };
        }

        return card;
    }

    function toNumber(v, fallback) {
        const n = parseFloat(v);
        return Number.isFinite(n) ? n : fallback;
    }
    function clamp(v, min, max) { return Math.min(max, Math.max(min, v)); }
    function decimalsFor(step) {
        const s = String(step);
        const i = s.indexOf('.');
        return i === -1 ? 0 : (s.length - i - 1);
    }
    function coerceLike(raw, options) {
        const hit = options.find(o => String(o.value) === String(raw));
        return hit ? hit.value : raw;
    }

    /** Setter alle kontroller tilbake til scenariets startverdier. */
    function resetToScenario() {
        Object.keys(initialParamState).forEach(k => { paramState[k] = initialParamState[k]; });
        controlsContainer.querySelectorAll('.control-card[data-key]').forEach(card => {
            const key = card.dataset.key;
            if (card.__setEnabled) {
                const def = findDef(key);
                if (def && def.enabledKey) card.__setEnabled(paramState[def.enabledKey]);
            }
            if (card.__setValue) card.__setValue(paramState[key]);
        });
        commit();
        simulator.reset();
        renderer.initCanvas();
    }

    function findDef(key) {
        const defs = (currentScenario && currentScenario.uiConfig && currentScenario.uiConfig.controls) || [];
        return defs.find(d => d.key === key) || null;
    }

    // =========================================================================
    // 6. FASIT
    // =========================================================================
    function showFasit() {
        const key = (currentScenario && currentScenario.meta && currentScenario.meta.answerKey) || {};
        const rows = [
            ['🎯 Optimale innstillinger', key.optimalSettings],
            ['📈 Forventet respons', key.expectedResponse],
            ['📝 Notater', key.notes]
        ].filter(r => String(r[1] || '').trim() !== '');

        if (!rows.length) {
            fasitBody.innerHTML = '<p class="fasit-empty">Forfatteren har ikke lagt inn fasit for dette scenariet.</p>';
        } else {
            fasitBody.innerHTML = rows.map(([title, text]) =>
                `<section class="fasit-section"><h3>${title}</h3><p>${escapeHtml(text).replace(/\n/g, '<br>')}</p></section>`
            ).join('');
        }
        fasitOverlay.classList.remove('hidden');
    }

    function hideFasit() { fasitOverlay.classList.add('hidden'); }

    btnShowFasit.addEventListener('click', showFasit);
    btnCloseFasit.addEventListener('click', hideFasit);
    fasitOverlay.addEventListener('click', e => { if (e.target === fasitOverlay) hideFasit(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') hideFasit(); });

    // =========================================================================
    // 7. MONITOR: MÅLEVERDIER OG ALARMER
    // =========================================================================
    let readoutTimer = 0;

    function updateReadouts(dt) {
        readoutTimer += dt;
        if (readoutTimer < 0.25) return;
        readoutTimer = 0;

        const m = simulator.state.measured;
        const activeAlarms = simulator.state.activeAlarms || [];

        if (alarmBanner && alarmList) {
            if (activeAlarms.length > 0) {
                alarmBanner.classList.remove('hidden');
                alarmList.innerHTML = activeAlarms.map(a => `
                    <div class="alarm-item alarm-type-${a.type}">
                        <span class="alarm-icon">${a.type === 'danger' ? '🚨' : '⚠️'}</span>
                        <div class="alarm-text-block">
                            <span class="alarm-title">${a.title}</span>
                            <span class="alarm-msg">${a.msg}</span>
                        </div>
                    </div>
                `).join('');
            } else {
                alarmBanner.classList.add('hidden');
                alarmList.innerHTML = '';
            }
        }

        if (valPpeak) valPpeak.textContent = m.ppeak.toFixed(1);
        if (valVt) valVt.textContent = m.vt;
        if (valMv) valMv.textContent = m.mv.toFixed(1);
        if (valRR) valRR.textContent = m.rrTotal;

        const has = id => activeAlarms.some(a => a.id === id);
        const hasApnea = has('apnea');
        if (cardMetricPpeak) cardMetricPpeak.classList.toggle('metric-alarm-active', has('high_pressure'));
        if (cardMetricVt) cardMetricVt.classList.toggle('metric-alarm-active', has('low_vt') || has('high_vt'));
        if (cardMetricMv) cardMetricMv.classList.toggle('metric-alarm-active', hasApnea);
        if (cardMetricRR) cardMetricRR.classList.toggle('metric-alarm-active', hasApnea || has('high_rr') || has('low_rr'));

        const isExpHold = simulator.isExpiratoryHoldActive();
        const isInspHold = simulator.isInspiratoryHoldActive();

        if (isExpHold) {
            if (titleSecPeep) titleSecPeep.innerHTML = '<span style="color: var(--color-warning);">PEEP<sub>total</sub></span>';
            if (dispPeepPeepi) dispPeepPeepi.innerHTML = `<span style="color: var(--color-warning);">${simulator.getHoldPeepTotal().toFixed(1)}</span>`;
            if (dispPeepTot) dispPeepTot.innerHTML = `Hold aktiv: <strong>${simulator.getHoldPeepTotal().toFixed(1)}</strong> cmH₂O`;
        } else {
            if (titleSecPeep) titleSecPeep.innerHTML = 'PEEP / PEEP<sub>i</sub>';
            if (dispPeepPeepi) dispPeepPeepi.textContent = `${simulator.settings.epap.toFixed(1)} / ${m.peepi.toFixed(1)}`;
            if (dispPeepTot) {
                if (m.holdPeepTotal !== null && m.holdPeepTotal !== undefined) {
                    dispPeepTot.innerHTML = `Avdekket PEEP<sub>tot</sub>: <strong>${simulator.getHoldPeepTotal().toFixed(1)}</strong> cmH₂O`;
                } else {
                    dispPeepTot.innerHTML = `PEEP<sub>tot</sub>: ${(simulator.settings.epap + m.peepi).toFixed(1)} cmH₂O`;
                }
            }
        }

        if (isInspHold) {
            if (titleSecPplat) titleSecPplat.innerHTML = '<span style="color: #38bdf8;">P<sub>plat</sub> (Hold)</span>';
            if (dispPplatSec) dispPplatSec.innerHTML = `<span style="color: #38bdf8;">${simulator.getHoldPplat().toFixed(1)}</span>`;
            if (dispPplatFoot) dispPplatFoot.innerHTML = `Hold aktiv: <strong>${simulator.getHoldPplat().toFixed(1)}</strong> cmH₂O`;
        } else if (m.holdPplat !== null && m.holdPplat !== undefined) {
            if (titleSecPplat) titleSecPplat.innerHTML = 'P<sub>plat</sub> (Hold)';
            if (dispPplatSec) dispPplatSec.textContent = simulator.getHoldPplat().toFixed(1);
            if (dispPplatFoot) dispPplatFoot.innerHTML = 'Avdekket ved holdmanøver';
        } else {
            if (titleSecPplat) titleSecPplat.innerHTML = 'P<sub>plat</sub> (Platå)';
            if (dispPplatSec) dispPplatSec.textContent = '--';
            if (dispPplatFoot) dispPplatFoot.textContent = 'Bruk insp. hold';
        }

        const p01 = simulator.getP01();
        if (dispP01Sec) {
            if (simulator.patientDrive.rrSpont > 0) {
                dispP01Sec.textContent = p01.toFixed(1);
                if (dispP01Foot) {
                    dispP01Foot.textContent = p01 < 1.0 ? 'Lav drive (< 1,0)'
                        : (p01 <= 3.5 ? 'Normal drive (1,0–3,5)' : 'Høy drive (> 3,5)');
                }
            } else {
                dispP01Sec.textContent = '--';
                if (dispP01Foot) dispP01Foot.textContent = 'Passiv pasient';
            }
        }

        if (dispLeakSec) dispLeakSec.innerHTML = `${m.leak.toFixed(1)} <span class="sub-val-secondary">(${m.leakPercent.toFixed(0)}%)</span>`;
        if (dispLeakStatus) {
            dispLeakStatus.textContent = (m.leak > 40 || m.leakPercent > 40) ? '⚠️ Høy lekkasje'
                : ((m.leak > 15 || m.leakPercent > 20) ? 'Moderat lekkasje' : 'Tett krets');
        }
    }

    // =========================================================================
    // 8. MONITOR-VALG OG HOLDMANØVRER
    // =========================================================================
    if (checkShowTrueCurves) {
        checkShowTrueCurves.addEventListener('change', () => {
            renderer.showTrueCurves = checkShowTrueCurves.checked;
        });
    }
    if (checkShowPes) {
        checkShowPes.addEventListener('change', () => {
            renderer.showPesTrack = checkShowPes.checked;
            renderer.resize();   // sporlayouten må regnes om
        });
    }

    function attachHoldButton(btn, start, stop, name) {
        if (!btn) return;
        let holding = false;
        const begin = e => {
            e.preventDefault();
            if (holding) return;
            holding = true;
            btn.classList.add('active');
            start();
            if (holdStatusIndicator) {
                holdStatusIndicator.textContent = `🛑 ${name} aktiv … låser luftveien (maks 5 s)`;
                holdStatusIndicator.style.color = 'var(--color-accent)';
            }
        };
        const end = () => {
            if (!holding) return;
            holding = false;
            btn.classList.remove('active');
            stop();
            if (holdStatusIndicator) {
                holdStatusIndicator.textContent = `Avsluttet ${name}. Måling oppdatert i panelet.`;
                holdStatusIndicator.style.color = '';
                setTimeout(() => {
                    if (!holding && holdStatusIndicator) {
                        holdStatusIndicator.textContent = 'Hold nede knappen for å låse luftveien (maks 5 s)';
                    }
                }, 2500);
            }
        };
        btn.addEventListener('mousedown', begin);
        btn.addEventListener('touchstart', begin, { passive: false });
        btn.addEventListener('mouseup', end);
        btn.addEventListener('mouseleave', end);
        btn.addEventListener('touchend', end);
        btn.addEventListener('touchcancel', end);
    }

    attachHoldButton(btnInspHold, () => simulator.startInspiratoryHold(), () => simulator.stopInspiratoryHold(), 'Inspiratorisk hold');
    attachHoldButton(btnExpHold, () => simulator.startExpiratoryHold(), () => simulator.stopExpiratoryHold(), 'Ekspiratorisk hold');

    // Pause / frys
    let isPaused = false;
    btnPause.addEventListener('click', () => {
        isPaused = !isPaused;
        simulator.isRunning = !isPaused;
        renderer.setFrozen(isPaused);
        pauseIcon.textContent = isPaused ? '▶' : '⏸';
        pauseText.textContent = isPaused ? 'Fortsett' : 'Pause / Frys';
        btnPause.classList.toggle('active', isPaused);
    });

    // Nullstill til scenariets startverdier
    btnReset.addEventListener('click', () => {
        if (!currentScenario) return;
        resetToScenario();
        if (isPaused) {
            isPaused = false;
            simulator.isRunning = true;
            renderer.setFrozen(false);
            pauseIcon.textContent = '⏸';
            pauseText.textContent = 'Pause / Frys';
            btnPause.classList.remove('active');
        }
        showToast('↺ Scenariet er satt tilbake til startverdiene.');
    });

    // =========================================================================
    // 9. ANIMASJONSLOOP
    // =========================================================================
    let lastTimestamp = performance.now();

    function loop(currentTimestamp) {
        const elapsedSec = (currentTimestamp - lastTimestamp) / 1000;
        lastTimestamp = currentTimestamp;

        if (!isPaused && elapsedSec > 0) {
            if (elapsedSec > 0.5) {
                // Fanen har vært i bakgrunnen — simuler videre uten å tegne tidssprang
                simulator.step(elapsedSec);
            } else {
                simulator.step(elapsedSec);

                const wasTriggered = simulator.state.justTriggered;
                simulator.state.justTriggered = false;

                renderer.addSample(
                    elapsedSec,
                    simulator.frameSample,
                    simulator.state.volume,
                    simulator.state.flow,
                    wasTriggered,
                    simulator.settings.epap,
                    simulator.state.volume_lung,
                    simulator.state.flow_lung,
                    simulator.frameEvents
                );

                updateReadouts(elapsedSec);
            }
        }

        renderer.render();
        requestAnimationFrame(loop);
    }

    window.addEventListener('resize', () => renderer.resize());

    // =========================================================================
    // 10. OPPSTART — finn og last scenariofilen
    // =========================================================================
    function showLoader(message) {
        if (loaderSection) loaderSection.classList.remove('hidden');
        if (loaderHint && message) loaderHint.innerHTML = message;
        if (btnShowFasit) btnShowFasit.disabled = true;
    }

    function tryLoad(data, source) {
        try {
            loadScenario(data);
            showToast(`✅ Scenario lastet fra <strong>${escapeHtml(source)}</strong>.`);
            return true;
        } catch (err) {
            showLoader(`⚠️ Kunne ikke lese scenariet: ${escapeHtml(err.message)}`);
            return false;
        }
    }

    if (scenarioFileInput) {
        scenarioFileInput.addEventListener('change', () => {
            const file = scenarioFileInput.files && scenarioFileInput.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = () => {
                try {
                    tryLoad(JSON.parse(String(reader.result)), file.name);
                } catch (err) {
                    showLoader(`⚠️ Filen er ikke gyldig JSON: ${escapeHtml(err.message)}`);
                }
            };
            reader.readAsText(file);
        });
    }

    function bootstrap() {
        // 1. Scenariet kan være bakt inn i siden (virker også med file://-protokollen).
        if (window.SCENARIO_DATA) {
            if (tryLoad(window.SCENARIO_DATA, 'scenario-data.js')) return;
        }

        // 2. Ellers hentes filen som er oppgitt i ?scenario=… , med scenario.json som standard.
        const params = new URLSearchParams(window.location.search);
        const url = params.get('scenario') || 'scenario.json';

        fetch(url)
            .then(res => {
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                return res.json();
            })
            .then(data => tryLoad(data, url))
            .catch(() => {
                // 3. Siste utvei: la deltakeren velge filen selv. Dette er normalt når
                //    siden åpnes rett fra disk, siden nettleseren da blokkerer fetch().
                showLoader('Fant ikke <code>' + escapeHtml(url) + '</code> automatisk. '
                    + 'Velg den eksporterte <code>.json</code>-filen, eller kjør siden fra en webserver.');
            });
    }

    // Tegn tomme kurver umiddelbart, og last så scenariet.
    renderer.initCanvas();
    updateModeBadge();
    bootstrap();
    requestAnimationFrame(loop);
});
