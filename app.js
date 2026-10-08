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
    const btnShowPes = document.getElementById('btnShowPes');
    const btnShowPesText = document.getElementById('btnShowPesText');

    const valPpeak = document.getElementById('valPpeak');
    const valVt = document.getElementById('valVt');
    const valMv = document.getElementById('valMv');
    const valRR = document.getElementById('valRR');
    const cardMetricPpeak = document.getElementById('cardMetricPpeak');
    const cardMetricVt = document.getElementById('cardMetricVt');
    const cardMetricMv = document.getElementById('cardMetricMv');
    const cardMetricRR = document.getElementById('cardMetricRR');

    const syncCard = document.getElementById('syncCard');
    const syncStatus = document.getElementById('syncStatus');
    const valEfforts = document.getElementById('valEfforts');
    const valTriggered = document.getElementById('valTriggered');
    const valMissed = document.getElementById('valMissed');
    const valAsyncIndex = document.getElementById('valAsyncIndex');

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
        fitCanvasToPanel();

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

        if (metaContainer) metaContainer.innerHTML = parts.join('\n');
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

            const name = def.label || key;

            const minus = document.createElement('button');
            minus.type = 'button';
            minus.className = 'step-btn';
            minus.textContent = '−';
            minus.setAttribute('aria-label', `Senk ${name}`);

            const input = document.createElement('input');
            input.type = 'range';
            input.min = String(min);
            input.max = String(max);
            input.step = String(step);
            input.value = String(clamp(toNumber(paramState[key], def.default), min, max));
            input.setAttribute('aria-label', name);

            const plus = document.createElement('button');
            plus.type = 'button';
            plus.className = 'step-btn';
            plus.textContent = '+';
            plus.setAttribute('aria-label', `Øk ${name}`);

            wrapper.appendChild(minus);
            wrapper.appendChild(input);
            wrapper.appendChild(plus);
            card.appendChild(wrapper);

            const limits = document.createElement('div');
            limits.className = 'slider-limits';
            limits.innerHTML = `<span>${min}${escapeHtml(unit)}</span><span>${max}${escapeHtml(unit)}</span>`;
            card.appendChild(limits);

            setPill = () => {
                const text = Number(input.value).toFixed(decimals) + unit;
                pill.textContent = text;
                input.setAttribute('aria-valuetext', text);   // skjermleser leser verdien med enhet
            };

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
            // Avkrysningsboksen bærer selv etiketten: ingen egen tittel eller PÅ/AV-merke.
            card.removeChild(head);

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

            input.addEventListener('change', () => {
                paramState[key] = input.checked;
                commit();
            });
            card.__setValue = v => { input.checked = !!v; };

        } else if (def.type === 'buttons' || def.type === 'select') {
            const options = Array.isArray(def.options) ? def.options : [];

            if (def.type === 'select') {
                const select = document.createElement('select');
                select.className = 'control-select';
                select.setAttribute('aria-label', def.label || key);
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
                group.setAttribute('role', 'group');
                group.setAttribute('aria-label', def.label || key);
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

    if (btnShowFasit) btnShowFasit.addEventListener('click', showFasit);
    btnCloseFasit.addEventListener('click', hideFasit);
    fasitOverlay.addEventListener('click', e => { if (e.target === fasitOverlay) hideFasit(); });

    // =========================================================================
    // 6b. INFO-DIALOG
    // =========================================================================
    // Innholdet står i index.html. Dialogen er åpen når siden lastes, og kan
    // åpnes igjen med Info-knappen over kurvene. Den lukkes bare med knappene
    // eller Escape, ikke ved klikk utenfor, så introen ikke forsvinner ved et uhell.
    const infoOverlay = document.getElementById('infoOverlay');
    const infoModal = document.getElementById('infoModal');
    const infoTextView = document.getElementById('infoTextView');
    const infoImageView = document.getElementById('infoImageView');
    const infoLegendView = document.getElementById('infoLegendView');
    const infoImage = document.getElementById('infoImage');
    const infoImageMissing = document.getElementById('infoImageMissing');
    const btnShowInfo = document.getElementById('btnShowInfo');
    const btnShowInfoImage = document.getElementById('btnShowInfoImage');
    const btnInfoBack = document.getElementById('btnInfoBack');
    const btnShowInfoLegend = document.getElementById('btnShowInfoLegend');
    const btnLegendBack = document.getElementById('btnLegendBack');
    const btnCloseInfo = document.getElementById('btnCloseInfo');
    const btnCloseInfoX = document.getElementById('btnCloseInfoX');

    function isInfoOpen() { return !infoOverlay.classList.contains('hidden'); }

    function showInfoText() {
        infoImageView.classList.add('hidden');
        infoLegendView.classList.add('hidden');
        infoTextView.classList.remove('hidden');
        infoModal.classList.remove('info-modal--wide');
    }

    function showInfoImage() {
        infoTextView.classList.add('hidden');
        infoImageView.classList.remove('hidden');
        infoModal.classList.add('info-modal--wide');
        btnInfoBack.focus();
    }

    // Forklaring av kurver, markører og måleverdier (visning 3)
    function showInfoLegend() {
        infoTextView.classList.add('hidden');
        infoLegendView.classList.remove('hidden');
        infoLegendView.scrollTop = 0;
        btnLegendBack.focus();
    }

    function openInfo() {
        showInfoText();
        infoOverlay.classList.remove('hidden');
        btnCloseInfoX.focus();
    }

    function closeInfo() {
        infoOverlay.classList.add('hidden');
        btnShowInfo.focus();
    }

    // Plassholder til bildet er lagt inn i bilder/. Bildet kan ha feilet allerede
    // før denne koden kjører, derfor sjekkes også complete/naturalWidth.
    function showImageMissing() {
        infoImage.classList.add('hidden');
        infoImageMissing.classList.remove('hidden');
    }
    infoImage.addEventListener('error', showImageMissing);
    if (infoImage.complete && infoImage.naturalWidth === 0) showImageMissing();

    btnShowInfo.addEventListener('click', openInfo);
    btnShowInfoImage.addEventListener('click', showInfoImage);
    btnInfoBack.addEventListener('click', () => { showInfoText(); btnShowInfoImage.focus(); });
    btnShowInfoLegend.addEventListener('click', showInfoLegend);
    btnLegendBack.addEventListener('click', () => { showInfoText(); btnShowInfoLegend.focus(); });
    btnCloseInfo.addEventListener('click', closeInfo);
    btnCloseInfoX.addEventListener('click', closeInfo);

    // Hold tastaturfokus inne i dialogen mens den er åpen
    infoOverlay.addEventListener('keydown', e => {
        if (e.key !== 'Tab') return;
        const focusable = Array.from(infoModal.querySelectorAll('button')).filter(b => b.offsetParent !== null);
        if (!focusable.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });

    // Escape: fra bildet eller forklaringen tilbake til teksten, ellers lukk den dialogen som er åpen
    document.addEventListener('keydown', e => {
        if (e.key !== 'Escape') return;
        if (isPcNoticeOpen()) return;
        if (isInfoOpen()) {
            if (!infoImageView.classList.contains('hidden')) { showInfoText(); btnShowInfoImage.focus(); }
            else if (!infoLegendView.classList.contains('hidden')) { showInfoText(); btnShowInfoLegend.focus(); }
            else closeInfo();
        } else if (isSyncPanelOpen()) {
            setSyncPanel(false);
            btnShowSync.focus();
        } else {
            hideFasit();
        }
    });

    if (isInfoOpen()) btnCloseInfoX.focus({ preventScroll: true });

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

        updateSync();
    }

    /**
     * Samspill pasient–respirator over siste 60 s. Utløste pust er simulatorens
     * egen telling av pasientutløste pust (samme vindu som RR); mislykkede
     * pustforsøk telles i innsatsloggen (state.efforts). Pasientens pustforsøk er
     * summen av de to; autotrigger og backup-pust er ikke pasientens forsøk.
     * Før det har gått 60 s skaleres tellingen til per minutt, som RR i simulatoren.
     */
    const SYNC_MIN_SECONDS = 10;      // kortere vindu gir for usikre tall
    const ASYNC_INDEX_LIMIT = 10;     // % — over dette regnes asynkronien som betydelig

    function updateSync() {
        const t = simulator.state.totalTime;
        if (simulator.patientDrive.rrSpont <= 0) {
            setSync('--', '--', '--', '--', null, 'Passiv pasient – ingen pustforsøk');
            return;
        }
        if (t < SYNC_MIN_SECONDS) {
            setSync('--', '--', '--', '--', null, 'Venter på målinger …');
            return;
        }

        const missedCount = simulator.state.efforts.filter(e => e.t >= t - 60 && e.type === 'missed').length;
        const missed = Math.round(missedCount * 60 / Math.min(60, t));
        const triggered = simulator.state.measured.rrSpont || 0;

        const index = simulator.state.measured.asynchronyIndex || 0;
        const ok = index <= ASYNC_INDEX_LIMIT;
        setSync(triggered + missed, triggered, missed, index, ok,
            ok ? 'God synkronisering' : 'Betydelig asynkroni');
    }

    function setSync(efforts, triggered, missed, index, ok, status) {
        valEfforts.textContent = efforts;
        valTriggered.textContent = triggered;
        valMissed.textContent = missed;
        valAsyncIndex.textContent = index;
        syncStatus.textContent = status;
        syncCard.classList.toggle('sync-ok', ok === true);
        syncCard.classList.toggle('sync-bad', ok === false);
    }

    // Samspillpanelet åpnes med knappen over kurvene og lukkes med knappen, krysset
    // eller Escape. Det lukkes ikke ved klikk utenfor, så deltakeren kan endre
    // innstillinger i sidepanelet og se effekten mens panelet er åpent.
    const btnShowSync = document.getElementById('btnShowSync');
    const btnCloseSync = document.getElementById('btnCloseSync');

    function isSyncPanelOpen() { return !syncCard.classList.contains('hidden'); }

    function setSyncPanel(open) {
        syncCard.classList.toggle('hidden', !open);
        btnShowSync.setAttribute('aria-expanded', String(open));
        btnShowSync.classList.toggle('active', open);
    }

    btnShowSync.addEventListener('click', () => setSyncPanel(!isSyncPanelOpen()));
    btnCloseSync.addEventListener('click', () => { setSyncPanel(false); btnShowSync.focus(); });

    // =========================================================================
    // 8. MONITOR-VALG OG HOVEDMENY
    // =========================================================================
    if (checkShowTrueCurves) {
        checkShowTrueCurves.addEventListener('change', () => {
            renderer.showTrueCurves = checkShowTrueCurves.checked;
        });
    }

    // Pes-sporet (muskelinnsats) er skjult ved start; deltakerne slår det på
    // selv med knappen ved behov.
    function setPesTrack(on) {
        renderer.showPesTrack = on;
        btnShowPes.setAttribute('aria-pressed', String(on));
        btnShowPes.classList.toggle('active', on);
        btnShowPesText.innerHTML = on
            ? 'Skjul muskelinnsats (P<sub>es</sub>)'
            : 'Vis muskelinnsats (P<sub>es</sub>)';
        renderer.resize();   // sporlayouten må regnes om
    }
    btnShowPes.addEventListener('click', () => setPesTrack(!renderer.showPesTrack));

    // Dummy: kobles til hovedmenyen når scenariene bygges inn i hovedprogrammet.
    // Hendelsen «scenario:hovedmeny» kan fanges opp av programmet rundt.
    const btnMainMenu = document.getElementById('btnMainMenu');
    function goToMainMenu() {
        window.dispatchEvent(new CustomEvent('scenario:hovedmeny'));
        showToast('Hovedmenyen er ikke koblet til ennå.');
    }
    btnMainMenu.addEventListener('click', goToMainMenu);

    // Varsel om at denne delen av kurset må tas på PC: vises på smale skjermer
    // og på berøringsenheter uten mus. Kan lukkes med «Vis likevel».
    const pcNotice = document.getElementById('pcNotice');
    const btnPcNoticeDismiss = document.getElementById('btnPcNoticeDismiss');
    const notPcQuery = window.matchMedia('(max-width: 760px), (hover: none) and (pointer: coarse)');

    function isPcNoticeOpen() { return !pcNotice.classList.contains('hidden'); }

    if (notPcQuery.matches) {
        pcNotice.classList.remove('hidden');
        btnPcNoticeDismiss.focus({ preventScroll: true });
    }
    btnPcNoticeDismiss.addEventListener('click', () => {
        pcNotice.classList.add('hidden');
        if (isInfoOpen()) btnCloseInfoX.focus({ preventScroll: true });
    });

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

    // Kurveflaten får samme høyde som sidepanelet, så kolonnene slutter likt uansett
    // hvor mange innstillinger scenariet har. Høyden avhenger bare av panelets
    // innhold, ikke av iframen, så Rise kan ikke gi den en voksesløyfe.
    // Når panelet ligger under kurvene (smal blokk), brukes fast høyde.
    const sidePanel = document.querySelector('.side-panel');
    const monitorToolbar = document.querySelector('.monitor-toolbar');
    const canvasContainer = renderer.canvas.parentElement;
    const stackedQuery = window.matchMedia('(max-width: 900px)');
    const CANVAS_MIN_HEIGHT = 560;
    const CANVAS_STACKED_HEIGHT = 600;
    const COLUMN_GAP = 8;             // gap i .monitor-left-col

    function fitCanvasToPanel() {
        const target = stackedQuery.matches
            ? CANVAS_STACKED_HEIGHT
            : Math.max(CANVAS_MIN_HEIGHT, sidePanel.offsetHeight - monitorToolbar.offsetHeight - COLUMN_GAP);
        if (canvasContainer.offsetHeight === target) return;
        canvasContainer.style.height = target + 'px';
        canvasContainer.style.minHeight = target + 'px';
        renderer.resizeCanvas();
    }
    window.addEventListener('resize', fitCanvasToPanel);

    // Følg beholderens bredde, ikke bare vinduet: i en iframe (Rise) kan bredden
    // endre seg uten resize-hendelse. resizeCanvas() gjør ingenting hvis størrelsen er lik.
    if (window.ResizeObserver) {
        new ResizeObserver(() => renderer.resizeCanvas()).observe(renderer.canvas.parentElement);
    }

    // Articulate Rise (kodeblokk): meld blokken fullført, så deltakeren ikke blir
    // stoppet hvis blokken er satt som krav for å gå videre.
    function notifyComplete() {
        try {
            if (window.parent && window.parent !== window) {
                window.parent.postMessage({ type: 'complete' }, '*');
            }
        } catch (e) { /* ikke innebygd */ }
    }

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
    setPesTrack(false);
    updateModeBadge();
    bootstrap();
    notifyComplete();
    requestAnimationFrame(loop);
});
