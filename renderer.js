/**
 * renderer.js - HTML5 Canvas 2D Medisinsk Ventilator Monitor (Hamilton-stil)
 * 
 * STANDARD 3-SPORS MONITOR:
 * - 1. spor: Paw (Luftveistrykk, gul / amber)
 * - 2. spor: Flow (Flow - Q_meas, klinisk grønn)
 * - 3. spor: Volum (Tidalvolum - V_meas, cyan / lys blå)
 * 
 * FUNKSJONER:
 * - C7: Min/Maks-konvolutt per piksel for Paw, Flow og Volum (fanger opp korte hendelser som trykkoversving og terminal-spikes)
 * - C8: Valgbar sveipetid (6 s / 10 s / 15 s), standard 10 s
 * - C9: Faste kliniske skalaer som standard (Paw 0–40, Flow ±120, Vol 0–800), med valgfri Auto-modus og klippeindikator
 * - D3: 4 entydige triggermarkørtyper langs bunnen av Paw-sporet:
 *   ▲ Fylt trekant: Assistert pust (pasientutløst)
 *   △ Åpen trekant: Mislykket innsats (missed effort)
 *   ⨂ Trekant med kryss: Autotrigger (pust uten innsats)
 *   ■ Kvadrat: Maskinutløst backup-pust (mandatory)
 */

class WaveformRenderer {
    constructor(canvasId) {
        this.canvas = document.getElementById(canvasId);
        this.ctx = this.canvas.getContext('2d');
        
        // Fargepalett i tråd med medisinsk standard (Hamilton Medical / Servo-stil)
        this.colors = {
            bg: '#080d1a',
            grid: '#131e33',
            gridSubtle: '#0f1728',
            gridTickLine: 'rgba(255, 255, 255, 0.045)', // Subtil referanselinje for Y-aksetikk
            axisLine: '#2a3b5c',
            sweepBar: '#ffffff',
            
            // Kurvefarger
            pressure: '#fbbf24',       // Gul/Amber (Paw)
            pressureFill: 'rgba(251, 191, 36, 0.08)',
            
            flow: '#22c55e',           // Klinisk Grønn (Flow - Q_meas)
            flowFillPos: 'rgba(34, 197, 94, 0.16)', // Innpust areal (over 0-linje)
            flowFillNeg: 'rgba(34, 197, 94, 0.10)', // Utpust areal (under 0-linje)
            flowLung: 'rgba(134, 239, 172, 0.90)',  // Lys grønn stiplet (Sann Q_lunge, A7)
            
            volume: '#06b6d4',         // Cyan / Lys blå (Volum - V_meas)
            volumeFill: 'rgba(6, 182, 212, 0.10)',
            volumeLung: 'rgba(165, 243, 252, 0.90)', // Lys cyan stiplet (Sant V_lunge, A7)
            
            pes: '#d946ef',            // Magenta - muskelinnsats / oesofagustrykk
            pesFill: 'rgba(217, 70, 239, 0.12)',
            
            zeroLine: 'rgba(255, 255, 255, 0.65)',   // Knivskarp 0-linje
            peepLine: 'rgba(251, 191, 36, 0.35)',   // PEEP/EPAP referanselinje
            clipIndicator: '#f43f5e',                // Rødrosa klippeindikator ved akselås (C9)
            
            text: '#FFFFFF',
            textDim: '#FFFFFF',
            textBright: '#ffffff',
            triggerMark: '#d946ef'     // Triggermarkør (Hamilton lilla/magenta)
        };

        // Layout & Marger for kurvefeltet
        this.leftMargin = 64;   // Dedikert aksemarg på venstre side for forholdstall
        this.rightMargin = 16;  // Luft på høyre side
        
        // C8: Sveip innstillinger (Låst til 15.0 s)
        this.sweepDuration = 15.0; // sekunder for ett helt sveip (låst til 15.0 s)
        this.sweepTime = 0;
        this.sweepX = 0;          // Relativ pikselposisjon (0..activeWidth)
        this.eraseWidth = 24;     // Piksler foran sveipesonen

        // FASE 6 (D6): Undervisnings- og frysemodus
        this.isFrozen = false;
        this.isCursorActive = false;
        this.cursorX = null;
        this.cursorY = null;
        this.showAnnotations = false;
        this.annotations = [];

        // C9: Akseskalering (Auto-skalering med faste minimumsgrenser: Paw min 15, Flow min 30, Vol min 200, Pes min 10)
        this.autoScale = {
            paw: true,
            flow: true,
            vol: true,
            pes: true
        };

        // Faste kliniske minimumsskalaer (C9 & FASE 4)
        this.fixedScales = {
            pawMin: 0,
            pawMax: 15,
            flowMin: -30,
            flowMax: 30,
            volMin: 0,
            volMax: 200,
            pesMin: -10,
            pesMax: 10
        };

        // Dynamiske skalaer (Starter på minimumsverdiene)
        this.dynamicScales = {
            pawMax: 15,
            volMax: 200,
            flowMax: 30,
            flowMin: -30,
            pesMax: 10,
            pesMin: -10
        };

        // Standard kliniske skalanivåer for dynamisk tilpasning (begrenset av minimumsverdier: Gul min 15, Grønn min 30, Blå min 200, Pes min 10)
        this.scaleTiers = {
            paw: [15, 20, 25, 30, 35, 40, 50, 60, 80, 100],
            flow: [30, 40, 60, 80, 100, 120, 150, 200, 250, 300],
            vol: [200, 300, 400, 500, 600, 800, 1000, 1200, 1500, 2000, 2500, 3000],
            pes: [10, 15, 20, 25, 30, 40]
        };

        // Holdetid før skala trappes ned (unngår flimring/uro)
        this.scaleHold = {
            paw: 0,
            flow: 0,
            vol: 0,
            pes: 0
        };

        // Databuffere (C7: min/maks-konvolutt per piksel)
        this.bufferWidth = 0;
        this.pressureData = [];
        this.volumeData = [];
        this.flowData = [];
        this.volumeLungData = []; // Sann lungevolum buffer (A7)
        this.flowLungData = [];   // Sann lungeflow buffer (A7)
        this.pesData = [];        // Muskelinnsats / oesofagustrykk (P_es / P_mus)
        this.markerData = [];     // D3: Innsatsmarkører per pikselposisjon

        // Pedagogisk modus: Vis sanne lungekurver overlagret (A7)
        this.showTrueCurves = false;
        this.showPesTrack = false;
        this.currentEpap = 5;

        // Fase 7 (Oppgave 7.2): Sporing av volumavvik ved slutt-ekspirasjon
        this.volumeDivergenceHold = 0;
        this._prevVolLast = 0;
        this._prevVolLungLast = 0;

        this.initCanvas();
        window.addEventListener('resize', () => this.resizeCanvas());
    }

    // FASE 6 (D6): Frysemodus og undervisningsverktøy
    setFrozen(frozen) {
        this.isFrozen = !!frozen;
    }

    setCursor(x, y) {
        if (x === null || x === undefined) {
            this.clearCursor();
            return;
        }
        this.isCursorActive = true;
        this.cursorX = x;
        this.cursorY = y;
    }

    clearCursor() {
        this.isCursorActive = false;
        this.cursorX = null;
        this.cursorY = null;
    }

    setAnnotations(list) {
        this.annotations = Array.isArray(list) ? list : [];
    }

    toggleAnnotations(show) {
        this.showAnnotations = (show !== undefined) ? !!show : !this.showAnnotations;
        return this.showAnnotations;
    }

    async copyToClipboard() {
        try {
            if (!navigator.clipboard || !navigator.clipboard.write) {
                // Fallback for eldre nettlesere
                return false;
            }
            const blob = await new Promise(resolve => this.canvas.toBlob(resolve, 'image/png'));
            if (!blob) return false;
            await navigator.clipboard.write([
                new ClipboardItem({ 'image/png': blob })
            ]);
            return true;
        } catch (err) {
            console.warn('Utklippstavle-eksport feilet:', err);
            return false;
        }
    }

    // C8: Låst sveipetid (15.0 sekunder) og reinitialiser buffere rent
    setSweepDuration(seconds) {
        this.sweepDuration = 15.0;
        this.sweepTime = 0;
        this.sweepX = 0;
        this._clearBuffers();
    }

