# cm-monitor

Monitoreo externo de disponibilidad de **cmillonario.com**. Un solo programa en Node, sin dependencias, **solo lectura**.

Este repositorio es público, así que contiene únicamente revisiones sobre cosas que **cualquier visitante del sitio ya puede observar por sí mismo**: el HTML que sirve el servidor, los archivos que ese HTML pide, el DNS, el certificado, las librerías de terceros que la propia página carga, y los catálogos de juego que la aplicación lee desde el navegador de un usuario sin sesión iniciada.

## Uso

```bash
node monitor.mjs
```

| Comando | Para qué |
|---|---|
| `node monitor.mjs` | Corrida completa (capas 1, 2 y 3) |
| `node monitor.mjs --capa 1` | Solo disponibilidad (más rápido) |
| `node monitor.mjs --publico` | Fuerza el perfil público, ignorando cualquier configuración local |
| `node monitor.mjs --solo-privado` | Ejecuta **solo** las revisiones que aporta el perfil privado, sin repetir las públicas |
| `node monitor.mjs --dry-run` | Revisa pero **no** manda alertas |
| `node monitor.mjs --prueba` | Valida el token de Telegram y manda un mensaje de ejemplo |
| `node monitor.mjs --chatid` | Lista los chats que conoce el bot, para encontrar el id de un grupo |
| `node monitor.mjs --reporte` | Uptime %, latencia p95 e incidentes de las últimas 24 h |
| `node monitor.mjs --reporte --enviar` | Lo anterior, y lo manda por Telegram |
| `node monitor.mjs --json` | Salida en JSON |

**Código de salida:** `0` = todo bien · `1` = hay algo crítico en rojo · `2`/`3` = falló el propio monitor.

## Qué revisa

**Capa 1 — Disponibilidad.** Que el home responda **y su HTML contenga el texto esperado**; que el bundle JS y CSS que ese HTML pide **existan**; los cuatro dominios; la latencia; el certificado TLS; el DNS; y las cabeceras del CDN.

**Capa 2 — Backend público.** Las funciones de catálogo de juego que llama el navegador de un visitante, que Firebase Auth responda, que las colecciones de catálogo de Firestore se puedan leer, y las tres librerías de terceros que la página carga.

**Capa 3 — Negocio.** Que los resultados de cada juego estén al día según su calendario, que el catálogo del home tenga juegos activos, y que haya concurso vendible en los juegos que lo requieren.

Sobre esto último: que en un momento dado no haya nada en venta **no es de por sí una falla**. Entre que cierra un concurso y abre el siguiente hay un hueco natural. La revisión solo alerta si ese hueco se alarga más de lo previsto (`toleranciaVentaHoras`, afinable por juego), porque entonces significa que el siguiente concurso no se cargó. Si el próximo concurso ya está programado, tampoco alerta.

### Revisiones desactivadas

`desactivadas.ids` en la configuración apaga revisiones concretas: se siguen construyendo pero no se ejecutan, no cuentan en el total y no pueden alertar. Es para trabajos ya conocidos y en curso, donde la revisión estaría en amarillo permanente sin aportar nada.

Ahora mismo está apagada `neg_proximo_sorteo` (la fecha de "Próximo sorteo" que ve el visitante). Para reactivarla basta con quitar su id de esa lista; la revisión y su lista blanca siguen intactas.

## Por qué no basta con revisar el código HTTP

El sitio es una SPA servida por Firebase Hosting con *rewrite*: **cualquier ruta devuelve 200 con el mismo HTML**, incluidas las que no existen. Un monitor configurado como "avísame si no responde 200" nunca dispararía, ni con la aplicación completamente rota.

Por eso cada revisión valida **contenido**:

