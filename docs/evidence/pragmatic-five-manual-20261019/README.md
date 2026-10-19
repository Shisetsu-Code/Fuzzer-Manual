# Prueba manual de compras: cinco juegos de Pragmatic Play

Fecha: 19 de octubre de 2026. Entorno: demos públicas con créditos ficticios.

Se encontraron **6 opciones de compra** y se aceptaron **6/6**. También se activaron y ejecutaron los **2 Ante Bet** observados. Hay evidencia de liquidación para **6/6 tipos de compra**; los intentos individuales se conservan por separado.

## Método y muestra

El operador asistente examinó las capturas del juego y eligió las coordenadas normalizadas de cada acción. Una consola temporal utilizó los métodos existentes de `BrowserEngine`, `CatalogDB`, `clickMark` y captura/traza para ejecutar clics reales. Las decisiones sobre intro, compra, confirmación y continuación fueron manuales. La aceptación se comprobó con la petición observada, HTTP 200, el cargo de créditos y el premio inicial de free spins.

La ejecución de compras fue en Chromium local. HardFire no tenía un agente conectado. El ensayo inicial de detección automática no corresponde a este método y sus tres archivos se retiran del PR. Esta entrega incorpora la muestra y la evidencia; el código de producción probado corresponde al commit `2fd5ee54d3da975652630d9e7ff76ac57b1da97c`, árbol `c87f4c3539fcf111eb90b8c9fb305f9be64d592b`.

Se sortearon cinco juegos sin reemplazo entre 729 demos elegibles del catálogo oficial, después de excluir Candy Rush (ya probado) y tres títulos marcados como próximos. La selección no se filtró por disponer de compras. Se mantuvieron los cinco resultados originales. La semilla, el algoritmo, los 729 candidatos y los controles de página están en la [muestra reproducible](../../../scripts/fixtures/pragmatic-five-20261019.json).

## Inventario observado y ejecutado

Todos los importes siguientes se observaron con una apuesta base total de **$2.00**. El múltiplo se calcula a partir del precio y la apuesta mostrados por la interfaz.

| Juego | Compra visible | Precio demo | Múltiplo | `pur` | Free spins iniciales observados | Aceptación | Liquidación observada |
|---|---|---:|---:|---:|---:|---|---|
| Gates of Valhalla | Buy Free Spins | $200.00 | 100× | `0` | 10 | HTTP 200 y cargo confirmado | `fs_total` → `doCollect`, `na=s` |
| Floating Dragon Wild Horses | Buy Free Spins | $200.00 | 100× | `0` | 15 | HTTP 200 y cargo confirmado | `fs_total` → `doCollect`, `na=s` |
| Floating Dragon Wild Horses | Buy Super Free Spins | $600.00 | 300× | `1` | 15 | HTTP 200 y cargo confirmado | `fs_total` → `doCollect`, `na=s` |
| Sugar Rush Xmas | Buy Free Spins | $200.00 | 100× | `0` | 10 | HTTP 200 y cargo confirmado | `fs_total` → `doCollect`, `na=s` |
| Lucky Tiger Gold | No se observó una compra en el cliente revisado | — | — | — | — | No aplica | No aplica |
| Cheetah Wild | Free Spins — Standard | $200.00 | 100× | `0` | 8, 15 | HTTP 200 y cargo confirmado | `fs_total` → `doCollect`, `na=s` |
| Cheetah Wild | Super Free Spins — minimum level 3 | $1,000.00 | 500× | `1` | 15 | HTTP 200 y cargo confirmado | `fs_total` → `doCollect`, `na=s` |

### Apuestas mejoradas

| Juego | Control | OFF | ON | Múltiplo | Petición observada al girar |
|---|---|---:|---:|---:|---|
| Floating Dragon Wild Horses | Higher Chance To Win Feature | $2.00 | $3.00 | 1.5× | `action=doSpin,c=0.2,l=10,bl=1`; sin `pur`; HTTP 200 |
| Cheetah Wild | Higher Chance To Win Feature | $2.00 | $5.00 | 2.5× | `action=doSpin,c=0.1,l=20,bl=1`; sin `pur`; HTTP 200 |

En Floating Dragon, ambas compras se mostraron deshabilitadas con Ante Bet ON y se volvieron a habilitar al desactivarlo. En Cheetah se verificó también el retorno de ON a OFF antes de comprar Super.

## Peticiones de compra

Todas las compras observadas usaron POST al host `demogamesfree.pragmaticplay.net`. Los campos siguientes proceden de los clics reales y de la lista permitida del trazador. El registro conserva campos seleccionados de petición/respuesta, no un volcado completo de cabeceras o credenciales.

| Juego | Ruta de servicio | Campos de compra observados |
|---|---|---|
| Gates of Valhalla | `/hub-demo/ge/v3/gameService` | `action=doSpin,c=0.1,l=10,pur=0` |
| Floating Dragon Wild Horses | `/hub-demo/ge/v4/gameService` | `action=doSpin,c=0.2,l=10,bl=0,pur=0`; `action=doSpin,c=0.2,l=10,bl=0,pur=1` |
| Sugar Rush Xmas | `/hub-demo/ge/v4/gameService` | `action=doSpin,c=0.1,l=20,pur=0` |
| Cheetah Wild | `/hub-demo/ge/v5/gameService` | `action=doSpin,c=0.1,l=20,bl=0,pur=0`; `action=doSpin,c=0.1,l=20,bl=0,pur=1` |