    // C9: Slå automatisk skalering av/på per spor eller globalt
    setAutoScale(trackId, isAuto) {
        if (trackId === 'all') {
            this.autoScale.paw = isAuto;
            this.autoScale.flow = isAuto;
            this.autoScale.vol = isAuto;
            this.autoScale.pes = isAuto;
        } else if (this.autoScale[trackId] !== undefined) {
            this.autoScale[trackId] = isAuto;
        }
    }

    initCanvas() {
        this.sweepTime = 0;
        this.sweepX = 0;
        this.scaleHold.paw = 0;
        this.scaleHold.flow = 0;
        this.scaleHold.vol = 0;
        this.scaleHold.pes = 0;
        this.dynamicScales.pawMax = 15;
        this.dynamicScales.flowMax = 30;
        this.dynamicScales.flowMin = -30;
        this.dynamicScales.volMax = 200;
        this.dynamicScales.pesMax = 10;
        this.dynamicScales.pesMin = -10;
        this.resizeCanvas();
    }

    _clearBuffers() {
        if (!this.activeWidth || this.activeWidth <= 0) return;
        this.pressureData = new Array(this.activeWidth).fill(null);
        this.volumeData = new Array(this.activeWidth).fill(null);
        this.flowData = new Array(this.activeWidth).fill(null);
        this.volumeLungData = new Array(this.activeWidth).fill(null);
        this.flowLungData = new Array(this.activeWidth).fill(null);
        this.pesData = new Array(this.activeWidth).fill(null);
        this.markerData = new Array(this.activeWidth).fill(null);
    }

    resize() {
        this.resizeCanvas();
    }

    resizeCanvas() {
        const rect = this.canvas.parentElement.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        
        const width = Math.floor(rect.width);
        const height = Math.max(480, Math.floor(rect.height));

        this.canvas.width = width * dpr;
        this.canvas.height = height * dpr;
        this.canvas.style.width = width + 'px';
        this.canvas.style.height = height + 'px';

        this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        this.logicalWidth = width;
        this.logicalHeight = height;

        // Aktiv bredde for selve kurvefeltet (mellom venstre aksemarg og høyre kant)
        this.activeWidth = Math.max(100, width - this.leftMargin - this.rightMargin);
        this.bufferWidth = this.activeWidth;

        this._clearBuffers();
    }

    // C9: Automatisk dynamisk Y-skalering med begrensende minimumsverdier (Gul min 15, Grønn min 30, Blå min 200, Pes min 10)
    _updateDynamicScales(dt, currentPaw, currentVol, currentFlow, currentVolLung = 0, currentFlowLung = 0, currentPes = 0) {
        if (!this.activeWidth || this.activeWidth <= 0) return;

        let maxPaw = (currentPaw !== undefined && currentPaw !== null) ? currentPaw : 0;
        let maxFlow = (currentFlow !== undefined && currentFlow !== null) ? Math.abs(currentFlow) : 0;
        let maxVol = (currentVol !== undefined && currentVol !== null) ? currentVol : 0;
        let maxPes = (currentPes !== undefined && currentPes !== null) ? Math.abs(currentPes) : 0;

        if (this.showTrueCurves) {
            if (currentFlowLung !== undefined && currentFlowLung !== null) {
                maxFlow = Math.max(maxFlow, Math.abs(currentFlowLung));
            }
            if (currentVolLung !== undefined && currentVolLung !== null) {
                maxVol = Math.max(maxVol, currentVolLung);
            }
        }

        for (let x = 0; x < this.activeWidth; x++) {
            const p = this.pressureData[x];
            if (p && p.max > maxPaw) maxPaw = p.max;

            const f = this.flowData[x];
            if (f) {
                const absF = Math.max(Math.abs(f.max), Math.abs(f.min));
                if (absF > maxFlow) maxFlow = absF;
            }

            const v = this.volumeData[x];
            if (v && v.max > maxVol) maxVol = v.max;

            if (this.pesData) {
                const pes = this.pesData[x];
                if (pes) {
                    const absPes = Math.max(Math.abs(pes.max), Math.abs(pes.min));
                    if (absPes > maxPes) maxPes = absPes;
                }
            }

            if (this.showTrueCurves) {
                const fl = this.flowLungData[x];
                if (fl) {
                    const absFl = Math.max(Math.abs(fl.max), Math.abs(fl.min));
                    if (absFl > maxFlow) maxFlow = absFl;
                }
                const vl = this.volumeLungData[x];
                if (vl && vl.max > maxVol) maxVol = vl.max;
            }
        }

        const headroomRatio = 0.85;

        // 1. Paw (Gul min 15)
        if (this.autoScale.paw) {
            const targetPaw = this._findTargetTier(maxPaw / headroomRatio, this.scaleTiers.paw, 15);
            if (targetPaw > this.dynamicScales.pawMax) {
                this.dynamicScales.pawMax = targetPaw;
                this.scaleHold.paw = 0;
            } else if (targetPaw < this.dynamicScales.pawMax) {
                this.scaleHold.paw += dt;
                if (this.scaleHold.paw >= 1.5) {
                    this.dynamicScales.pawMax = targetPaw;
                    this.scaleHold.paw = 0;
                }
            } else {
                this.scaleHold.paw = 0;
            }
        }

        // 2. Flow (Grønn min 30)
        if (this.autoScale.flow) {
            const targetFlow = this._findTargetTier(maxFlow / headroomRatio, this.scaleTiers.flow, 30);
            if (targetFlow > this.dynamicScales.flowMax) {
                this.dynamicScales.flowMax = targetFlow;
                this.dynamicScales.flowMin = -targetFlow;
                this.scaleHold.flow = 0;
            } else if (targetFlow < this.dynamicScales.flowMax) {
                this.scaleHold.flow += dt;
                if (this.scaleHold.flow >= 1.5) {
                    this.dynamicScales.flowMax = targetFlow;
                    this.dynamicScales.flowMin = -targetFlow;
                    this.scaleHold.flow = 0;
                }
            } else {
                this.scaleHold.flow = 0;
            }
        }

        // 3. Volum (Blå min 200)
        if (this.autoScale.vol) {
            const targetVol = this._findTargetTier(maxVol / headroomRatio, this.scaleTiers.vol, 200);
            if (targetVol > this.dynamicScales.volMax) {
                this.dynamicScales.volMax = targetVol;
                this.scaleHold.vol = 0;
            } else if (targetVol < this.dynamicScales.volMax) {
                this.scaleHold.vol += dt;
                if (this.scaleHold.vol >= 1.5) {
                    this.dynamicScales.volMax = targetVol;
                    this.scaleHold.vol = 0;
                }
            } else {
                this.scaleHold.vol = 0;
            }
        }

        // 4. P_es (Magenta min 10)
        if (this.autoScale.pes) {
            const targetPes = this._findTargetTier(maxPes / headroomRatio, this.scaleTiers.pes, 10);
            if (targetPes > this.dynamicScales.pesMax) {
                this.dynamicScales.pesMax = targetPes;
                this.dynamicScales.pesMin = -targetPes;
                this.scaleHold.pes = 0;
            } else if (targetPes < this.dynamicScales.pesMax) {
                this.scaleHold.pes += dt;
                if (this.scaleHold.pes >= 1.5) {
                    this.dynamicScales.pesMax = targetPes;
                    this.dynamicScales.pesMin = -targetPes;
                    this.scaleHold.pes = 0;
                }
            } else {
                this.scaleHold.pes = 0;
            }
        }
    }

    _findTargetTier(val, tiers, defaultMin = 10) {
        if (tiers && tiers.length > 0) {
            for (let i = 0; i < tiers.length; i++) {
                if (tiers[i] >= val) {
                    return Math.max(defaultMin, tiers[i]);
                }
            }
        }
        return Math.max(defaultMin, Math.ceil(val / 10) * 10);
    }

