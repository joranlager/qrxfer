# QR-overføring 6 (qrxfer)

Sender et bilde fra én enhet til en annen kun via skjerm og kamera. Ingen server, ingen nettverk under
overføringen: alt kjører i nettleseren.

## Slik fungerer det

**Sender**
- Velg et bilde. Det kan komprimeres til JPEG eller WebP (maks bredde/høyde og kvalitet kan velges), eller
  sendes uendret som originalfil.
- Filen pakkes med navn, type, størrelse og CRC-32 i én strøm, som deles i blokker på valgt størrelse
  (standard 380 byte).
- Avspillingen viser pakker med QR-koder (standard 10 om gangen, 300 ms per pakke) i fullskjerm, etter en
  nedtelling (standard 5 s) så mottakeren rekker å sikte.
- Først sendes alle datakodene én gang. Deretter sendes bare paritetskoder, helt til du stopper.

**Mottaker**
- Kameraet leser alle QR-kodene i hvert bilde. Dekoderen kjører i Web Workers (zxing-cpp, WebAssembly).
- Hver mottatt kode er en ligning. Mottakeren løser ligningene fortløpende, så en tapt kode kan erstattes av
  en hvilken som helst paritetskode. Ingen kode må vises på nytt i en bestemt rekkefølge.
- Når alt er løst, sjekkes CRC-32 og bildet vises med **Del / Lagre** og **Last ned**.
- Mottakeren viser prosent, overføringstid og MB/s, hvor mange koder som ble lest direkte, og hvor mange
  som ble gjenopprettet med paritet. Et kart viser dette per kode: grønn lest direkte, gul gjenopprettet,
  lys gul paritet mottatt, grå mangler.

## Formatet

Hver QR-kode bærer ett symbol med 22 byte overhead (`protocol.js`):

| Felt | Størrelse | Innhold |
|---|---|---|
| magic | 1 | `0x46` (`F`) |
| flagg | 1 | bit 0 = datakode (seed er blokknummeret) |
| overførings-id | 4 | tilfeldig, likt for alle koder i én overføring |
| K | 2 | antall blokker |
| B | 2 | blokkstørrelse |
| streamLen | 4 | lengde på strømmen før padding |
| seed | 4 | blokknummer for datakoder, frø for paritetskoder |
| nyttelast | B | blokkdata |
| CRC-32 | 4 | over alt over |

De første K symbolene er datakoder, én blokk hver. Paritetskoder er XOR av et tilfeldig utvalg blokker over
GF(2), uttrukket fra seedet med mulberry32, så sender og mottaker får samme utvalg. Opptil 1024 blokker
brukes tett (hver blokk med sannsynlighet 1/2); flere blokker bruker 512 tilfeldige blokker per paritetskode.
Mottakeren trenger K pluss noen få koder, uansett hvilke som gikk tapt.

Begrensning: K er lagret som 16 bit, så en overføring kan ha høyst 65 535 blokker. Med standard 380 byte
per kode er det ca. 25 MB; appen varsler hvis det er for mange.

## Kjøre

Kameraet krever HTTPS eller `localhost`.

```bash
cd qrxfer
python3 -m http.server 8000
```

Åpne `http://localhost:8000`. Legg til `?mode=recv` for å åpne direkte i mottaksmodus.

Innstillinger lagres i nettleseren (`localStorage`, nøkkelen `qrsend6-opts`).

## Tips

- Full lysstyrke på avsenderskjermen. Hold mottakeren stødig, så alle QR-kodene i pakken er i bildet.
- Leser mottakeren for få koder: øk tid per pakke, senk byte per QR-kode, eller velg høyere
  kameraoppløsning (1440p eller 4K).
- Feilretting M er standard. Velg Q for mer robusthet, eller L for mest data per kode.
- Esc stopper avspillingen. Pause fryser også nedtellingen.

## Filer

| Fil | Innhold |
|---|---|
| `index.html`, `style.css` | grensesnitt for sending og mottak |
| `app.js` | sender (bilde, pakker, nedtelling), mottaker (kamera, resultat) |
| `protocol.js` | symbolformat, CRC-32, koder (`Encoder`) og dekoder (`Decoder`) |
| `decoder-worker.js` | QR-dekoding i Web Worker med zxing-cpp |
| `vendor/` | `qrcode.mjs` (qrcode-generator), `zxing-reader.js` og `zxing_reader.wasm` (zxing-cpp) |
| `manifest.webmanifest`, `icon.svg` | installerbar web-app |

## Lisenser

- qrcode-generator: MIT, Kazuhiko Arase.
- zxing-wasm: MIT, se `vendor/LICENSE-zxing-wasm.txt`.
