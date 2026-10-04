# Spacemyst 3D

En multiplayer-labyrintskjutare i webbläsaren, byggd med three.js. Det är en uppföljare till textversionen av Spacemyst: samma cybermonster, nivåer och krediter, men nu i första person med realtidsstrider.

## Kör lokalt

```sh
npm install
npm run dev
```

Öppna http://localhost:5173. Öppna en flik till för att testa multiplayer.

`npm run dev` startar två saker: spelservern på port 2567 och Vite på port 5173. Vite skickar vidare `/ws` till servern.

## Produktion

```sh
npm run build
npm start
```

Servern levererar både spelet och WebSocket-anslutningen på samma port (`PORT`, standard 2567). Det gör att allt kan köras som en enda tjänst, till exempel på Fly.io eller Render.

| Variabel | Standard | Betydelse |
| --- | --- | --- |
| `PORT` | 2567 | Port för HTTP och WebSocket |
| `WORLD_ROOMS` | 24 | Labyrintens storlek i rum per sida |
| `WORLD_SEED` | 1337 | Frö för labyrinten |
| `MONSTERS` | 70 | Antal monster samtidigt |

## Kontroller

| Tangent | Handling |
| --- | --- |
| WASD | Gå |
| Shift | Spring |
| Mus | Sikta |
| Vänsterklick | Skjut |
| Högerklick / Q | Överladdat skott, dubbel skada (10 mana) |
| E | Nanoreparation, +35 % HP (8 mana) |
| Enter | Chatta |
| Tab | Visa spelare |

## Struktur

- `shared/`: kod som både klient och server använder (konstanter, monsterdata, labyrintgenerator och nätverksprotokoll).
- `server/index.ts`: auktoritativ spelserver. Den simulerar monster-AI, kontrollerar rörelser, siktlinje och skada, och skickar läget till alla klienter 20 gånger per sekund.
- `client/src/`: three.js-klienten.
  - `world.ts`: labyrintens geometri.
  - `entities.ts`: monster och andra spelare.
  - `effects.ts`: lasrar, partiklar och skadesiffror.
  - `gun.ts`: vapnet.
  - `audio.ts`: syntljud.
  - `hud.ts`: gränssnitt och minikarta.
  - `main.ts`: spelloopen.

Monsterbilderna i `client/public/monsters/` kommer från första versionen. Monster utan bild ritas proceduriellt.

Alla skript finns i `package.json`. `npm run typecheck` kör en TypeScript-kontroll.