    // C7 & D3: Legg til sample med min/maks-konvolutt og hendelsesmarkører
    addSample(dt, sampleOrPaw, volume, flow, isTriggered = false, epap = 5, volumeLung = null, flowLung = null, events = null) {
        if (!this.activeWidth || this.activeWidth <= 0) return;

        this.currentEpap = epap;
        this.sweepTime += dt;
        if (this.sweepTime >= this.sweepDuration) {
            this.sweepTime = 0;
        }

        const prevX = this.sweepX;
        this.sweepX = (this.sweepTime / this.sweepDuration) * this.activeWidth;
        const currentPx = Math.floor(this.sweepX);

        // Hent strukturert min/maks-prøve
        let pSample, fSample, vSample, vLungSample, fLungSample, pesSample;

        if (typeof sampleOrPaw === 'object' && sampleOrPaw !== null) {
            pSample = { min: sampleOrPaw.pawMin, max: sampleOrPaw.pawMax, last: sampleOrPaw.pawLast };
            fSample = { min: sampleOrPaw.flowMin, max: sampleOrPaw.flowMax, last: sampleOrPaw.flowLast };
            vSample = { min: sampleOrPaw.volMin, max: sampleOrPaw.volMax, last: sampleOrPaw.volLast };
            fLungSample = (sampleOrPaw.flowLungMin !== undefined) ? { min: sampleOrPaw.flowLungMin, max: sampleOrPaw.flowLungMax, last: sampleOrPaw.flowLungLast } : null;
            vLungSample = (sampleOrPaw.volLungMin !== undefined) ? { min: sampleOrPaw.volLungMin, max: sampleOrPaw.volLungMax, last: sampleOrPaw.volLungLast } : null;
            pesSample = { min: sampleOrPaw.pesMin, max: sampleOrPaw.pesMax, last: sampleOrPaw.pesLast };
        } else {
            // Bakoverkompatibilitet
            const p = sampleOrPaw;
            pSample = { min: p, max: p, last: p };
            fSample = { min: flow, max: flow, last: flow };
            vSample = { min: volume, max: volume, last: volume };
            fLungSample = (flowLung !== null) ? { min: flowLung, max: flowLung, last: flowLung } : null;
            vLungSample = (volumeLung !== null) ? { min: volumeLung, max: volumeLung, last: volumeLung } : null;
            pesSample = { min: 0, max: 0, last: 0 };
        }

        // Oppdater dynamiske Y-akser
        this._updateDynamicScales(
            dt,
            pSample.last,
            vSample.last,
            fSample.last,
            vLungSample ? vLungSample.last : 0,
            fLungSample ? fLungSample.last : 0,
            pesSample ? pesSample.last : 0
        );

        const startX = Math.floor(prevX);
        const endX = currentPx;

        // Tøm slettesonen foran nåværende sveipelinje så gamle markører og kurver fjernes rent
        for (let i = 1; i <= this.eraseWidth; i++) {
            const clearIdx = (currentPx + i) % this.activeWidth;
            this.pressureData[clearIdx] = null;
            this.flowData[clearIdx] = null;
            this.volumeData[clearIdx] = null;
            this.flowLungData[clearIdx] = null;
            this.volumeLungData[clearIdx] = null;
            if (this.pesData) this.pesData[clearIdx] = null;
            this.markerData[clearIdx] = null;
        }

        // Hjelpefunksjon for å skrive min/maks inn i pikselbuffer
        const writeToBuffer = (buf, idx, s) => {
            if (!s) return;
            if (buf[idx] === null || buf[idx] === undefined) {
                buf[idx] = { min: s.min, max: s.max, last: s.last };
            } else {
                buf[idx].min = Math.min(buf[idx].min, s.min);
                buf[idx].max = Math.max(buf[idx].max, s.max);
                buf[idx].last = s.last;
            }
        };

        const applySamplesAt = (x) => {
            writeToBuffer(this.pressureData, x, pSample);
            writeToBuffer(this.flowData, x, fSample);
            writeToBuffer(this.volumeData, x, vSample);
            if (fLungSample) writeToBuffer(this.flowLungData, x, fLungSample);
            if (vLungSample) writeToBuffer(this.volumeLungData, x, vLungSample);
            if (pesSample) writeToBuffer(this.pesData, x, pesSample);
        };

        // Fyll inn i buffer for sveipet
        if (endX >= startX) {
            for (let x = startX; x <= endX && x < this.activeWidth; x++) {
                applySamplesAt(x);
            }
        } else {
            // Skjerm vendt rundt (wrap-around)
            for (let x = startX; x < this.activeWidth; x++) {
                applySamplesAt(x);
            }
            for (let x = 0; x <= endX; x++) {
                applySamplesAt(x);
            }
        }

        // D3: Håndter innsatsmarkører (fra hendelsesliste eller trigger-flagg)
        if (events && Array.isArray(events) && events.length > 0) {
            events.forEach(ev => {
                this.markerData[currentPx] = { type: ev.type, t: ev.t };
            });
        } else if (isTriggered) {
            this.markerData[currentPx] = { type: 'assist', t: this.sweepTime };
        }

        // Fase 7 (Oppgave 7.2): Mål avvik mellom maskinmålt og sant volum ved slutt-ekspirasjon
        if (this.volumeDivergenceHold > 0) {
            this.volumeDivergenceHold = Math.max(0, this.volumeDivergenceHold - dt);
        }

        const isBreathStart = isTriggered || (events && Array.isArray(events) && events.some(e => e.type === 'assist' || e.type === 'auto' || e.type === 'double' || e.type === 'mandatory'));
        if (isBreathStart) {
            const endExpDiff = Math.abs(this._prevVolLast - this._prevVolLungLast);
            if (endExpDiff > 200) {
                this.volumeDivergenceHold = 15.0; // Behold etiketten synlig i minst ett fullt sveip
            }
        }

        this._prevVolLast = vSample.last;
        this._prevVolLungLast = (vLungSample !== null && vLungSample !== undefined) ? vLungSample.last : 0;
    }

    // Hovedtegne-loop
    render() {
        const w = this.logicalWidth;
        const h = this.logicalHeight;
        if (!w || !h || !this.activeWidth) return;

        const ctx = this.ctx;
        const leftM = this.leftMargin;
        const activeW = this.activeWidth;

        // 1. Tøm bakgrunn
        ctx.fillStyle = this.colors.bg;
        ctx.fillRect(0, 0, w, h);

        // 3 eller 4 spor avhengig av showPesTrack
        const numTracks = this.showPesTrack ? 4 : 3;
        const trackHeight = h / numTracks;

        const tracks = [
            { id: 'paw', label: 'Paw', unit: 'cmH₂O', color: this.colors.pressure, top: 0, height: trackHeight },
            { id: 'flow', label: 'Flow', unit: 'L/min', color: this.colors.flow, top: trackHeight, height: trackHeight },
            { id: 'vol', label: 'V', unit: 'ml', color: this.colors.volume, top: trackHeight * 2, height: trackHeight }
        ];
        if (this.showPesTrack) {
            tracks.push({ id: 'pes', label: 'P_es', unit: 'cmH₂O', color: this.colors.pes, top: trackHeight * 3, height: trackHeight });
        }

        // 2. Rutenett, sekundmarkører og tidsakse
        this._drawGridAndTimeAxis(ctx, w, h, tracks, leftM, activeW);

        // 3. Tegn kurvene, bunnlinjer, 0-linjer og arealvisning for hvert spor
        this._drawPressureTrack(ctx, tracks[0], leftM, activeW);
        this._drawFlowTrack(ctx, tracks[1], leftM, activeW);
        this._drawVolumeTrack(ctx, tracks[2], leftM, activeW);
        if (this.showPesTrack && tracks[3]) {
            this._drawPesTrack(ctx, tracks[3], leftM, activeW);
        }

        // 4. Tegn Sweep Bar og Erase Zone (bare når simuleringen er aktiv)
        if (!this.isFrozen) {
            this._drawSweepBar(ctx, h, leftM, activeW);
        }

        // 5. Tegn Y-akser, dynamiske/låste skalaer og forholdstall på venstre side
        this._drawLeftYAxes(ctx, tracks, leftM, activeW);

        // 6. FASE 6 (D6): Tegn fasit-annotasjoner hvis aktivert
        if (this.showAnnotations && this.annotations && this.annotations.length > 0) {
            this._drawAnnotations(ctx, tracks, leftM, activeW, h);
        }

        // 7. FASE 6 (D6): Tegn kursor og flytende måleverdikort hvis aktiv
        if (this.isCursorActive && this.cursorX !== null) {
            this._drawCursor(ctx, tracks, leftM, activeW, h);
        }
    }

