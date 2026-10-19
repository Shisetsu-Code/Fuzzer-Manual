# Objetivo y funcionamiento conceptual — Fuzzer-Manual

> Documento de referencia funcional. Describe **para qué existe el proyecto**, cómo debe comportarse y cómo se conectan sus piezas. El [README](../README.md) contiene instalación, configuración y comandos. El sistema se encuentra en etapa **MVP experimental**: los objetivos descritos aquí no implican que todos los proveedores, bonos o recorridos estén certificados.

## 1. Objetivo

**Fuzzer-Manual es un catalogador visual de interfaces de juegos DEMO a gran escala, con exploración asistida por una persona y ejecución automatizada por ramas.**

Su propósito es procesar **miles de juegos** sin exigir que el operador espere a que cada juego cargue, sin pedirle que recorra repetidamente las mismas pantallas y sin depender de un LLM para pulsar controles desconocidos.

La persona es **catalogadora de decisiones**, no ejecutora manual de todos los pasos. El software se ocupa de abrir demos, preparar estados, fotografiarlos, registrar elecciones, reproducir rutas verificadas, crear nuevas ramas y conservar su evidencia.

**Principio rector:** *las fotografías se producen en segundo plano; las decisiones humanas se consumen posteriormente, cuando el operador quiera; cada decisión produce nuevo trabajo sin bloquear la clasificación de otras fotografías.*

### Resultados esperados

- Una cola extensa de enlaces DEMO puede prepararse sin que la GUI esté abierta, siempre que el servidor/workers sigan ejecutándose.
- El operador puede clasificar capturas ya generadas, con clics sobre la imagen y atajos configurables, **sin esperar** a que se cargue la siguiente demo.
- Una sola fotografía admite **múltiples marcas**: cuatro opciones de compra pueden convertirse en cuatro trabajos independientes.
- Los workers recorren las decisiones catalogadas y generan **nuevas fotografías de los siguientes estados**; las oleadas se repiten hasta agotar la cobertura verificable o detectar un bloqueo.
- Toda fotografía, marca, sesión, rama, operación y observación del tráfico queda vinculada a **un juego identificable** y a su **proveedor**.
- La información se conserva para volver más tarde, recuperar el trabajo tras reinicios y auditar qué se observó y qué **no** pudo verificarse.

## 2. Funcionamiento básico (para el operador)

1. **Importar:** ingresar las URLs de los juegos (hasta 20.000 por importación). Se registran juegos y tareas iniciales sin duplicar URLs ya incorporadas.
2. **Preparar:** iniciar los workers. El grupo de descubrimiento abre demos, atraviesa controles de entrada conocidos y, cuando puede verificar el estado, abre menús de compras conocidos. Guarda fotografías para revisión.
3. **Catalogar cuando resulte conveniente:** abrir la GUI local y revisar la cola de imágenes. Cada clic en la fotografía crea un **marcador numerado** en la posición seleccionada. Se puede escoger el tipo de acción y deshacer marcas.
4. **Marcar varias opciones en una misma imagen:** si el menú tiene cuatro compras, seleccionar las cuatro. **No se ejecutan las cuatro en una misma sesión**: son alternativas del mismo estado.
5. **Confirmar y avanzar:** pulsar la tecla configurable (por defecto, `Espacio`). En ese momento las marcas se guardan transaccionalmente y se crean los trabajos hijos. La GUI pasa a otra fotografía ya disponible.
6. **Explorar ramas:** otros workers toman esos trabajos, reconstruyen los pasos anteriores desde una sesión DEMO adecuada y ejecutan **una alternativa por rama**, con verificaciones de estado/controles antes de cada clic.
7. **Nueva oleada:** cada estado nuevo produce otra fotografía. Se agrega a la cola del operador mientras continúa la preparación de otros juegos. La persona puede ausentarse y volver cuando quiera.

**Guardado y borradores:** los puntos aparecen de inmediato en la GUI y se conservan como un borrador de esa fotografía, también al navegar a otra. Su confirmación durable en SQLite sucede al guardar (`Espacio` o botón equivalente) y recibir la respuesta. Si esa respuesta se pierde, el envío original queda pendiente y se puede repetir sin crear hijos duplicados. El historial incluye únicamente guardados confirmados. Los borradores locales preservan el trabajo al recargar cuando el almacenamiento del navegador está disponible; no equivalen a decisiones ya ejecutadas por los workers.

## 3. Ejemplo conceptual: cuatro compras

```text
Juego #42 / proveedor pragmatic / estado BUY_MENU
  Fotografía #315
  ├─ Marca A: compra 1 ─→ Rama #316 ─→ nueva fotografía (confirmación 1)
  ├─ Marca B: compra 2 ─→ Rama #317 ─→ nueva fotografía (confirmación 2)
  ├─ Marca C: compra 3 ─→ Rama #318 ─→ nueva fotografía (confirmación 3)
  └─ Marca D: compra 4 ─→ Rama #319 ─→ nueva fotografía (confirmación 4)

El catalogador confirma una sola vez y continúa con otra foto.
Cada rama usa su propia sesión/reconstrucción verificable.
```