- El home tiene que contener un texto marcador, no solo responder.
- Se extrae el hash de `main.<hash>.js` del HTML y **se comprueba que ese archivo exista**. Así se detecta el despliegue roto que deja la pantalla en blanco: el HTML nuevo pidiendo un bundle viejo que ya no está.
- Una función se considera viva por la *forma* de su respuesta, no por el código: un `403` con JSON limpio significa que su capa de autenticación está trabajando; un `404` de la infraestructura significa que la función ya no existe.

## Cómo evita las falsas alarmas

- Alerta solo en **transición**: OK→FALLA y FALLA→OK.
- Exige **2 corridas fallidas seguidas** antes de avisar.
- Si sigue caído, **recordatorio cada 30 min**, no cada corrida.
- **Ventana de venta:** de 21:00 a 22:45 (CDMX) los Sorteos Electrónicos dejan de venderse; en ese horario no se alerta por falta de sorteo vendible. Los tradicionales se venden 24 h y sí se siguen vigilando.
- `reconocidos.ids` en la configuración: revisiones que ya se saben en rojo y están en proceso de arreglo. Siguen en rojo en pantalla pero no repiten alerta.

## Alertas por Telegram

1. En Telegram, escribe a **@BotFather** → `/newbot` → te da un token.
2. Escríbele algo al bot (o agrégalo a un grupo y escribe `/start` ahí).
3. Corre `node monitor.mjs --chatid` para ver el id del chat o grupo.
4. Copia `.env.example` como `.env` y pega los dos valores.
5. Comprueba con `node monitor.mjs --prueba`.

Si no hay credenciales, el monitor funciona igual y solo avisa que no pudo mandar la alerta.

## Cómo corre en producción

| Qué | Cada cuánto | Dónde |
|---|---|---|
| Las revisiones públicas | 5 min, en bucle | `.github/workflows/monitor.yml` |
| Reporte de 24 h al grupo | 8:00 CDMX | `.github/workflows/reporte-diario.yml` |

### Por qué un bucle y no un cron de 5 minutos

**Medido en este repositorio el 2026-09-02:** con `cron: */5 * * * *`, GitHub disparó **4 corridas en 17 horas**, con intervalos reales de 235, 307 y 282 minutos. El cron corrió cada 4-5 **horas**, no cada 5 minutos. GitHub documenta que los workflows programados se retrasan bajo carga; en la práctica los intervalos cortos son inservibles.

La salida aprovecha lo que sí ganamos al hacer público el repositorio: **Actions no cobra minutos**. En vez de pedirle a GitHub que nos despierte, el workflow mantiene **un trabajo vivo que revisa cada 5 minutos durante ~5 horas** y al terminar vuelve a lanzarse solo. El cron queda únicamente como red de seguridad por si la cadena se rompe.

Ventaja extra: dentro de una misma corrida el estado son archivos locales, así que la lógica de "2 fallos seguidos" funciona sin depender del cache. El cache solo enlaza una corrida con la siguiente.

Dos detalles que no son obvios y que están resueltos en los workflows:

**El estado tiene que sobrevivir entre corridas.** GitHub Actions no guarda nada entre ejecuciones, y sin estado la lógica de "2 fallos seguidos" y "avisar solo en transición" no sirve: repetiría la misma alerta cada 5 minutos. Por eso `state/` viaja en el cache de Actions.

**GitHub desactiva los crones de un repositorio sin actividad por 60 días.** El job diario sube una marca de tiempo a `.github/latido.txt` para que eso no pase. Sin ese latido, el monitoreo se apagaría solo en dos meses, en silencio — la peor forma de que falle un monitoreo.

### Los logs de este repositorio son públicos

Los workflows **no imprimen nada sobre el estado de la plataforma**. Todo el detalle va únicamente al grupo de Telegram; el log público solo dice `[ciclo N/modo] revision completada`. Publicar los resultados aquí sería un tablero público y en vivo de cuándo el sitio está degradado.

Si modificas los workflows, **no agregues `cat` de la salida ni `GITHUB_STEP_SUMMARY`** con los resultados.

### Las dos cadencias del bucle