    // FASE 6 (D6): Tegner kursorlinje og flytende måleverdikort
    _drawCursor(ctx, tracks, leftM, activeW, h) {
        ctx.save();
        const curX = Math.max(leftM, Math.min(leftM + activeW - 1, this.cursorX));
        const bufX = Math.floor(curX - leftM);

        // Vertikal kursorlinje
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
        ctx.lineWidth = 1.2;
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.moveTo(curX, 0);
        ctx.lineTo(curX, h);
        ctx.stroke();
        ctx.setLineDash([]);

        // Hent data ved kursor
        const pPt = this.pressureData[bufX];
        const fPt = this.flowData[bufX];
        const vPt = this.volumeData[bufX];
        const pesPt = this.pesData ? this.pesData[bufX] : null;

        const pVal = pPt ? pPt.last : null;
        const fVal = fPt ? fPt.last : null;
        const vVal = vPt ? vPt.last : null;
        const pesVal = pesPt ? pesPt.last : null;

        // Sekundposisjon i sveipet
        const timeSec = (bufX / activeW) * this.sweepDuration;

        // Funksjon for å beregne Y-posisjon på skjerm for et spor
        const getYForVal = (trackIndex, val) => {
            if (val === null || val === undefined) return null;
            const track = tracks[trackIndex];
            if (!track) return null;
            const paddingTop = 22;
            const paddingBottom = 10;
            const bottomY = track.top + track.height - paddingBottom;
            const topY = track.top + paddingTop;
            const usableH = bottomY - topY;

            if (track.id === 'paw') {
                const maxP = this.autoScale.paw ? this.dynamicScales.pawMax : this.fixedScales.pawMax;
                return bottomY - (Math.max(0, val) / maxP) * usableH;
            } else if (track.id === 'flow') {
                const maxF = this.autoScale.flow ? this.dynamicScales.flowMax : this.fixedScales.flowMax;
                const zeroY = topY + usableH / 2;
                return zeroY - (val / maxF) * (usableH / 2);
            } else if (track.id === 'vol') {
                const maxV = this.autoScale.vol ? this.dynamicScales.volMax : this.fixedScales.volMax;
                return bottomY - (Math.max(0, val) / maxV) * usableH;
            } else if (track.id === 'pes') {
                const maxPes = this.autoScale.pes ? this.dynamicScales.pesMax : this.fixedScales.pesMax;
                const zeroY = topY + usableH / 2;
                return zeroY - (val / maxPes) * (usableH / 2);
            }
            return null;
        };

        // Tegn små sirkler på hver kurve
        const drawPointCircle = (y, color) => {
            if (y === null) return;
            ctx.fillStyle = color;
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.arc(curX, y, 4, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
        };

        drawPointCircle(getYForVal(0, pVal), this.colors.pressure);
        drawPointCircle(getYForVal(1, fVal), this.colors.flow);
        drawPointCircle(getYForVal(2, vVal), this.colors.volume);
        if (this.showPesTrack && tracks[3]) {
            drawPointCircle(getYForVal(3, pesVal), this.colors.pes);
        }

        // Tegn flytende tooltip-boks
        const cardW = 165;
        const cardH = this.showPesTrack ? 116 : 100;
        let cardX = curX + 12;
        if (cardX + cardW > leftM + activeW) {
            cardX = curX - cardW - 12;
        }
        let cardY = (this.cursorY !== null && this.cursorY !== undefined) ? this.cursorY - cardH / 2 : 20;
        cardY = Math.max(10, Math.min(h - cardH - 10, cardY));

        ctx.fillStyle = 'rgba(10, 15, 28, 0.94)';
        ctx.strokeStyle = 'rgba(56, 189, 248, 0.5)';
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        if (ctx.roundRect) {
            ctx.roundRect(cardX, cardY, cardW, cardH, 6);
        } else {
            ctx.rect(cardX, cardY, cardW, cardH);
        }
        ctx.fill();
        ctx.stroke();

        // Tooltip innhold
        ctx.textAlign = 'left';
        let lineY = cardY + 16;

        ctx.fillStyle = '#FFFFFF';
        ctx.font = '600 10px monospace';
        ctx.fillText(`⏱ TID: ${timeSec.toFixed(2)} s`, cardX + 10, lineY);

        lineY += 18;
        ctx.fillStyle = this.colors.pressure;
        ctx.font = 'bold 11px monospace';
        ctx.fillText(`Paw:  ${pVal !== null ? pVal.toFixed(1) : '--'} cmH₂O`, cardX + 10, lineY);

        lineY += 16;
        ctx.fillStyle = this.colors.flow;
        const fText = (fVal !== null) ? ((fVal > 0 ? '+' : '') + fVal.toFixed(1)) : '--';
        ctx.fillText(`Flow: ${fText} L/min`, cardX + 10, lineY);

        lineY += 16;
        ctx.fillStyle = this.colors.volume;
        ctx.fillText(`Vol:  ${vVal !== null ? vVal.toFixed(0) : '--'} ml`, cardX + 10, lineY);

        if (this.showPesTrack) {
            lineY += 16;
            ctx.fillStyle = this.colors.pes;
            const pesPrefix = (pesVal !== null && pesVal > 0) ? '+' : '';
            const pesText = (pesVal !== null) ? `${pesPrefix}${pesVal.toFixed(1)}` : '--';
            ctx.fillText(`P_es: ${pesText} cmH₂O`, cardX + 10, lineY);
        }

        ctx.restore();
    }

    // FASE 6 (D6): Tegner annotasjonslag med ringer, piler og forklarende tekst for aktivt scenario
    _drawAnnotations(ctx, tracks, leftM, activeW, h) {
        if (!this.annotations || this.annotations.length === 0) return;
        ctx.save();

        this.annotations.forEach(ann => {
            const trackId = ann.track || 'paw';
            if (trackId === 'pes' && !this.showPesTrack) {
                // Hvis en annotasjon peker på 'pes' og sporet ikke er synlig, hopp over den
                return;
            }

            const validTracks = ['paw', 'flow', 'vol', 'pes'];
            let matchedTrack = tracks.find(t => t.id === trackId);
            if (!validTracks.includes(trackId)) {
                console.warn(`[Renderer] Ukjent track "${trackId}" for annotasjon "${ann.title || ''}". Faller tilbake til 'paw'.`);
                matchedTrack = tracks.find(t => t.id === 'paw') || tracks[0];
            } else if (!matchedTrack) {
                matchedTrack = tracks.find(t => t.id === 'paw') || tracks[0];
            }

            const track = matchedTrack;
            if (!track) return;

            const relX = (ann.relX !== undefined) ? ann.relX : 0.5;
            const targetX = leftM + Math.round(relX * activeW);
            const relY = (ann.relY !== undefined) ? ann.relY : 0.45;
            const targetY = track.top + relY * track.height;

            const calloutX = (ann.boxX !== undefined) ? (leftM + ann.boxX * activeW) : Math.min(leftM + activeW - 140, targetX + 25);
            const calloutY = (ann.boxY !== undefined) ? (track.top + ann.boxY * track.height) : Math.max(track.top + 10, targetY - 35);

            // Rød/oransje markering rundt funnet
            ctx.strokeStyle = '#f43f5e';
            ctx.fillStyle = 'rgba(244, 63, 94, 0.2)';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.ellipse(targetX, targetY, 20, 14, 0, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();

            // Pil fra callout til sirkel
            ctx.strokeStyle = '#fb7185';
            ctx.lineWidth = 1.6;
            ctx.beginPath();
            ctx.moveTo(calloutX + 10, calloutY + 12);
            ctx.lineTo(targetX, targetY);
            ctx.stroke();

            // Callout-boks
            const text1 = ann.title || 'Funn';
            const text2 = ann.desc || '';
            ctx.font = 'bold 11px sans-serif';
            const w1 = ctx.measureText(text1).width;
            ctx.font = '10px sans-serif';
            const w2 = text2 ? ctx.measureText(text2).width : 0;
            const boxW = Math.max(w1, w2) + 20;
            const boxH = text2 ? 38 : 24;

            ctx.fillStyle = 'rgba(15, 23, 42, 0.95)';
            ctx.strokeStyle = '#f43f5e';
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            if (ctx.roundRect) {
                ctx.roundRect(calloutX, calloutY, boxW, boxH, 6);
            } else {
                ctx.rect(calloutX, calloutY, boxW, boxH);
            }
            ctx.fill();
            ctx.stroke();

            ctx.fillStyle = '#fca5a5';
            ctx.font = 'bold 11px sans-serif';
            ctx.textAlign = 'left';
            ctx.fillText(text1, calloutX + 10, calloutY + 14);

            if (text2) {
                ctx.fillStyle = '#FFFFFF';
                ctx.font = '10px sans-serif';
                ctx.fillText(text2, calloutX + 10, calloutY + 28);
            }
        });

        ctx.restore();
    }

    _drawGridAndTimeAxis(ctx, w, h, tracks, leftM, activeW) {
        ctx.save();

        const seconds = this.sweepDuration;
        let labelInterval = 1;
        if (seconds >= 15) labelInterval = 5;
        else if (seconds >= 10) labelInterval = 2;
        else labelInterval = 1;

        for (let s = 0; s <= seconds; s++) {
            const x = leftM + Math.round((s / seconds) * activeW);
            const isMajor = (s % labelInterval === 0);
            
            ctx.strokeStyle = isMajor ? this.colors.grid : this.colors.gridSubtle;
            ctx.lineWidth = isMajor ? 1 : 0.75;
            ctx.beginPath();
            ctx.moveTo(x, 0);
            ctx.lineTo(x, h);
            ctx.stroke();

            // Sekundtall langs aksen mellom Paw og Flow
            if (s > 0 && s < seconds && isMajor) {
                ctx.fillStyle = this.colors.textDim;
                ctx.font = '500 9px monospace';
                ctx.textAlign = 'center';
                ctx.fillText(`${s}s`, x, tracks[1].top - 3);
            }
        }

        // Spor-oppdeling (Horisontale skillelinjer mellom sporene)
        tracks.forEach((track, index) => {
            if (index > 0) {
                ctx.strokeStyle = this.colors.axisLine;
                ctx.lineWidth = 1.2;
                ctx.beginPath();
                ctx.moveTo(leftM - 6, track.top);
                ctx.lineTo(leftM + activeW, track.top);
                ctx.stroke();
            }
        });

        ctx.restore();
    }

    // Genererer klinisk gjenkjennelige tikk-verdier
    _getTicksForScale(type, maxVal, minVal = 0) {
        if (type === 'paw') {
            if (maxVal <= 15) return [15, 10, 5, 0];
            if (maxVal <= 20) return [20, 15, 10, 5, 0];
            if (maxVal <= 25) return [25, 20, 15, 10, 5, 0];
            if (maxVal <= 30) return [30, 20, 10, 0];
            if (maxVal <= 35) return [35, 25, 15, 5, 0];
            if (maxVal <= 40) return [40, 30, 20, 10, 0];
            if (maxVal <= 50) return [50, 40, 30, 20, 10, 0];
            if (maxVal <= 60) return [60, 40, 20, 0];
            if (maxVal <= 80) return [80, 60, 40, 20, 0];
            if (maxVal <= 100) return [100, 75, 50, 25, 0];
            return this._calculateTicks(0, maxVal, 4);
        } else if (type === 'flow' || type === 'pes') {
            const mid = Math.round(maxVal / 2);
            return [maxVal, mid, 0, -mid, -maxVal];
        } else if (type === 'vol') {
            if (maxVal <= 200) return [200, 150, 100, 50, 0];
            if (maxVal <= 300) return [300, 200, 100, 0];
            if (maxVal <= 400) return [400, 300, 200, 100, 0];
            if (maxVal <= 500) return [500, 400, 300, 200, 100, 0];
            if (maxVal <= 600) return [600, 400, 200, 0];
            if (maxVal <= 800) return [800, 600, 400, 200, 0];
            if (maxVal <= 1000) return [1000, 750, 500, 250, 0];
            if (maxVal <= 1200) return [1200, 900, 600, 300, 0];
            if (maxVal <= 1500) return [1500, 1000, 500, 0];
            if (maxVal <= 2000) return [2000, 1500, 1000, 500, 0];
            return this._calculateTicks(0, maxVal, 4);
        }
        return this._calculateTicks(minVal, maxVal, 4);
    }

    _drawLeftYAxes(ctx, tracks, leftM, activeW) {
        ctx.save();

        ctx.strokeStyle = this.colors.axisLine;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(leftM, 0);
        ctx.lineTo(leftM, this.logicalHeight);
        ctx.stroke();

        const paddingBottom = 10;
        const paddingTop = 22;

        // 1. Paw Akse (Øverst)
        const pTrack = tracks[0];
        const pTopY = pTrack.top + paddingTop;
        const pBottomY = pTrack.top + pTrack.height - paddingBottom;
        const pUsableH = pBottomY - pTopY;
        const pawMax = this.autoScale.paw ? this.dynamicScales.pawMax : this.fixedScales.pawMax;

        ctx.fillStyle = pTrack.color;
        ctx.font = 'bold 12px "Segoe UI", sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText('Paw', 8, pTrack.top + 14);
        ctx.fillStyle = this.colors.text;
        ctx.font = '500 9px monospace';
        ctx.fillText('cmH₂O', 8, pTrack.top + 24);

        if (!this.autoScale.paw) {
            ctx.fillStyle = 'rgba(251, 191, 36, 0.7)';
            ctx.font = '600 8px monospace';
            ctx.fillText('🔒LÅS', leftM - 38, pTrack.top + 13);
        }

        const pawTicks = this._getTicksForScale('paw', pawMax);
        pawTicks.forEach(val => {
            const ratio = val / pawMax;
            const y = pBottomY - ratio * pUsableH;
            
            if (val > 0 && val < pawMax) {
                ctx.strokeStyle = this.colors.gridTickLine;
                ctx.lineWidth = 0.8;
                ctx.beginPath();
                ctx.moveTo(leftM, y);
                ctx.lineTo(leftM + activeW, y);
                ctx.stroke();
            }

            ctx.strokeStyle = this.colors.axisLine;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(leftM - 5, y);
            ctx.lineTo(leftM, y);
            ctx.stroke();

            ctx.fillStyle = (val === 0) ? this.colors.textBright : this.colors.text;
            ctx.font = (val === 0) ? 'bold 10px monospace' : '9px monospace';
            ctx.textAlign = 'right';
            ctx.fillText(`${val}`, leftM - 7, y + 3.5);
        });

        // 2. Flow Akse (I midten)
        const fTrack = tracks[1];
        const fTopY = fTrack.top + paddingTop;
        const fBottomY = fTrack.top + fTrack.height - paddingBottom;
        const fZeroY = fTopY + (fBottomY - fTopY) / 2;
        const fHalfH = (fBottomY - fTopY) / 2;
        const flowMax = this.autoScale.flow ? this.dynamicScales.flowMax : this.fixedScales.flowMax;

        ctx.fillStyle = fTrack.color;
        ctx.font = 'bold 12px "Segoe UI", sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText('Flow', 8, fTrack.top + 14);
        ctx.fillStyle = this.colors.text;
        ctx.font = '500 9px monospace';
        ctx.fillText('L/min', 8, fTrack.top + 24);

        if (!this.autoScale.flow) {
            ctx.fillStyle = 'rgba(34, 197, 94, 0.7)';
            ctx.font = '600 8px monospace';
            ctx.fillText('🔒LÅS', leftM - 38, fTrack.top + 13);
        }

        const flowTicks = this._getTicksForScale('flow', flowMax);
        flowTicks.forEach(val => {
            const ratio = val / flowMax;
            const y = fZeroY - ratio * fHalfH;

            if (Math.abs(val) > 0 && Math.abs(val) < flowMax) {
                ctx.strokeStyle = this.colors.gridTickLine;
                ctx.lineWidth = 0.8;
                ctx.beginPath();
                ctx.moveTo(leftM, y);
                ctx.lineTo(leftM + activeW, y);
                ctx.stroke();
            }

            ctx.strokeStyle = (val === 0) ? this.colors.zeroLine : this.colors.axisLine;
            ctx.lineWidth = (val === 0) ? 1.5 : 1;
            ctx.beginPath();
            ctx.moveTo(leftM - 6, y);
            ctx.lineTo(leftM, y);
            ctx.stroke();

            ctx.fillStyle = (val === 0) ? this.colors.textBright : this.colors.text;
            ctx.font = (val === 0) ? 'bold 10px monospace' : '9px monospace';
            ctx.textAlign = 'right';
            const prefix = (val > 0) ? '+' : '';
            ctx.fillText(`${prefix}${val}`, leftM - 7, y + 3.5);
        });

        // 3. Volum Akse (Nederst)
        const vTrack = tracks[2];
        const vTopY = vTrack.top + paddingTop;
        const vBottomY = vTrack.top + vTrack.height - paddingBottom;
        const vUsableH = vBottomY - vTopY;
        const volMax = this.autoScale.vol ? this.dynamicScales.volMax : this.fixedScales.volMax;

        ctx.fillStyle = vTrack.color;
        ctx.font = 'bold 12px "Segoe UI", sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText('V', 8, vTrack.top + 14);
        ctx.fillStyle = this.colors.text;
        ctx.font = '500 9px monospace';
        ctx.fillText('ml', 8, vTrack.top + 24);

        if (!this.autoScale.vol) {
            ctx.fillStyle = 'rgba(6, 182, 212, 0.7)';
            ctx.font = '600 8px monospace';
            ctx.fillText('🔒LÅS', leftM - 38, vTrack.top + 13);
        }

        const volTicks = this._getTicksForScale('vol', volMax);
        volTicks.forEach(val => {
            const ratio = val / volMax;
            const y = vBottomY - ratio * vUsableH;

            if (val > 0 && val < volMax) {
                ctx.strokeStyle = this.colors.gridTickLine;
                ctx.lineWidth = 0.8;
                ctx.beginPath();
                ctx.moveTo(leftM, y);
                ctx.lineTo(leftM + activeW, y);
                ctx.stroke();
            }

            ctx.strokeStyle = this.colors.axisLine;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(leftM - 5, y);
            ctx.lineTo(leftM, y);
            ctx.stroke();

            ctx.fillStyle = (val === 0) ? this.colors.textBright : this.colors.text;
            ctx.font = (val === 0) ? 'bold 10px monospace' : '9px monospace';
            ctx.textAlign = 'right';
            ctx.fillText(`${val}`, leftM - 7, y + 3.5);
        });

        // 4. P_es Akse (Nederst når 4. spor er aktivert)
        if (this.showPesTrack && tracks[3]) {
            const pesTrack = tracks[3];
            const pesTopY = pesTrack.top + paddingTop;
            const pesBottomY = pesTrack.top + pesTrack.height - paddingBottom;
            const pesZeroY = pesTopY + (pesBottomY - pesTopY) / 2;
            const pesHalfH = (pesBottomY - pesTopY) / 2;
            const pesMax = this.autoScale.pes ? this.dynamicScales.pesMax : this.fixedScales.pesMax;

            ctx.fillStyle = pesTrack.color;
            ctx.font = 'bold 12px "Segoe UI", sans-serif';
            ctx.textAlign = 'left';
            ctx.fillText('P_es', 8, pesTrack.top + 14);
            ctx.fillStyle = this.colors.text;
            ctx.font = '500 9px monospace';
            ctx.fillText('cmH₂O', 8, pesTrack.top + 24);

            if (!this.autoScale.pes) {
                ctx.fillStyle = 'rgba(217, 70, 239, 0.7)';
                ctx.font = '600 8px monospace';
                ctx.fillText('🔒LÅS', leftM - 38, pesTrack.top + 13);
            }

            const pesTicks = this._getTicksForScale('pes', pesMax);
            pesTicks.forEach(val => {
                const ratio = val / pesMax;
                const y = pesZeroY - ratio * pesHalfH;

                if (Math.abs(val) > 0 && Math.abs(val) < pesMax) {
                    ctx.strokeStyle = this.colors.gridTickLine;
                    ctx.lineWidth = 0.8;
                    ctx.beginPath();
                    ctx.moveTo(leftM, y);
                    ctx.lineTo(leftM + activeW, y);
                    ctx.stroke();
                }

                ctx.strokeStyle = (val === 0) ? this.colors.zeroLine : this.colors.axisLine;
                ctx.lineWidth = (val === 0) ? 1.5 : 1;
                ctx.beginPath();
                ctx.moveTo(leftM - 6, y);
                ctx.lineTo(leftM, y);
                ctx.stroke();

                ctx.fillStyle = (val === 0) ? this.colors.textBright : this.colors.text;
                ctx.font = (val === 0) ? 'bold 10px monospace' : '9px monospace';
                ctx.textAlign = 'right';
                const prefix = (val > 0) ? '+' : '';
                ctx.fillText(`${prefix}${val}`, leftM - 7, y + 3.5);
            });
        }

        ctx.restore();
    }

    _drawPressureTrack(ctx, track, leftM, activeW) {
        const paddingBottom = 10;
        const paddingTop = 22;
        const bottomY = track.top + track.height - paddingBottom;
        const topY = track.top + paddingTop;
        const usableH = bottomY - topY;
        const rightEdge = leftM + activeW;
        const pawMax = this.autoScale.paw ? this.dynamicScales.pawMax : this.fixedScales.pawMax;

        // 1. Tydelig bunnlinje (0 cmH2O)
        ctx.save();
        ctx.strokeStyle = this.colors.zeroLine;
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.moveTo(leftM, bottomY);
        ctx.lineTo(rightEdge, bottomY);
        ctx.stroke();

        // 2. PEEP / EPAP referanselinje (subtil stiplet linje som viser grunntrykket)
        if (this.currentEpap > 0) {
            const epapRatio = Math.min(1.0, this.currentEpap / pawMax);
            const epapY = bottomY - epapRatio * usableH;
            ctx.strokeStyle = this.colors.peepLine;
            ctx.lineWidth = 1;
            ctx.setLineDash([3, 4]);
            ctx.beginPath();
            ctx.moveTo(leftM, epapY);
            ctx.lineTo(rightEdge, epapY);
            ctx.stroke();
            ctx.setLineDash([]);
        }
        ctx.restore();

        // 3. Paw kurve: Min/Maks-konvolutt (C7)
        const toY = (paw) => {
            const clamped = Math.max(0, Math.min(pawMax, paw));
            const ratio = clamped / pawMax;
            return bottomY - ratio * usableH;
        };

        this._renderEnvelopeWaveform(
            ctx,
            this.pressureData,
            toY,
            this.colors.pressure,
            this.colors.pressureFill,
            bottomY,
            leftM,
            activeW,
            0,
            pawMax
        );

        // 4. D3: Tegn Innsats- og Triggermarkører (▲, △, ⨂, ■) langs bunnen av Paw-sporet
        this._renderTriggerMarks(ctx, track.top + track.height - 2, leftM);
    }

    _drawFlowTrack(ctx, track, leftM, activeW) {
        const paddingBottom = 10;
        const paddingTop = 22;
        const topY = track.top + paddingTop;
        const bottomY = track.top + track.height - paddingBottom;
        const zeroY = topY + (bottomY - topY) / 2;
        const halfH = (bottomY - topY) / 2;
        const rightEdge = leftM + activeW;
        const flowMax = this.autoScale.flow ? this.dynamicScales.flowMax : this.fixedScales.flowMax;
        const flowMin = -flowMax;

        // Tydelig 0-linje for Flow
        ctx.save();
        ctx.strokeStyle = this.colors.zeroLine;
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.moveTo(leftM, zeroY);
        ctx.lineTo(rightEdge, zeroY);
        ctx.stroke();
        ctx.restore();

        const toY = (flow) => {
            const clamped = Math.max(flowMin, Math.min(flowMax, flow));
            const ratio = clamped / flowMax; // -1 til +1
            return zeroY - ratio * halfH;
        };

        // C7: Tegn Flow-kurven med min/maks-konvolutt og arealvisning (viser Q_meas)
        this._renderFlowEnvelopeWithArea(ctx, this.flowData, toY, zeroY, leftM, activeW, flowMin, flowMax);

        // Fase 3: Overlegg sann lungeflow (Q_lunge) som stiplet kurve hvis aktivert (A7)
        if (this.showTrueCurves) {
            this._renderOverlayDashedCurve(ctx, this.flowLungData, toY, this.colors.flowLung, leftM, activeW);

            // Diskret etikett
            ctx.save();
            ctx.fillStyle = 'rgba(134, 239, 172, 0.85)';
            ctx.font = '500 10px monospace';
            ctx.textAlign = 'right';
            ctx.fillText('--- Sann Q_lunge (pasient)', rightEdge - 8, topY + 12);
            ctx.fillStyle = this.colors.flow;
            ctx.fillText('— Q_meas (maskin)', rightEdge - 150, topY + 12);
            ctx.restore();
        }
    }

    _drawVolumeTrack(ctx, track, leftM, activeW) {
        const paddingBottom = 10;
        const paddingTop = 22;
        const bottomY = track.top + track.height - paddingBottom;
        const topY = track.top + paddingTop;
        const usableH = bottomY - topY;
        const rightEdge = leftM + activeW;
        const volMax = this.autoScale.vol ? this.dynamicScales.volMax : this.fixedScales.volMax;

        // Tydelig bunnlinje (0 ml)
        ctx.save();
        ctx.strokeStyle = this.colors.zeroLine;
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.moveTo(leftM, bottomY);
        ctx.lineTo(rightEdge, bottomY);
        ctx.stroke();
        ctx.restore();

        const toY = (vol) => {
            const clamped = Math.max(0, Math.min(volMax, vol));
            const ratio = clamped / volMax;
            return bottomY - ratio * usableH;
        };

        // C7: Tegn maskinmålt volumkurve (V_meas) med min/maks-konvolutt (ingen falske klippeindikatorer)
        this._renderEnvelopeWaveform(
            ctx,
            this.volumeData,
            toY,
            this.colors.volume,
            this.colors.volumeFill,
            bottomY,
            leftM,
            activeW
        );

        // Fase 3: Overlegg sant lungevolum (V_lunge) som stiplet kurve hvis aktivert (A7)
        if (this.showTrueCurves) {
            this._renderOverlayDashedCurve(ctx, this.volumeLungData, toY, this.colors.volumeLung, leftM, activeW);

            // Diskret etikett
            ctx.save();
            ctx.fillStyle = 'rgba(165, 243, 252, 0.85)';
            ctx.font = '500 10px monospace';
            ctx.textAlign = 'right';
            ctx.fillText('--- Sant V_lunge (pasient)', rightEdge - 8, topY + 12);
            ctx.fillStyle = this.colors.volume;
            ctx.fillText('— V_meas (maskin)', rightEdge - 150, topY + 12);
            ctx.restore();
        }

        // Fase 7 (Oppgave 7.2): Diskret etikett når maskinmålt volum avviker > 200 ml fra sant volum ved slutt-ekspirasjon
        if (this.volumeDivergenceHold > 0) {
            ctx.save();
            ctx.fillStyle = 'rgba(251, 191, 36, 0.85)';
            ctx.font = '500 10px monospace';
            ctx.textAlign = 'left';
            ctx.fillText('Maskinmålt volum ≠ pasientvolum (lekkasje)', leftM + 10, topY + 12);
            ctx.restore();
        }
    }

    _drawPesTrack(ctx, track, leftM, activeW) {
        const paddingBottom = 10;
        const paddingTop = 22;
        const topY = track.top + paddingTop;
        const bottomY = track.top + track.height - paddingBottom;
        const zeroY = topY + (bottomY - topY) / 2;
        const halfH = (bottomY - topY) / 2;
        const rightEdge = leftM + activeW;
        const pesMax = this.autoScale.pes ? this.dynamicScales.pesMax : this.fixedScales.pesMax;
        const pesMin = -pesMax;

        // Tydelig 0-linje for P_es
        ctx.save();
        ctx.strokeStyle = this.colors.zeroLine;
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.moveTo(leftM, zeroY);
        ctx.lineTo(rightEdge, zeroY);
        ctx.stroke();
        ctx.restore();

        const toY = (pes) => {
            const clamped = Math.max(pesMin, Math.min(pesMax, pes));
            const ratio = clamped / pesMax; // -1 til +1
            return zeroY - ratio * halfH;
        };

        // Tegn P_es-kurven med min/maks-konvolutt og magenta arealfylling
        this._renderFlowEnvelopeWithArea(
            ctx,
            this.pesData,
            toY,
            zeroY,
            leftM,
            activeW,
            pesMin,
            pesMax,
            this.colors.pes,
            this.colors.pesFill,
            this.colors.pesFill
        );
    }

    _renderPesTrack(ctx, track, leftM, activeW) {
        this._drawPesTrack(ctx, track, leftM, activeW);
    }

    // C7 & C9: Tegner min/maks-konvolutt for Paw eller Volum med klippe-indikator
    _renderEnvelopeWaveform(ctx, data, toYFn, strokeColor, fillColor, baselineY, leftM, activeW, minLimit, maxLimit) {
        const sweepX = this.sweepX;
        const eraseEnd = (sweepX + this.eraseWidth) % activeW;

        ctx.save();
        ctx.lineWidth = 0.8;
        ctx.strokeStyle = strokeColor;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';

        const drawSegment = (fromX, toX) => {
            if (fromX >= toX) return;

            // 1. Fylling mot grunnlinjen / 0-linjen
            if (fillColor) {
                ctx.save();
                ctx.fillStyle = fillColor;
                ctx.beginPath();
                let started = false;
                for (let x = fromX; x <= toX; x++) {
                    const pt = data[x];
                    if (pt) {
                        const screenX = leftM + x;
                        const screenY = toYFn(pt.last);
                        if (!started) {
                            ctx.moveTo(screenX, baselineY);
                            ctx.lineTo(screenX, screenY);
                            started = true;
                        } else {
                            ctx.lineTo(screenX, screenY);
                        }
                    }
                }
                if (started) {
                    ctx.lineTo(leftM + toX, baselineY);
                    ctx.closePath();
                    ctx.fill();
                }
                ctx.restore();
            }

            // 2. Selve kurvelinjen med min/maks vertikalstrek (C7)
            ctx.beginPath();
            let drawing = false;
            const clippedPoints = [];

            for (let x = fromX; x <= toX; x++) {
                const pt = data[x];
                if (!pt) {
                    drawing = false;
                    continue;
                }

                const screenX = leftM + x;
                const yMin = toYFn(pt.max); // Toppverdi (høyere tall = mindre Y)
                const yMax = toYFn(pt.min); // Bunnverdi (lavere tall = større Y)
                const yLast = toYFn(pt.last);

                // C9: Registrer klipping hvis verdien overskrider skalaen i låst modus
                if (maxLimit !== undefined && pt.max > maxLimit + 0.5) {
                    clippedPoints.push({ x: screenX, y: toYFn(maxLimit), dir: 'top' });
                }
                if (minLimit !== undefined && pt.min < minLimit - 0.5) {
                    clippedPoints.push({ x: screenX, y: toYFn(minLimit), dir: 'bottom' });
                }

                // C7: Der maks - min > 1 piksel, tegn vertikal strek for å fange opp spiken
                if (Math.abs(yMax - yMin) > 1.2) {
                    if (!drawing) {
                        ctx.moveTo(screenX, yMin);
                        drawing = true;
                    } else {
                        ctx.lineTo(screenX, yMin);
                    }
                    ctx.lineTo(screenX, yMax);
                    ctx.lineTo(screenX, yLast);
                } else {
                    if (!drawing) {
                        ctx.moveTo(screenX, yLast);
                        drawing = true;
                    } else {
                        ctx.lineTo(screenX, yLast);
                    }
                }
            }
            if (drawing) {
                ctx.stroke();
            }

            // C9: Tegn visuelle klippe-markører
            if (clippedPoints.length > 0) {
                this._renderClipMarkers(ctx, clippedPoints);
            }
        };

        if (sweepX + this.eraseWidth < activeW) {
            drawSegment(0, Math.floor(sweepX));
            drawSegment(Math.floor(sweepX + this.eraseWidth), activeW - 1);
        } else {
            drawSegment(Math.floor(eraseEnd), Math.floor(sweepX));
        }

        ctx.restore();
    }

    // C7 & C9: Tegner Flow- eller P_es-kurve med min/maks-konvolutt og distinkt arealfylling (+/-)
    _renderFlowEnvelopeWithArea(ctx, data, toYFn, zeroY, leftM, activeW, minLimit, maxLimit, strokeColor = this.colors.flow, fillPos = this.colors.flowFillPos, fillNeg = this.colors.flowFillNeg) {
        const sweepX = this.sweepX;
        const eraseEnd = (sweepX + this.eraseWidth) % activeW;

        ctx.save();
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';

        const drawSegment = (fromX, toX) => {
            if (fromX >= toX) return;

            // 1. Tegn areal-fylling (over og under 0-linje)
            for (let x = fromX; x <= toX; x++) {
                const pt = data[x];
                if (pt && Math.abs(pt.last) > 0.5) {
                    const screenX = leftM + x;
                    const screenY = toYFn(pt.last);

                    if (pt.last > 0) {
                        ctx.fillStyle = fillPos;
                    } else {
                        ctx.fillStyle = fillNeg;
                    }
                    ctx.fillRect(screenX, Math.min(zeroY, screenY), 1.2, Math.abs(screenY - zeroY));
                }
            }

            // 2. Tegn selve kurvelinjen med min/maks-konvolutt
            ctx.beginPath();
            ctx.strokeStyle = strokeColor;
            ctx.lineWidth = 0.8;
            let drawing = false;
            const clippedPoints = [];

            for (let x = fromX; x <= toX; x++) {
                const pt = data[x];
                if (!pt) {
                    drawing = false;
                    continue;
                }

                const screenX = leftM + x;
                const yMin = toYFn(pt.max);
                const yMax = toYFn(pt.min);
                const yLast = toYFn(pt.last);

                // C9: Klippeindikator
                if (maxLimit !== undefined && pt.max > maxLimit + 0.5) {
                    clippedPoints.push({ x: screenX, y: toYFn(maxLimit), dir: 'top' });
                }
                if (minLimit !== undefined && pt.min < minLimit - 0.5) {
                    clippedPoints.push({ x: screenX, y: toYFn(minLimit), dir: 'bottom' });
                }

                if (Math.abs(yMax - yMin) > 1.2) {
                    if (!drawing) {
                        ctx.moveTo(screenX, yMin);
                        drawing = true;
                    } else {
                        ctx.lineTo(screenX, yMin);
                    }
                    ctx.lineTo(screenX, yMax);
                    ctx.lineTo(screenX, yLast);
                } else {
                    if (!drawing) {
                        ctx.moveTo(screenX, yLast);
                        drawing = true;
                    } else {
                        ctx.lineTo(screenX, yLast);
                    }
                }
            }
            if (drawing) {
                ctx.stroke();
            }

            if (clippedPoints.length > 0) {
                this._renderClipMarkers(ctx, clippedPoints);
            }
        };

        if (sweepX + this.eraseWidth < activeW) {
            drawSegment(0, Math.floor(sweepX));
            drawSegment(Math.floor(sweepX + this.eraseWidth), activeW - 1);
        } else {
            drawSegment(Math.floor(eraseEnd), Math.floor(sweepX));
        }

        ctx.restore();
    }

    // C9: Tydelig klippe-indikator ved akselås (viser at kurven overskrider skalaen)
    _renderClipMarkers(ctx, clippedPoints) {
        ctx.save();
        ctx.fillStyle = this.colors.clipIndicator;
        ctx.strokeStyle = this.colors.clipIndicator;
        ctx.lineWidth = 1.5;

        clippedPoints.forEach(p => {
            // Liten lysende trekant/pil ved kanten
            ctx.beginPath();
            if (p.dir === 'top') {
                ctx.moveTo(p.x - 2.5, p.y + 5);
                ctx.lineTo(p.x + 2.5, p.y + 5);
                ctx.lineTo(p.x, p.y);
            } else {
                ctx.moveTo(p.x - 2.5, p.y - 5);
                ctx.lineTo(p.x + 2.5, p.y - 5);
                ctx.lineTo(p.x, p.y);
            }
            ctx.closePath();
            ctx.fill();
        });
        ctx.restore();
    }

    // Tegner overlagt stiplet kurve (A7: Sann lungeflow / volum)
    _renderOverlayDashedCurve(ctx, data, toYFn, strokeColor, leftM, activeW) {
        const sweepX = this.sweepX;
        const eraseEnd = (sweepX + this.eraseWidth) % activeW;

        ctx.save();
        ctx.lineWidth = 0.7;
        ctx.strokeStyle = strokeColor;
        ctx.setLineDash([4, 4]);
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';

        const drawSegment = (fromX, toX) => {
            if (fromX >= toX) return;
            let drawing = false;

            ctx.beginPath();
            for (let x = fromX; x <= toX; x++) {
                const pt = data[x];
                if (pt) {
                    const screenX = leftM + x;
                    const screenY = toYFn(pt.last);
                    if (!drawing) {
                        ctx.moveTo(screenX, screenY);
                        drawing = true;
                    } else {
                        ctx.lineTo(screenX, screenY);
                    }
                } else {
                    drawing = false;
                }
            }
            ctx.stroke();
        };

        if (sweepX + this.eraseWidth < activeW) {
            drawSegment(0, Math.floor(sweepX));
            drawSegment(Math.floor(sweepX + this.eraseWidth), activeW - 1);
        } else {
            drawSegment(Math.floor(eraseEnd), Math.floor(sweepX));
        }

        ctx.restore();
    }

    // D3: Tegner de 4 entydige markørtypene (▲, △, ⨂, ■)
    _renderTriggerMarks(ctx, yPos, leftM) {
        ctx.save();
        const size = 5.5;

        for (let x = 0; x < this.activeWidth; x++) {
            const m = this.markerData[x];
            if (!m) continue;

            const screenX = leftM + x;
            const type = m.type || 'assist';

            if (type === 'assist' || type === 'double') {
                // 1. Fylt trekant ▲ (Assistert / pasientutløst pust)
                ctx.fillStyle = this.colors.triggerMark;
                ctx.beginPath();
                ctx.moveTo(screenX, yPos - size);
                ctx.lineTo(screenX - size * 0.85, yPos + size * 0.65);
                ctx.lineTo(screenX + size * 0.85, yPos + size * 0.65);
                ctx.closePath();
                ctx.fill();
            } else if (type === 'missed') {
                // 2. Åpen trekant △ (Mislykket pasientinnsats / missed effort)
                ctx.strokeStyle = this.colors.triggerMark;
                ctx.lineWidth = 1.8;
                ctx.beginPath();
                ctx.moveTo(screenX, yPos - size);
                ctx.lineTo(screenX - size * 0.85, yPos + size * 0.65);
                ctx.lineTo(screenX + size * 0.85, yPos + size * 0.65);
                ctx.closePath();
                ctx.stroke();
            } else if (type === 'auto') {
                // 3. Trekant med kryss ⨂ (Autotrigger - pust uten pasientinnsats)
                ctx.strokeStyle = this.colors.triggerMark;
                ctx.lineWidth = 1.6;
                ctx.beginPath();
                ctx.moveTo(screenX, yPos - size);
                ctx.lineTo(screenX - size * 0.85, yPos + size * 0.65);
                ctx.lineTo(screenX + size * 0.85, yPos + size * 0.65);
                ctx.closePath();
                ctx.stroke();

                // Kryss inne i / over trekanten
                const cs = size * 0.45;
                const cy = yPos + size * 0.1;
                ctx.beginPath();
                ctx.moveTo(screenX - cs, cy - cs);
                ctx.lineTo(screenX + cs, cy + cs);
                ctx.moveTo(screenX + cs, cy - cs);
                ctx.lineTo(screenX - cs, cy + cs);
                ctx.stroke();
            } else if (type === 'mandatory') {
                // 4. Kvadrat ■ (Maskinutløst backup-pust)
                ctx.fillStyle = this.colors.triggerMark;
                const half = size * 0.7;
                ctx.fillRect(screenX - half, yPos - half, half * 2, half * 2);
            }
        }
        ctx.restore();
    }

    // Tegner glidende slettesone foran kurvene (selve den vertikale streken er fjernet)
    _drawSweepBar(ctx, h, leftM, activeW) {
        const sx = leftM + this.sweepX;

        ctx.save();
        
        // 1. Slett-sone foran sveipelinjen
        const gradient = ctx.createLinearGradient(sx, 0, sx + this.eraseWidth, 0);
        gradient.addColorStop(0, 'rgba(8, 13, 26, 0.98)');
        gradient.addColorStop(1, 'rgba(8, 13, 26, 0.0)');
        
        ctx.fillStyle = gradient;
        ctx.fillRect(sx, 0, Math.min(this.eraseWidth, (leftM + activeW) - sx), h);

        ctx.restore();
    }

    // Hjelpefunksjon for å generere pene aksetall
    _calculateTicks(min, max, targetCount) {
        const step = Math.ceil((max - min) / targetCount / 5) * 5 || 5;
        const ticks = [];
        for (let v = max; v >= min; v -= step) {
            ticks.push(v);
        }
        if (ticks[ticks.length - 1] !== min) {
            ticks.push(min);
        }
        return ticks;
    }
}

// Gjør tilgjengelig globalt
window.WaveformRenderer = WaveformRenderer;
