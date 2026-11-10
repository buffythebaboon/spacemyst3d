# Spacemyst 3D

En multiplayer-skjutare i första person som spelas i webbläsaren, byggd med three.js. Den bygger vidare på textversionen av Spacemyst: samma cybermonster, nivåer och krediter, men nu i realtid i en delad värld. All text i spelet är på engelska.

## Spelet

Alla spelare delar samma värld under en säsong. Världen är fyra sektorer som ligger i ringar runt Mainframe: Cooling Channels, Server Halls, Corrupted Sector och The Core. Varje sektor är full av korruption. När spelarna tillsammans har rensat bort den öppnas porten inåt. Säsongen är vunnen när Mainframe faller. Då startar en nedräkning och en ny säsong börjar med en ny värld. Karaktärerna behåller sin nivå och utrustning mellan säsongerna.

- **Hubbar** (Coolant Plaza, Hall Junction, Quarantine Post) är säkra zoner med black market, uppdragstavla, reparationsstation och en beacon för att resa mellan hubbar.
- **Strid:** sex vapentyper (laser, kniv/blad, plasma, railgun, neutronkanon och Event Horizon), 13 spells på Q/E/R/F och höger musknapp, granater och en dash.
- **Utrustning:** vapen och rustning med fem sällsyntheter och slumpade egenskaper, implantat, och 10 sorters drycker som är okända tills någon dricker dem. När en spelare har identifierat en dryck vet alla vad den gör.
- **Utveckling:** nivå 1 till 30, talangträd för Hacker, Soldier och Engineer, uppdrag från tavlan, dagliga utmaningar och 28 achievements.
- **Bossar:** Trojan Goliath, Kernel Guardian, Data Leviathan och Mainframe har egna arenor. Sektorbossarna släpper nyckelkort till sina valv.
- **Händelser:** strömavbrott, utbrott och vandrande bossar (Zero-Day Exploit och Rootkit Dragon) dyker upp då och då.
- **Utforskning:** fällor, falska väggar, gåtor som öppnar valv, kistor och loggfragment.
- **Döden:** du tappar hälften av dina krediter i en datadump där du föll och får tillbaka dem om du hinner fram till den igen.

## Starta spelet på Windows

Dubbelklicka på `Starta Spacemyst.cmd`. Filen installerar paketen första gången (och igen när `package-lock.json` har ändrats), bygger spelet, startar spelservern i ett fönster som heter "Spacemyst 3D server" och öppnar spelet på http://localhost:2567. Node.js måste vara installerat.

Stäng fönstret "Spacemyst 3D server" för att stänga av spelet. Världen sparas innan servern stängs. Om servern redan är igång bygger filen bara om spelet och öppnar det. Efter en uppdatering med ny serverkod behöver du stänga serverfönstret och starta filen igen.

## Kör lokalt

```sh
npm install
npm run dev
```

Öppna http://localhost:5173. Öppna en flik till för att testa multiplayer.

`npm run dev` startar två saker: spelservern på port 2567 och Vite på port 5173. Vite skickar vidare `/ws` till servern. Servern startar om av sig själv när du ändrar i `server/` eller `shared/`.

## Produktion

```sh
npm run build
npm start
```

Servern levererar både spelet och WebSocket-anslutningen på samma port. Det gör att allt kan köras som en enda tjänst, till exempel på Fly.io eller Render. `/health` svarar `ok`.

| Variabel | Standard | Betydelse |
| --- | --- | --- |
| `PORT` | 2567 | Port för HTTP och WebSocket |
| `DATA_DIR` | `./data` | Var konton (`accounts.json`) och världen (`world.json`) sparas. Mappen behöver ligga på en disk som finns kvar mellan omstarter. |
| `WORLD_SEED` | slumpas | Frö för den första säsongens värld. Används bara när `DATA_DIR` är tom. |
| `DEV_COMMANDS` | av | Sätt till `1` för att slå på utvecklarkommandona nedan. Låt bli i produktion. |

## Kontroller

| Tangent | Handling |
| --- | --- |
| WASD | Gå |
| Shift | Spring |
| Mus | Sikta |
| Vänsterklick | Skjut, eller använd det du siktar på (kiosker, kistor, valv, gåtor) |
| Högerklick | Spell 1 |
| Q / E / R / F | Spells 1–4 |
| 1–4 | Snabbplatser för drycker |
| G | Kasta granat |
| X eller mushjulet | Byt vapen |
| Mellanslag | Dash |
| I | Inventarie |
| B | Spellbok |
| N | Talanger |
| M | Karta |
| J | Journal: uppdrag, dagliga utmaningar, loggfragment, bestiarium och achievements |
| Tab | Spelarlista |
| Enter | Chatta |
| Esc | Inställningar, eller stäng den öppna panelen |

### Handkontroll

Spelet fungerar med en Xbox- eller PlayStation-kontroll. Tryck på en knapp på kontrollen så tar den över, och flytta musen för att gå tillbaka till mus och tangentbord. Med kontroll behövs inget klick för att låsa muspekaren.