Cuando se clasifican las fotografías de confirmación, se forman nuevos hijos del mismo árbol. Se distingue **ramificación** (alternativas excluyentes que generan sesiones/rutas distintas) de **secuencia** (pasos sucesivos de una ruta, reproducidos en orden). El árbol almacena ambos casos mediante la relación padre → marca → hijo.

## 4. Dos procesos independientes

### A. Descubrimiento

Entrada: URLs aún no preparadas.

El sistema crea tareas raíz, abre el juego mediante Playwright/Chromium, resuelve entradas DEMO conocidas, inspecciona el runtime y captura el estado alcanzado. No inventa coordenadas si no reconoce un menú ni declara que se completó un juego por obtener una imagen.

Salida: **fotografías listas para clasificación** y datos de estado.

### B. Reproducción / expansión de ramas

Entrada: marcas confirmadas por el operador y sus rutas padre.

El sistema reconstruye una ruta, revalida sus pasos y ejecuta la alternativa marcada. Después observa la transición, guarda imagen/evidencia y devuelve una nueva tarea a la cola visual. Si la ruta no coincide con el estado esperado, **bloquea esa rama y registra el motivo**, sin forzar clics sobre coordenadas obsoletas.

Salida: **nuevas fotografías de ramas**, trazas y estados `ready`, `blocked` o `failed`, según corresponda.

Estas dos corrientes pueden progresar simultáneamente sin que el operador tenga la GUI abierta.

## 5. Workers, prioridades y rendimiento

Configuración inicial:

| Situación | Workers descubrimiento | Workers ramas |
|---|---:|---:|
| Operador ausente o inactivo | 2 | 4 |
| Operador clasificando activamente | 1 | 5 |

El planificador presta plazas vacantes de una cola a la otra. La asignación `1+5` es **una prioridad de planificación**, no la promesa de que todos los workers están ocupados o de que seis sesiones de bonus permanecen vivas. Las sesiones DEMO que deben permanecer abiertas están limitadas por `MAX_LIVE` (inicialmente, 4). Se reserva la capacidad antes de iniciar la preparación y se mantiene ocupada hasta terminar el cierre del contexto. Las continuaciones de sesiones retenidas se buscan primero; una página llena de ramas que esperan capacidad no debe ocultar una continuación ejecutable.

El objetivo de UX es que cambiar de fotografía precargada no dependa de un viaje por red ni de que termine una tirada: las fotos se almacenan en disco y se precargan en memoria. Los tiempos reales de preparación, captura, replay y finalización deben medirse en juegos reales; la velocidad de la GUI no prueba la capacidad total del motor.

## 6. Datos y trazabilidad

Cada acción debe poder relacionarse inequívocamente con **su juego, proveedor, captura, rama, sesión y evidencia**. La estructura local usa SQLite y archivos de imágenes:

| Entidad | Identificación / contenido |
|---|---|
| `games` | `game_id`, URL, slug, proveedor y `game_symbol` cuando está disponible |
| `tasks` | `task_id`, `game_id`, `parent_task_id`, `via_mark_id`, profundidad, estado, captura |
| `marks` | `mark_id`, fotografía de origen, ordinal, coordenadas relativas, categoría y etiqueta |
| `network_events` | `event_id`, `game_id`, `task_id`, `session_id`, proveedor, símbolo, fase, endpoint, método, acción, estado HTTP y campos permitidos de petición/respuesta |
| `shots/` | JPEG asociado a `task_id` y metadatos de captura/estado |

Relaciones conceptuales:

```text
Proveedor → Juego (game_id)
                ├─ Tarea/fotografía raíz (task_id)
                │     ├─ Marca 1 (mark_id) → tarea hija → fotografía
                │     └─ Marca 2 (mark_id) → tarea hija → fotografía
                └─ Evidencia de red → session_id + task_id + endpoint + payload permitido
```

El objetivo no es solo saber **dónde se hizo clic**, sino también **en qué juego y estado, a través de qué rama, qué petición se observó, qué respondió el servidor y cuál fue la siguiente pantalla**.

El motor actual registra tráfico DEMO de Pragmatic con una **lista blanca** de endpoints y campos de protocolo, extraídos tanto de parámetros GET como del cuerpo POST; no conserva cuerpos HAR íntegros, cookies ni tokens. La vista de la GUI ofrece trazas por tarea y exportación JSON estructurada por juego. Otros proveedores necesitarán adaptadores específicos. Los resultados deben diferenciar una acción intentada, una petición aceptada, una transición observada y una operación realmente verificada.

## 7. Reproducibilidad y estados aleatorios

