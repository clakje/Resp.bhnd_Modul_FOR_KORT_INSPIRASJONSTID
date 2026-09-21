# Scenario-spiller (template)

Minimal, gjenbrukbar spiller for scenarier eksportert fra **Respirator Scenario-Generator**.
Spilleren har ingen egne innstillinger — alt kommer fra `scenario.json`.

## Filer

| Fil | Rolle |
|---|---|
| `index.html` | Header + monitor (kurver og måleverdier) + to tomme beholdere |
| `app.js` | Laster scenariet, setter starttilstand og bygger grensesnittet |
| `player.css` | Kun det som kommer i tillegg til generatorens `style.css` |
| `scenario.json` | Scenariet som spilles |
| `scenario-data.js` | Autogenerert kopi av scenariet, så spilleren virker uten webserver |
| `bygg-scenario-data.js` | Lager `scenario-data.js` fra `scenario.json` |

Motorene ligger i samme mappe, uforandret fra generatoren: `simulator.js`, `renderer.js`, `style.css`.

## Lage et nytt scenario

1. Bygg scenariet i generatoren og huk av parameterne deltakeren skal få justere.
2. Eksporter, og legg `<scenario>.json` her som `scenario.json`.
3. Kjør `node bygg-scenario-data.js` for å oppdatere `scenario-data.js`.
4. Åpne `index.html`.

## Hvordan scenariet finnes

Spilleren prøver i tur og orden:

1. `window.SCENARIO_DATA` fra `scenario-data.js` — **har forrang**, og er den eneste måten som virker når siden åpnes rett fra disk (`file://`).
2. `fetch()` av `?scenario=…` i adressen, ellers `scenario.json`. Krever webserver.
3. Filvelger, slik at deltakeren kan åpne en `.json` selv.

Endrer du `scenario.json` uten å kjøre `bygg-scenario-data.js`, fortsetter spilleren
å bruke den gamle `scenario-data.js`. Slett den filen om du vil hente JSON-en over nett.

## Frittstående mappe

Denne mappen er allerede frittstående: `style.css`, `simulator.js` og `renderer.js`
ligger her, og `index.html` peker på dem med `./`. Mappen kan deles ut som den er.

## Hva deltakeren får justere

Bare parameterne som står i `uiConfig.visibleControls`. Definisjonen (etikett, type,
enhet, min/maks/steg, standardverdi og valg) hentes fra `uiConfig.controls`. Alt annet
står låst på verdien `initialState` ga det. Støttede typer: `range`, `checkbox`,
`buttons` og `select`, med valgfri av/på-boks (`enabledKey`).