La base se toma del total visible. No se deduce una fórmula universal `c × l`: por ejemplo, Gates envió `l=10` pero respondió `l=20`, y los Ante Bet alteraron el `l` de respuesta. Sólo se documentan los valores probados.

## Capturas de las opciones

| Juego | Pantalla de compra o base revisada |
|---|---|
| Gates of Valhalla | [Botón y precio](sessions/gates-of-valhalla-1/shots/task-1.jpg) · [Confirmación](sessions/gates-of-valhalla-1/shots/task-2.jpg) |
| Floating Dragon Wild Horses | [Dos compras y Ante Bet](sessions/floating-dragon-wild-horses-1/shots/task-2.jpg) · [Confirmación normal](sessions/floating-dragon-wild-horses-1/shots/task-8.jpg) · [Confirmación Super](sessions/floating-dragon-wild-horses-2/shots/task-3.jpg) |
| Sugar Rush Xmas | [Botón y precio](sessions/sugar-rush-xmas-1/shots/task-2.jpg) · [Confirmación](sessions/sugar-rush-xmas-1/shots/task-3.jpg) |
| Lucky Tiger Gold | [Base](sessions/lucky-tiger-gold-2/shots/task-2.jpg) · [Menú](sessions/lucky-tiger-gold-2/shots/task-3.jpg) · [Reglas de respin](sessions/lucky-tiger-gold-1/shots/manual-scroll-10.jpg) · [Reglas de bonus](sessions/lucky-tiger-gold-1/shots/manual-scroll-18.jpg) · [Fin de reglas específicas](sessions/lucky-tiger-gold-1/shots/manual-scroll-26.jpg) |
| Cheetah Wild | [Menú con dos compras](sessions/cheetah-wild-1/shots/task-3.jpg) · [Confirmación normal](sessions/cheetah-wild-1/shots/task-4.jpg) · [Confirmación Super](sessions/cheetah-wild-2/shots/task-7.jpg) |

## Trazabilidad por sesión

`trace.json` enlaza las tareas padre/hijo, marcas del operador, capturas y eventos. Las coordenadas `x,y` están normalizadas respecto a la fotografía. Las capturas se conservan sin editar. El [resultado estructurado](results.json) agrupa las pruebas por opción; [las notas del operador](operator-notes/) añaden las observaciones visuales y recorridos de cada juego.

| Sesión | Marcas manuales | Eventos de juego | Registro |
|---|---:|---:|---|
| gates-of-valhalla-1 | 4 | 14 | [Traza y capturas](sessions/gates-of-valhalla-1/trace.json) |
| floating-dragon-wild-horses-1 | 10 | 19 | [Traza y capturas](sessions/floating-dragon-wild-horses-1/trace.json) |
| floating-dragon-wild-horses-2 | 5 | 18 | [Traza y capturas](sessions/floating-dragon-wild-horses-2/trace.json) |
| lucky-tiger-gold-1 | 2 | 1 | [Traza y capturas](sessions/lucky-tiger-gold-1/trace.json) |
| lucky-tiger-gold-2 | 5 | 1 | [Traza y capturas](sessions/lucky-tiger-gold-2/trace.json) |
| sugar-rush-xmas-1 | 7 | 28 | [Traza y capturas](sessions/sugar-rush-xmas-1/trace.json) |
| cheetah-wild-1 | 5 | 14 | [Traza y capturas](sessions/cheetah-wild-1/trace.json) |
| cheetah-wild-2 | 12 | 29 | [Traza y capturas](sessions/cheetah-wild-2/trace.json) |
| cheetah-wild-3 | 7 | 11 | [Traza y capturas](sessions/cheetah-wild-3/trace.json) |

## Incidencias y alcance

- Una primera confirmación de Floating Dragon estaba animada. El clic cerró el diálogo sin petición de compra ni cargo. Se volvió a abrir, se revisó la nueva captura y se eligió el check visible en su posición estable. Sólo se contabilizó la compra con aceptación del servidor.
- Varias demos simultáneas ralentizaron Chromium. Se cerraron las sesiones finalizadas y se redujo la concurrencia. La primera sesión Standard de Cheetah se cerró con `fs=13/15`, antes de observar su cobro; ese intento queda conservado como incompleto. Cualquier repetición usa una demo y una compra nuevas, sin reconstruir el resultado aleatorio anterior.
- Los precios, opciones y campos son los de estas versiones demo y esta apuesta base. No se certifican configuraciones de otros operadores, opciones ocultas, todos los importes de apuesta ni todos los resultados aleatorios.
- Lucky Tiger Gold permanece en la muestra aunque no se encontrara una compra. La descripción de su función de respin no se contabiliza como compra.
- Cheetah mostró atajos «REBUY FREE SPINS» de $200 y «REBUY SUPER FREE SPINS» de $1,000 después de completar sus respectivas compras. Se documentan como ofertas visuales de los mismos nombres y precios; esos atajos no se ejecutaron y no se les atribuyen payloads propios sin observarlos.
- Esta prueba valida el recorrido manual de capturas, clics y tráfico. No añade una verificación de toda la planificación de colas ni un catálogo completo del protocolo de giros ordinarios.

Los bytes y SHA-256 de los archivos entregados están en [manifest.json](manifest.json). No se publican SQLite, almacenamiento del navegador, cookies ni tokens de lanzamiento.