- **Navegación reproducible:** menús y controles estables se pueden reconstruir en sesiones independientes, siempre que la observación actual lo confirme.
- **Acciones potencialmente irreversibles:** compras DEMO, confirmaciones o decisiones de bonus pueden requerir conservar la **misma sesión viva**.
- **RNG no reproducible:** abrir una nueva sesión no garantiza los mismos símbolos, giros, premios, elecciones u otros estados aleatorios. No se bifurca una única sesión viva para inventar alternativas equivalentes.
- **Sesión perdida o control ambiguo:** conservar el árbol y la evidencia, marcar `blocked` y solicitar una revisión; no confundir la falta de una respuesta con permiso para repetir una compra.

Un HTTP 200, `doCollect` o una captura de premio son evidencia **parcial**. No certifican por sí solos el retorno al estado base ni la cobertura total de un bonus.

### Recuperación de una operación incierta

Antes de pulsar un control irreversible, el motor verifica su estado y escribe un checkpoint de acción despachada. Si termina el proceso después de ese punto, el siguiente arranque conserva la rama bloqueada: la ausencia de una captura final no demuestra que el clic no ocurrió. Los trabajos que quedaron antes de una acción y pueden reconstruirse con seguridad sí pueden reencolarse.

Durante una continuación, la sesión pasa al hijo antes de verificar o ejecutar el clic. Si algo falla y el contexto sigue vivo, ese hijo aparece en **Sesiones para recuperar**. El operador puede **Recapturar** el estado actual sin repetir la acción, o **Liberar** el contexto y conservar la incidencia. No se permite recuperar o liberar una sesión mientras está ejecutando trabajo. Una petición para liberar un antiguo padre tampoco puede alterar al hijo que ahora posee la sesión.

Si la sesión se perdió, una fotografía anterior no basta para continuar el RNG. La GUI debe conservar las marcas locales para consulta y mostrar el bloqueo, sin presentar esa foto como trabajo listo. Un reintento de guardado sin respuesta se reconcilia por separado, porque SQLite podría haber confirmado ya sus marcas.

## 8. Qué se considera terminado y qué falta

### Incluido en el MVP de la rama de desarrollo

- Importación y deduplicación de URLs DEMO Pragmatic.
- Preparación de capturas, GUI de puntos numerados y atajos.
- Varias marcas por foto, creación persistente de trabajos hijos y replay con controles de seguridad.
- Dos colas de workers con redistribución según actividad.
- Persistencia del árbol, sesiones observadas, fotografías y trazabilidad selectiva de protocolo.
- Recuperación de tareas incompletas con checkpoint de acción, recaptura sin clic cuando la sesión sigue viva y bloqueo conservador cuando se perdió.
- Borradores por fotografía y reintentos de guardado idempotentes, sin reemplazar el trabajo de otra foto por una respuesta tardía.
- Regresiones con SQLite, el motor y los manejadores reales de la interfaz; los límites externos del navegador/red se simulan para provocar fallos de forma reproducible.
- Una prueba DEMO acotada de al menos tres ramas hasta pantallas de confirmación, con lotes concurrentes y diagnósticos asociados al commit probado. Su resultado debe verificarse en el workflow de ese commit; no representa una certificación del bonus completo.

### Objetivos de evolución, **no funcionalidades garantizadas hoy**

- Clasificar automáticamente pantallas **equivalentes** entre juegos usando coincidencia de runtime e imagen, con verificación por juego.
- Aprender macros visuales reutilizables para minimizar fotografías repetidas.
- Detectar estados nuevos y repetidos con mejores señales de transición para ahorrar tiempo.
- Certificar ciclos completos de bonos variados, incluidas sus continuaciones y regreso a base.
- Ampliar proveedores mediante adaptadores, conservando el mismo catálogo, la GUI y la trazabilidad.
- Realizar pruebas de larga duración con miles de juegos y medir cobertura, tasa de bloqueo, RAM, latencias y recuperación.

## 9. Reglas del producto

1. **Operador desacoplado:** su ausencia no detiene el trabajo automático pendiente; solo evita clasificar fotografías nuevas.
2. **Una fotografía, múltiples decisiones:** cada alternativa marcada se registra, no se sobrescribe ni se interpreta como una secuencia de compras.
3. **Nunca perder procedencia:** no guardar capturas sin `game_id` y `task_id`; toda relación posterior debe ser rastreable.
4. **Persistir antes de liberar:** imágenes, marcas y resultados estructurados deben quedar guardados antes de dar por procesada una tarea.
5. **No falsear cobertura:** `PARTIAL`, `BLOCKED` y operaciones no verificadas se informan como tales.
6. **Solo DEMO autorizadas:** sin credenciales, sesiones reales de casino o datos sensibles en repositorios.
7. **Velocidad medible:** optimizar colas, reutilización de Chromium, precarga y deduplicación según benchmarks reales, no supuestos.

**Definición de éxito:** un operador importa miles de URLs, deja preparar fotografías durante horas, vuelve cuando le conviene, marca rápidamente varias opciones por captura y observa cómo el sistema amplía por sí solo el catálogo de ramas y evidencias verificables, sin reconstruir a mano cada recorrido ni perder la identidad de los juegos.
