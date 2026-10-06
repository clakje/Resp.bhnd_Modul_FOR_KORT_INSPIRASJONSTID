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
| `lag-rise-zip.js` | Lager zip-filen for opplasting i Articulate Rise |

Motorene gjenbrukes uforandret fra mappen over: `../simulator.js`, `../renderer.js`, `../style.css`.

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

Kopier `style.css`, `simulator.js` og `renderer.js` hit og bytt `../` mot `./` i de tre
lenkene øverst i `index.html`. Da kan mappen deles ut som den er.

## Articulate Rise

Kjør `node lag-rise-zip.js` og last opp zip-filen i en **kodeblokk** i Rise.
Rise krever at `index.html` ligger i roten av zip-filen (ikke i en undermappe);
skriptet tar bare med filene nettleseren trenger.

Tilpasninger for iframe-visning:

- Kurveflaten har fast høyde, og `renderer.resizeCanvas()` tegner bare på nytt når
  størrelsen faktisk endres — ellers ble kurvene tømt hver gang Rise justerte iframe-høyden.
- Fasit-dialog og varsler vises øverst, siden iframen kan være høyere enn skjermen.
- Siden sender `postMessage({ type: 'complete' })` til Rise ved oppstart, så blokken
  ikke stopper deltakeren hvis den er satt som krav for å gå videre.

## Hva deltakeren får justere

Bare parameterne som står i `uiConfig.visibleControls`. Definisjonen (etikett, type,
enhet, min/maks/steg, standardverdi og valg) hentes fra `uiConfig.controls`. Alt annet
står låst på verdien `initialState` ga det. Støttede typer: `range`, `checkbox`,
`buttons` og `select`, med valgfri av/på-boks (`enabledKey`).

## Info-dialog

Dialogen vises over spilleren når siden åpnes, og kan åpnes igjen med **Info**-knappen
i verktøylinjen over kurvene. Den lukkes med ✕, «Lukk og se scenariet» eller Escape
(ikke ved klikk utenfor). Simuleringen går i bakgrunnen mens dialogen er åpen.

- **Tekst:** rediger direkte i `index.html` (blokken `id="infoOverlay"`).
- **Bilde:** legg det i `bilder/scenario-oversikt.png`. Mangler filen, vises en plassholder.
  `lag-rise-zip.js` tar med alle bilder i `bilder/`.
- **Forklaring:** knappen «Forklaring av kurver og symboler» viser kurvene, triggermarkørene
  (▲ △ ⨂ ■), samspill-tallene og knappene. Teksten står i blokken `id="infoLegendView"`.

## Layout

Måleverdier, samspill pasient–respirator og innstillingene står i et sidepanel til venstre,
kurvene til høyre. Kurveflaten får samme høyde som sidepanelet (`fitCanvasToPanel()` i
`app.js`, minst 560 px), så kolonnene slutter likt uansett hvor mange innstillinger scenariet
har. Høyden avhenger bare av panelets innhold, ikke av iframen. Under 900 px bredde legges
panelet under kurvene. P<sub>es</sub>-sporet vises fra start.

**Samspill pasient–respirator** (siste 60 s): utløste pust er simulatorens telling av
pasientutløste pust (`measured.rrSpont`), mislykkede pustforsøk telles i `state.efforts`, og
pasientens pustforsøk er summen. Asynkroniindeksen er `measured.asynchronyIndex`; over 10 %
markeres som betydelig asynkroni.

## Hovedmeny (dummy)

Knappen «Hovedmeny» øverst til venstre er ikke koblet til noe ennå. Den kaller
`goToMainMenu()` i `app.js`, som sender hendelsen `scenario:hovedmeny` på `window` og viser
et varsel. Bytt ut innholdet i funksjonen når scenariene bygges inn i hovedprogrammet.

## Kun PC

På skjermer smalere enn 760 px og på berøringsenheter uten mus vises et varsel om at denne
delen av kurset må tas på PC. Deltakeren kan lukke det med «Vis likevel».