| Knapp | Handling |
| --- | --- |
| Vänster spak | Gå. Tryck in den för att springa. |
| Höger spak | Sikta. Siktet bromsar lite när det ligger på en fiende. |
| RT | Skjut, eller använd det du siktar på |
| LT / LB / RB / B | Spells 1–4 |
| A | Dash |
| X | Kasta granat |
| Y | Byt vapen |
| Styrkorset | Snabbplatser 1–4 (upp, höger, ner, vänster) |
| Back | Inventarie. LB och RB bläddrar sedan mellan inventarie, spellbok, talanger, karta och journal. |
| Start | Inställningar |
| Höger spak intryckt | Spelarlista |

I panelerna flyttar styrkorset eller vänster spak markeringen, A klickar, X gör det högerklick gör (utrusta, använda, rensa), LT och RT byter flik, höger spak scrollar och B stänger. På inloggningsskärmen loggar A in med det sparade namnet. Under Inställningar finns hastigheten för spaken och om kontrollen ska vibrera.

## Utvecklarkommandon

Med `DEV_COMMANDS=1` kan du skriva de här i chatten:

| Kommando | Vad det gör |
| --- | --- |
| `/purge [sektor]` | Rensar all korruption i en sektor (standard: den du står i) |
| `/level n` | Sätter din nivå |
| `/credits n` | Ger dig krediter |
| `/heal` | Fyller HP och mana |
| `/tp hub0`, `/tp arena0`, `/tp <objekt-id>` eller `/tp x z` | Teleporterar dig |
| `/spawn <nyckel> [antal] [elite]` | Skapar monster 5 m framför dig, till exempel `/spawn byte_mite 3` |
| `/event outage\|outbreak\|zeroday\|rootkit` | Startar en händelse |
| `/season` | Avslutar säsongen om 5 sekunder |
| `/boss` | Återupplivar alla bossar |
| `/give gear\|potions\|grenades\|keycards\|implants` | Släpper saker vid dina fötter |

## Tester

```sh
npm test
npm run typecheck
```

Testerna kör servern utan nätverk: världsgenerering, strid, alla spells, drycker, granater, gåtor, sektorportar, bossar, säsongsbyte, konton, black market, uppdrag, datadumpar och ett fem minuter långt stresstest med tre botar.

## Struktur

- `shared/`: kod som både klient och server använder.
  - `worldgen.ts` och `world.ts`: säsongsvärlden med sektorer, hubbar, arenor, fällor och gåtor.
  - `grid.ts`: kollision och siktlinje.
  - `monsters.ts`, `spells.ts`, `items.ts`, `talents.ts`, `quests.ts`, `achievements.ts`, `lore.ts`: speldata.
  - `character.ts`: karaktärens värden och nivåer.
  - `protocol.ts`: meddelandena mellan klient och server.
- `server/`: den auktoritativa spelservern. Den simulerar allt 20 gånger per sekund och skickar läget till klienterna.
  - `index.ts`: HTTP, WebSocket och sparning.
  - `game.ts`: spelloopen och spelarna.
  - `ai.ts`: monstrens beteenden och bossarna.
  - `combat.ts` och `actions.ts`: skada, statusar, spells, granater och projektiler.
  - `progress.ts`: loot, uppdrag, black market, talanger och achievements.
  - `worldstate.ts`: korruption, portar, valv, gåtor, händelser, säsonger och utvecklarkommandon.
  - `store.ts`: konton och världen på disk.
- `client/src/`: three.js-klienten.
  - `main.ts`: spelloopen, styrning, sikte och efterbehandling.
  - `world.ts`, `props.ts`, `dynamic.ts`, `textures.ts`: världens geometri, föremål, dörrar och texturer.
  - `entities.ts`: monster och andra spelare.
  - `models.ts`: monstrens 3D-modeller och animationer. 14 monster laddas som målade modeller från `client/public/models/`; Packet Swarm, Null-Pointer Phantom och Singularity byggs av three.js-former i koden. Samma animationer driver båda sorterna.
  - `gallery.ts` och `client/models.html`: ett galleri med alla monstermodeller, bara på utvecklingsservern (`/models.html`, `?kind=byte_mite`, `?painted=0`).
  - `weapons.ts`: vapnen i handen.
  - `fx.ts`: strålar, explosioner, partiklar och skadesiffror.
  - `hud.ts` och `ui.ts`: gränssnittet, minikartan och panelerna.
  - `audio.ts`: syntetiserade ljud och musikspelaren.
  - `songs.ts`: musiken, skriven som steg-mönster för syntesen. Hubben och varje sektor har en egen låt med lager som tonas in när det blir strid, och varje boss har ett eget tema. Syntesen spelar en låt tills dess inspelning har laddats, och alltid om låten saknar inspelning.
  - `art/`: ikoner och monsterbilder som ritas i koden.

Monsterbilderna i `client/public/monsters/` kommer från första versionen och används i bestiariet. I själva spelet är alla monster 3D-modeller.

De målade modellerna i `client/public/models/` är spelets egna modeller, ombyggda i Blender och målade med ComfyUI (Krea 2). ComfyUI har målat om varje modell från fem vinklar, och målningarna är projicerade tillbaka på modellen. Nodnamn, ben och materialnamn är desamma som i koden, så animationerna och färgningen vid träffar fungerar som förut.

Musiken i `client/public/music/` är gjord med YuE och listas i `manifest.json`. Hubben har en låt. Varje sektor har en lugn version och en stridsversion av samma notplan, som spelar i takt och tonas över efter hur hård striden är. Bossarna har var sitt tema, utom Trojan Goliath, vars tema spelas av syntesen.