El bucle alterna dos modos:

| Ciclo | Modo | Qué corre | Cada cuánto |
|---|---|---|---|
| 1 de cada 6 | completo | público + privado | 30 min |
| los otros 5 | `--publico` | solo el perfil público | 5 min |

Las revisiones privadas consultan el backend de juego iniciando sesión, y no conviene hacerlo cada 5 minutos: ni hace falta —son fallos que se mueven en horas— ni es sano para ese backend, que ya flaquea cuando le llegan varias consultas juntas.

El estado de una revisión que no corre en un ciclo **se conserva intacto**, así que mezclar las dos cadencias no altera la lógica de "2 fallos seguidos" ni la de avisar solo en transición.

`--publico` sigue mandando por encima del secreto: fuerza el perfil público aunque haya configuración privada disponible.

## Perfil privado

El monitor admite una segunda configuración, `checks.private.json`, que **no está en este repositorio** y no debe estarlo. Si existe, se suma al perfil público (los arreglos se concatenan) y habilita revisiones que no son apropiadas para un repositorio abierto.

Llega por dos vías:

1. **Como secreto**, que es la forma en que corre en la nube: `CM_CONFIG_PRIVADA_B64` con el JSON en base64. Se usa base64 para que sea una sola línea, así GitHub la enmascara de forma fiable en los logs y no hay problemas con saltos de línea.
2. **Como archivo**, que es lo cómodo en local: se busca en `CM_MONITOR_PRIVADO`, luego junto al programa, luego `../cm-monitor-privado/`.

Si no aparece por ninguna vía, el monitor corre en modo público sin más. Si aparece pero está corrupta, lo avisa por la salida de error y sigue en modo público, en vez de romperse en silencio.

### Qué protege al secreto en un repositorio público

Esto merece ser explícito, porque es la decisión de diseño con más superficie de confianza de todo el proyecto:

- Los secretos **no se exponen** por que el repositorio sea público. No aparecen en el código, ni en la interfaz, ni en los logs.
- GitHub **no entrega los secretos a los workflows que vengan de un fork ajeno**. Alguien que abra un pull request malicioso no puede leerlos.
- GitHub **enmascara** el valor de un secreto si algo lo imprime por accidente.
- Lo que sí puede leerlos es un workflow de este repositorio en la rama por defecto. Es decir: **quien tenga permiso de escritura aquí, puede leer el secreto.** Hoy eso es una sola persona.

El secreto contiene configuración sensible (el mapa de las funciones de dinero y las reglas de acceso esperadas), no credenciales de la plataforma. Las credenciales de la cuenta de prueba son secretos aparte, y esa cuenta tiene saldo cero y sin método de pago.

Para verificar qué hace exactamente la versión pública, aunque tengas el archivo privado en tu máquina:

```bash
node monitor.mjs --publico --dry-run
```

## Archivos

| Archivo | Qué es |
|---|---|
| `monitor.mjs` | El programa. Lo único que se ejecuta. |
| `checks.config.json` | Qué se revisa y con qué umbrales. **Edita aquí, no el código.** |
| `.env` | Credenciales de Telegram. Ignorado por git. |
| `state/` | Estado, historial e incidentes. Ignorado por git. |
| `install-task.ps1` | Registra/quita tareas programadas en Windows (alternativa local) |

## Reglas de seguridad

- Es **solo lectura**. No escribe en ninguna base de datos.
- A los endpoints solo se les hace **GET sin cuerpo**, que no puede provocar ninguna operación.
- **No lee datos personales**: cuenta documentos y mide tiempos.
- No guarda credenciales en el código. Todo va en `.env` o en los secretos del repositorio.
- Se autolimita en frecuencia para no generar carga apreciable sobre el sitio.

El monitor no guarda ningún identificador del proyecto Firebase: lee el que publica el propio sitio en `/__/firebase/init.json`, el mismo que descarga el navegador de cualquier visitante.
