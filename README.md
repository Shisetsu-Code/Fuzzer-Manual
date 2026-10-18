# Fuzzer Manual

**Catalogador visual por oleadas para demos públicas.** Prepará muchos juegos, marcá **varios puntos sobre una sola fotografía**, presioná la tecla configurable de siguiente y dejá que los workers reconstruyan cada rama de forma independiente. Los clics y las decisiones se guardan localmente; no hace falta Qwen.

![Estado: MVP](https://img.shields.io/badge/Estado-MVP%20experimental-777)

> **Alcance actual:** páginas públicas `https://www.pragmaticplay.fun/<idioma>/slots/<juego>/` y su iframe DEMO. No utiliza credenciales, cuentas de casino ni apuestas con dinero real. El motor NO está certificado todavía con una prueba completa de un bonus hasta su cierre real; necesita pruebas locales con Playwright y juegos variados. Otros proveedores requieren adaptadores DEMO específicos.

## Objetivo del proyecto

**Procesar miles de juegos DEMO con una catalogación visual humana rápida, mientras la preparación y expansión de rutas funcionan de manera independiente y persistente.**

La persona **no tiene que navegar cada juego en tiempo real**: el sistema prepara fotografías de estados pendientes; el operador entra cuando quiere, marca uno o varios controles sobre cada imagen y avanza de inmediato a otra fotografía ya precargada. Las marcas confirmadas crean trabajos que se reproducen en sesiones aisladas y generan nuevas imágenes para la siguiente oleada.

### Funcionamiento conceptual

```text
URLs de demos ──→ Cola de descubrimiento (2 workers) ──→ Fotografías en disco
                                                             │
                                                             ▼
                                       Operador: marcar N opciones + Espacio
                                                             │
                                                             ▼
                                        SQLite: N marcas → N ramas independientes
                                                             │
                                                             ▼
                            Cola de reproducción (4 workers) → nuevas fotografías
                                                             │
                                                  Repetir por oleadas
```

Los **workers preparan y recorren rutas aunque la GUI esté cerrada**, siempre que el servidor continúe funcionando. Mientras la persona cataloga, la política adaptativa favorece las ramas (objetivo 1 trabajador de descubrimiento + 5 de ramas) para reponer su cola de fotos. No se ejecutan cuatro compras como clics consecutivos en un único cliente: cada marca es una alternativa y se verifica individualmente.

Todo permanece ligado a **proveedor, identificador del juego, símbolo, fotografía/tarea, marca, rama, sesión, endpoint y payload DEMO permitido**, de modo que se pueda reconstruir qué se exploró y qué quedó pendiente. Los estados aleatorios no se reproducen como si fueran menús deterministas.

**Referencia funcional completa:** [Objetivo, concepto, flujo de oleadas, trazabilidad y criterios de éxito](docs/OBJETIVO_Y_FUNCIONAMIENTO.md). El documento diferencia el alcance del MVP actual de las mejoras previstas; constituye la guía conceptual para próximos desarrollos.

## Instalación (Windows 10/11, Node 22.13+; recomendado Node 24/26)

```powershell
git clone https://github.com/Shisetsu-Code/Fuzzer-Manual.git
cd Fuzzer-Manual
npm install
npx playwright install chromium
$env:DATA_DIR="D:\FuzzerManual"  # carpeta de un SSD NVMe local
$env:DISCOVERY_WORKERS="2"
$env:BRANCH_WORKERS="4"
$env:ADAPTIVE_WORKERS="1" # con GUI activa prioriza ramas (1+5)
$env:MAX_LIVE="4"
$env:IMAGE_CACHE_MB="1024"
$env:SQLITE_CACHE_MB="256"
$env:GPU_MODE="auto"           # o "d3d11" en Windows para probar ANGLE/D3D11
$env:HEADLESS="0"              # headed para usar la GPU del Chromium local
npm start
```

Abrí **http://127.0.0.1:4177** en Firefox, Edge o Chrome. El navegador de trabajo se controla por Playwright/Chromium; la GUI puede abrirse en cualquier navegador local.

El programa inicia **pausado** para que puedas importar URLs y elegir cuándo cargar los juegos. Pegá hasta 20.000 enlaces por importación, presioná **Iniciar workers**, y catalogá las fotos ya preparadas sin esperar por la siguiente pestaña. No se requieren servicios externos.

### Teclas y marcas

| Acción | Tecla inicial |
|---|---|
| Guardar todas las marcas de una foto y avanzar | `Espacio` |
| Revisar la foto anterior (solo lectura) | `Shift+Espacio` |
| Deshacer última marca | `Z` |
| Omitir foto | `S` |
| Pausar/iniciar workers | `P` |
| Tipo de marca: navegar / compra DEMO / confirmación / selección / continuar / otro | `1` ... `6` |

Las teclas se pueden cambiar en la GUI. Cada clic coloca una cruz numerada y guarda coordenadas relativas al área de captura. **Cuatro compras marcadas en el mismo menú producen cuatro nuevos trabajos** para la siguiente oleada, no cuatro clics secuenciales sobre el mismo cliente.

### Borradores, guardado y recuperación

Cada fotografía conserva su propio borrador. Podés cambiar de foto o revisar el historial sin perder las marcas de otra. Al guardar, la interfaz continúa con la siguiente imagen mientras espera la respuesta; la foto entra en el historial cuando SQLite confirma el guardado. Mantener pulsada la tecla de siguiente u omitir no encadena descartes.

Si una respuesta se pierde, **Guardados pendientes** permite reintentar el mismo envío. El servidor devuelve los hijos ya creados cuando las marcas coinciden, evitando duplicarlos. Los borradores y envíos sin confirmar se conservan en el navegador al recargar; si el almacenamiento no está disponible o alcanza su límite, la GUI avisa y mantiene el trabajo en memoria. El borrador local todavía no es una rama confirmada en SQLite.

Los borradores pertenecen a un catálogo concreto: cambiar `DATA_DIR` no mezcla las fotos ni oculta tareas del catálogo nuevo. Al restaurarlos, la interfaz consulta el estado actual de cada tarea. Conserva para consulta las marcas de una rama bloqueada y permite corregir un envío rechazado cuando verifica que el servidor aún no lo guardó. Si cambia la captura de una foto con marcas pendientes, exige descartar explícitamente esas marcas antes de trabajar sobre la imagen nueva.

La sección **Sesiones para recuperar** muestra tareas fallidas o bloqueadas que aún conservan su contexto DEMO. **Recapturar** toma una fotografía del estado actual sin ejecutar otra acción del juego. **Liberar** cierra esa sesión y deja registrada la incidencia. Ambas operaciones rechazan una sesión que esté trabajando.

Al reiniciar, el motor distingue una preparación segura de una acción cuyo resultado es incierto. El checkpoint se escribe inmediatamente antes del clic irreversible: si el proceso termina después, la tarea queda bloqueada para revisión. Las capturas que dependían de una sesión RNG perdida también dejan de estar disponibles como trabajo listo. El catálogo y las marcas se conservan.

## Diseño y rendimiento

- **Chromium compartido, contextos aislados** (`DISCOVERY_WORKERS=2`, `BRANCH_WORKERS=4`, `ADAPTIVE_WORKERS=1` por defecto; presupuesto total hasta 12). No instala ni relanza Chromium por juego; cada tarea de navegación usa contexto limpio. Se intenta aceptar cookies/aviso de edad y entrar al iframe DEMO antes de fotografiar. Si se reconoce un único control `FeaturePurchase/MainButton`, intenta abrir el menú y valida el nuevo estado.
- **Capturas JPEG en NVMe** (`DATA_DIR/shots`) y **LRU de imágenes en RAM** (`IMAGE_CACHE_MB`). El servidor carga previamente capturas listas; el frontend conserva otras 40 precargadas para que la tecla siguiente no dependa del worker.
- **SQLite WAL**, índices de estados y de raíces por juego, almacenamiento de metadatos y marcas en transacciones ACID; `SQLITE_CACHE_MB` controla el caché SQL. Las migraciones conservan los catálogos existentes, incluso si contienen raíces duplicadas históricas. Al reiniciar solo se reencola automáticamente el trabajo que puede repetirse con seguridad.
- **GPU:** la aceleración de canvas/WebGL queda en manos de Chromium/ANGLE; `GPU_MODE=d3d11` permite comparar la ruta de Direct3D 11 en Windows. Se registra el renderizador cuando el navegador lo reporta. No hay OCR, LLM ni inferencia GPU forzada en el bucle principal. La lectura, la navegación y los servidores siguen siendo fuentes de latencia; aumentar VRAM no acelera automáticamente Internet.
- **Verificación antes de cada clic de replay:** intenta usar el estado y los controles del runtime Pragmatic; si no se identifica un control, compara una huella visual de 32×18 calculada con libvips/SIMD (`sharp`). Un desajuste bloquea la rama y deja evidencia, en lugar de pulsar coordenadas obsoletas.
- **Ramas vivas:** comprar, confirmar o elegir se considera potencialmente irreversible. `MAX_LIVE` cuenta las sesiones retenidas, las reservas de preparación y los contextos que todavía se están cerrando. Solo se puede continuar la **misma** sesión RNG con una acción; no es posible clonar un resultado aleatorio en otras sesiones. La sesión pasa a ser propiedad del hijo antes de ejecutar su acción, de modo que un fallo siga siendo visible y recuperable.
- **Dos colas independientes:** 2 workers abren juegos sin catalogar y 4 reproducen ramas; con catalogador activo se redistribuyen a 1+5; los slots ociosos se prestan sin detener el progreso. La interfaz y las peticiones HTTP no esperan a Chromium.
- **Batches en segundo plano:** preparación y replay no bloquean la GUI. La aplicación guarda fotos y acciones automáticamente y expone incidencia por rama.

No se introdujo Rust en el bucle de navegador porque Playwright/Chromium, red, pintado y JPEG dominan el costo y el planificador Node es I/O asíncrono. La comparación y el redimensionado de imágenes se ejecutan con `sharp`/libvips nativo. **El uso de Rust está reservado para kernels medidos como cuello de botella**, para no sumar una compilación nativa sin una mejora comprobada.

## Persistencia y trazabilidad por operación

Todo se guarda debajo de `DATA_DIR` (idealmente un SSD local):

- `games`: ID interno estable, URL original, proveedor (`pragmatic`) y `game_symbol` detectado en el iframe DEMO cuando existe.
- `tasks`: ID de fotografía/rama, `game_id`, padre, marca de entrada, profundidad, estado y captura asociada. No se pierde el árbol al cerrar la GUI.
- `marks`: varias coordenadas normalizadas por fotografía, orden y categoría. Una marca se transforma en un **trabajo hijo independiente**.
- `network_events`: ID del evento, `game_id`, `task_id`, `session_id`, proveedor, símbolo, fase, endpoint sin query, método HTTP, acción, estado HTTP y subconjuntos **permitidos** de payload de petición y respuesta. No almacena tokens de sesión, cookies ni HAR sin sanitizar.
- `shots/task-ID.jpg`: fotografías JPEG; `capture_json` contiene `sessionId`, estado visual, controles detectados, ruta del frame **sin parámetros URL**, metadatos y observaciones recientes.

Consultá `GET /api/tasks/{id}/trace` para eventos de la fotografía y `GET /api/games/{game_id}/export` para el árbol y la evidencia estructurada del juego. Ambos enlaces también se acceden desde la interfaz. Los informes de grandes juegos indican `truncated:true` cuando el número de nodos o eventos supera el límite de exportación; no se interpretan como cobertura completa.

**La captura de payloads es selectiva:** registra campos de protocolo DEMO conocidos (`action`, `pur`, `ind`, `bl`, `c`, `l`, `na`, etc.) y endpoints de Pragmatic permitidos. No captura claves desconocidas, cuerpos completos ni tráfico de otros proveedores. Si se requiere más cobertura, debe ampliarse la lista permitida tras examinar datos sanitizados. No se atribuye el resultado aleatorio a una causa determinista.

Los campos permitidos se extraen tanto de parámetros GET como del cuerpo POST; el cuerpo tiene prioridad si hay un campo repetido. La URL del endpoint se conserva sin parámetros. La cola visual expone `sessionId` y `gameSymbol` cuando fueron observados.

| Operación de recuperación | API |
|---|---|
| Fotos listas, incidencias y sesiones retenidas recuperables | `GET /api/queue` |
| Guardar marcas o confirmar un reintento idéntico | `POST /api/tasks/{id}/commit` |
| Recapturar la sesión sin otro clic | `POST /api/tasks/{id}/recapture` |
| Liberar la sesión actualmente asignada a la tarea | `POST /api/tasks/{id}/release` |

### Cola con política adaptable

Configuración predeterminada: `DISCOVERY_WORKERS=2`, `BRANCH_WORKERS=4`, `MAX_LIVE=4`, `ADAPTIVE_WORKERS=1`. Si mantenés la GUI activa, el frontend envía una señal al planificador y prioriza ramas (1 descubrimiento + 5 ramas). Al dejar de catalogar vuelve a 2+4; si una cola está vacía, la otra toma los slots libres. `MAX_LIVE` limita la capacidad reservada para sesiones, sin limitar las ramas acumuladas en disco. Las continuaciones de sesiones retenidas tienen prioridad y no quedan ocultas detrás de una primera página de trabajos que esperan capacidad. Si se llenan las sesiones vivas, el sistema continúa descubriendo juegos independientes.

No equipares un `HTTP 200` o una captura de premio con un bonus completado. El prototipo aún precisa validación con múltiples juegos reales, especialmente en transiciones con RNG y cierre de Free Spins.

## Benchmarks y pruebas

```powershell
npm run check
npm test
npm run benchmark
# Con navegador instalado y acceso a Internet, smoke real de solo preparación:
node scripts/smoke-demo.js https://www.pragmaticplay.fun/en/slots/candy-rush/
# Preparación concurrente de opciones observadas hasta CONFIRM:
$env:MAX_LIVE="2"
node scripts/smoke-branches.js https://www.pragmaticplay.fun/en/slots/candy-rush/
```

El benchmark sintético genera 1.000 juegos, anota 4 opciones en cada uno (4.000 ramas) y prueba el caché en memoria, **sin afirmar que haya cargado ni completado 1.000 juegos**. Para rendimiento de preparación y de bonus hay que medirlo en la PC de destino con el smoke y tareas reales.

Las regresiones ejecutan las transiciones reales de SQLite y del motor, sustituyendo la comunicación con Chromium y el juego cuando corresponde. Incluyen una interrupción en otro proceso después del clic, límites de capacidad concurrente, recuperación de sesiones, colas extensas, guardados tardíos y la integración HTTP/GUI. Las pruebas de interfaz ejecutan el módulo de estado y los manejadores reales de la aplicación con una frontera DOM controlada.

El workflow **Browser DEMO smoke** utiliza Chromium y la demo pública de Candy Rush. Exige al menos tres opciones observadas que alcancen `CONFIRM`, preparadas en lotes concurrentes bajo `MAX_LIVE=2`, y verifica que no queden sesiones retenidas al cerrar. Publica fotografías y diagnósticos sanitizados bajo un artefacto identificado por el SHA del código; cualquier fallo se informa como incompleto. Este smoke termina antes de confirmar la compra y **no certifica un bonus completo**. Cada resultado debe consultarse en la ejecución correspondiente al commit que se está evaluando.

## Flujo de una oleada

1. Importar enlaces DEMO → se crean tareas raíz.
2. Los workers abren la demo, inspeccionan el estado y guardan una fotografía en `shots/`.
3. La GUI muestra fotos precargadas. Seleccionar tipo `Compra DEMO`, marcar las cuatro opciones y pulsar `Espacio` → se guardan cuatro marcas y se encolan cuatro hijos.
4. Cada hijo crea una sesión aislada, reproduce las transiciones conocidas, ejecuta **una** marca y entrega otra fotografía.
5. Las nuevas capturas aparecen en la siguiente oleada; las ramas que requieran una sesión aleatoria viva se conservan bajo `MAX_LIVE` y se prioriza catalogarlas antes de liberarlas.

Los estados del juego aleatorios no son reproducibles como si fueran menús deterministas. El sistema no reenviará ciegamente una compra si la confirmación o la ruta anterior no se pueden verificar.

## Archivos

`src/browser.js`: Chromium/Playwright, inspector Pragmatic, capturas, replay y sesiones vivas. `src/db.js`: tareas, marcas y SQLite. `src/scheduler.js`: trabajadores y precarga RAM. `src/server.js`: servidor HTTP local. `src/visual.js`: verificación de imagen con libvips. `public/`: GUI. `scripts/benchmark-store.js`: benchmark sintético.

### Límites conocidos del MVP

- Existe un smoke acotado con Candy Rush en Chromium/Playwright que generó tres fotografías de confirmación desde ramas separadas; **no equivale a certificar el recorrido completo de bonus**. Los tests sin navegador cubren almacenamiento y planificación con adaptadores simulados.
- Los estados de canvases con controles ocultos o animaciones pueden dar falsos negativos de huella visual. En ese caso la rama queda bloqueada para revisión; no se inventan clics.
- Las operaciones de Free Spins, picks aleatorios y cierres precisan pruebas end-to-end con Chromium local. Una captura y un HTTP 200 no equivalen a una rama completada.
- Cada compra DEMO retiene un contexto, que consume RAM/GPU. `MAX_LIVE` tiene límites reales de capacidad; no se pueden dejar miles de bonus activos simultáneamente.
- La versión inicial se restringe a Pragmatic y no importa directamente módulos ni credenciales del HardFire previo. Más proveedores y la integración MCP se podrán agregar como adaptadores manteniendo la GUI y el planificador.

Datos locales: `DATA_DIR/catalog.sqlite`, WAL, `shots/`. No subas HAR, cookies o capturas potencialmente sensibles al repositorio; `data/` se ignora en Git.
