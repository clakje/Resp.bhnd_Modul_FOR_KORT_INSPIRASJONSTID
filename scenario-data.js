/**
 * scenario-data.js — AUTOGENERERT av bygg-scenario-data.js. Ikke rediger for hånd.
 * Kilde: scenario.json
 *
 * Denne filen har forrang: finnes den, bruker spilleren den i stedet for å
 * hente scenario.json. Kjør skriptet på nytt etter endringer i scenario.json,
 * eller slett filen for å la spilleren hente JSON-en over nett.
 */
window.SCENARIO_DATA = {
  "schemaVersion": "1.0",
  "generator": "Respirator Scenario-Generator",
  "exportedAt": "2026-09-21T10:29:25.814Z",
  "meta": {
    "id": "for_kort_inspirasjonstid",
    "title": "For kort inspirasjonstid",
    "description": "Inspirasjonstiden er for kort, pasienten gir et forsøk på å fortsette inspirasjonen. Pasientens forsøk medfører dobbelt støttede inspirasjon på noen pust og en positiv bue i flow-kurven ved ekspirasjon.",
    "author": "Petter",
    "learningObjectives": [
      "Gjenkjenne for kort inspirasjonstid."
    ],
    "answerKey": {
      "optimalSettings": "Optimale innstillinger vil i dette tilfellet være fra 30% og under på inspiratorisk avslutning. Man kan også gå ned på trykkstøtten men da må man være obs på at pasienten får nok tidevolum.",
      "expectedResponse": "Når optimal innstilling er satt til 30% eller under vil dobbeltstøttede innspust avta. En ekstra positiv bølge i begynnelsen av ekspirasjonen til flow-kurven vil også avta.",
      "notes": "Under 30% avslutning (cykling) er fasit. Hvis man går ned på  trykkstøtten vil tidevolumet bli for lavt."
    }
  },
  "initialState": {
    "machine": {
      "mode": "PS",
      "ipap": 10,
      "epap": 5,
      "vcTidalVolume": 500,
      "vcPeakFlow": 60,
      "vcFlowPattern": "constant",
      "inspPause": 0,
      "tiSet": 2,
      "backupRate": 12,
      "stActive": false,
      "fio2": 30,
      "rr": 12,
      "triggerMode": "flow",
      "trigger": 2,
      "cycling": 65,
      "tiMax": 2,
      "riseTime": 100,
      "leak": 0
    },
    "patient": {
      "height": 175,
      "gender": "male",
      "compliance": 34,
      "resistance": 7,
      "rrSpont": 20,
      "pmus": 4.5,
      "responsiveness": 10,
      "responsivePmus": true,
      "pmusOffset": 0,
      "tiNeural": 1.4,
      "kobleTiNeural": false,
      "triseNeural": 0.5,
      "tholdNeural": 0.15,
      "tdecayNeural": 0.35,
      "pmusExp": 0.5,
      "recoil": 5,
      "flowLimitation": 0,
      "criticalClosingPressure": 0,
      "flowConductance": 1,
      "peepStenting": 0,
      "expRatio": 1,
      "variability": 20,
      "cardiacArtifact": 0,
      "stressIndex": 1,
      "stressIndexEnabled": false,
      "uip": 30,
      "uipEnabled": false,
      "airwayOpening": 0,
      "recruitedVolume": 0,
      "entrainmentRatio": 1,
      "entrainmentEnabled": false
    },
    "alarms": {
      "apneaDelay": 27,
      "alarmLeak": 40,
      "alarmLowVt": 100,
      "alarmHighVt": 1000,
      "alarmLowRr": 0,
      "alarmHighRr": 50,
      "alarmHighPpeak": 40
    }
  },
  "uiConfig": {
    "visibleControls": [
      "ipap",
      "epap",
      "fio2",
      "cycling",
      "riseTime"
    ],
    "controls": [
      {
        "key": "ipap",
        "group": "machine",
        "label": "IPAP / inspiratorisk trykk",
        "type": "range",
        "unit": "cmH₂O",
        "default": 10,
        "min": 8,
        "max": 30,
        "step": 1
      },
      {
        "key": "epap",
        "group": "machine",
        "label": "EPAP / PEEP",
        "type": "range",
        "unit": "cmH₂O",
        "default": 5,
        "min": 3,
        "max": 15,
        "step": 1
      },
      {
        "key": "fio2",
        "group": "machine",
        "label": "FiO₂",
        "type": "range",
        "unit": "%",
        "default": 30,
        "min": 21,
        "max": 100,
        "step": 1
      },
      {
        "key": "cycling",
        "group": "machine",
        "label": "Cycling / E-sense",
        "type": "range",
        "unit": "%",
        "default": 65,
        "min": 5,
        "max": 90,
        "step": 5
      },
      {
        "key": "riseTime",
        "group": "machine",
        "label": "Stigetid (rise time)",
        "type": "range",
        "unit": "ms",
        "default": 100,
        "min": 50,
        "max": 900,
        "step": 25
      }
    ]
  }
};
