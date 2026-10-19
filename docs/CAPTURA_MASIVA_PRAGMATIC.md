# Captura local por lotes — Pragmatic Play

Esta tarea **no reconoce opciones de compra ni decide ramas automáticamente**. Solo
abre demos públicas, intenta superar la introducción conocida, espera una pantalla
base estable y guarda fotografías listas para clasificación visual humana o asistida.

## Inventario incluido

`catalog/pragmatic-play.json` conserva **733 URLs del catálogo oficial** verificadas
el 19 de octubre de 2026, provenientes del snapshot reproducible
`scripts/fixtures/pragmatic-five-20261019.json`. Incluye **730 publicadas** (incluido
Candy Rush, que se había excluido de la muestra de cinco) y **3 próximas**.
Las futuras se omiten hasta su fecha de lanzamiento. El catálogo es una
**instantánea fechada**, no una afirmación de que continuará completo indefinidamente.

## Ejecución en Windows PowerShell

En la rama del PR #1:

```powershell
git fetch origin
git switch feat/dual-queue-visual-tracing-20261018
git pull --ff-only
npm install
npx playwright install chromium
npm run catalog:check
npm run catalog:capture -- --limit=5 --no-publish
```

Para publicar automáticamente en la rama **catalog-snapshots** del mismo repositorio,
autenticá GitHub CLI una sola vez con permisos **Contents: read/write**:

```powershell
gh auth login
gh auth status
$env:HEADLESS="1"
npm run catalog:capture
```

También funciona con `$env:GH_TOKEN` o `$env:GITHUB_TOKEN` (token con Contents: write).
No imprime ni persiste los tokens. Si falta autenticación, conserva las imágenes
localmente y lo avisa en pantalla. No guardes el token en el repositorio.

Otros comandos:

```powershell
npm run catalog:capture -- --only=candy-rush --limit=1 --no-publish
npm run catalog:capture -- --retry-failed
npm run catalog:capture -- --publish-only
npm run catalog:capture -- --headless --rate=2
```

`--rate` admite **1, 2 o 3**, nunca más de 3 inicios/minuto. Cada nueva
apertura, incluidos los reintentos, reserva un turno en
`data/catalog-rate.json` **antes** de entrar al juego. La restricción sobrevive
reinicios. Solo se ejecuta **una demo a la vez** y existe un lock local para
evitar dos capturadores simultáneos. No ejecutar el scheduler normal (`npm start`)
a la vez: es un proceso distinto que no comparte este limitador.

La preparación hace un máximo de dos intentos por juego y utiliza los mismos
endpoints públicos de demo del proyecto original; no ejecuta compras ni giros.
No se confunde el estado `INTRO` o `UNKNOWN` con un `BASE` validado.

## Archivos resultantes

```text
data/
  catalog.sqlite
  catalog-rate.json
  catalog-exports/
    pragmatic-20261019/
      manifest.json
      shots/<slug>.jpg
      review/<slug>.jpg
      metadata/<slug>.json
      sheets/sheet-0001.jpg ...
```

- `ready`: estado base estable, captura disponible en SQLite y galería.
- `review`: inicio no resuelto o base no estable. Conserva una foto separada
  para que un operador decida cómo avanzar. No se presenta como lista.
- `failed`: error de carga o captura; el motivo queda en el manifiesto.
- `upcoming`: lanzamiento futuro, no ejecutado.

Las hojas de contacto reúnen cuatro capturas por imagen, con el slug de cada
juego, para hacer más rápida la clasificación por lotes. Las fotografías
individuales mantienen la resolución original y la metadata incluye su
`taskId`, estado, controles y tráfico **sanitizado**.

La publicación remota aparece en
`https://github.com/Shisetsu-Code/Fuzzer-Manual/tree/catalog-snapshots`,
en `runs/pragmatic-20261019/`, junto a `latest.json`.
La rama es **separada** de la PR y empieza como un historial huérfano; no
incorpora cientos de JPEG al historial del código.
El manifiesto se publica por lotes de 6 fotografías, actualizándose hasta la
finalización. Al reiniciar se omiten los `ready` que ya tienen archivo
y `--publish-only` envía los archivos pendientes sin volver a abrir el navegador.

**Nota de privacidad:** el repositorio actual es público; por tanto, las
capturas subidas a `catalog-snapshots` también serán públicas. No usar este
flujo con sesiones de casino de dinero real, credenciales, cookies ni cuentas.
