# Screen Cast

*This is an English translation — [ir a la versión en español ↓](#en-español)*

Web app (Vue 3 + TypeScript) and server (Node + Express + TypeScript) to cast local videos —
with their embedded subtitle tracks (MKV, etc.) — to a TCL Smart TV running Google TV / Android
TV, using built-in Chromecast (Google Cast).

## How it works

1. The server scans one or more folders on your PC for videos and reads their metadata
   (duration, codecs, subtitle tracks) with `ffprobe`.
2. The web app (Vue) lists your library. Each video has two buttons: "📡 Cast" and "▶ Play". Both
   open a popup over the library itself instead of navigating to a separate page, but the URL
   still changes (`/play/:id` or `/ver/:id`) — so you can reload the page or share that link: if
   you go straight to that URL, the library loads first and the matching popup opens as soon as
   it's ready.
3. "📡 Cast" uses the Google Cast SDK to connect to your TV (they must be on the same WiFi
   network) and control playback remotely (play/pause, volume, subtitles, seeking the timeline).
   "▶ Play" plays the video directly in the browser using the browser's native `<video>` element
   (with controls that include fullscreen) — handy for watching something quickly without
   turning on the TV (see [Local playback in the browser](#local-playback-in-the-browser)).
4. If the video is already compatible with the target (Chromecast or the browser itself — not
   always the same, see below), it's sent as-is. If not (e.g. a `.mkv`), the server repackages it
   (remux, no re-encoding) or transcodes it to MP4 the first time and caches it on disk.
5. Since your subtitles are embedded in the container rather than in separate `.srt` files, the
   server extracts each subtitle track to WebVTT (`.vtt`) with `ffmpeg` the first time it's
   requested, and serves it as a separate text track — so the Cast receiver (or the browser
   itself) can render it over the video.

## "Recent videos" filter

By default, the scan **doesn't even read with `ffprobe`** videos modified more than
`RECENT_MONTHS` months ago (3 by default, configurable in `server/.env`) — so the scan stays fast
even with a large, old library. The web app has an "Also include videos older than N months"
checkbox: turning it on triggers a new scan that does probe those older videos and adds them to
the library; turning it off, the next scan leaves them out again (nothing is "lost" — their
thumbnails/remuxes cached in `server/.cache` are reused instantly if you include them again
later, only their metadata needs to be re-read).

## Subtitle style

Under "🎨 Settings" (button next to "Update library") you can customize how subtitles look: font
size and style, typeface, text/background/edge color and opacity, and whether they sit on a
solid box or one with rounded corners. There's a live preview as you adjust each value.

On save, the style is written to `server/data/subtitle-style.json` (created the first time you
save; not tracked in git) and applied automatically the next time you cast a video. If you're
already casting something at that moment, the change is sent to the TV instantly, with no need
to re-cast. It also applies to local browser playback (see below) — font, colors, edge and
background are rendered via a WebVTT `::cue` style, generated fresh from the same saved style
each time a subtitle track is requested.

You can also change the subtitles' **vertical position** (top/center/bottom). This doesn't
travel through Cast's style API (which has no notion of position) — the server rewrites each
cue's `line:` setting when serving the `.vtt` file, so unlike the rest of the style it doesn't
update live: it applies the next time you switch subtitle tracks or cast/play again.

## Local playback in the browser

The "▶ Play" button plays the video directly in your browser (without going through the TV),
with the browser's native `<video>` controls — including fullscreen, no separate button needed.

**A note on codecs (HEVC/H.265):** Chromecast/Google TV decodes HEVC in hardware without issue,
so an HEVC file is sent to the TV as-is. Most desktop browsers (Chrome/Firefox on Windows without
a licensed hardware HEVC decoder) can't decode HEVC in a `<video>` element — the symptom is that
audio plays and subtitles show up normally, but the picture stays black. That's why the server
keeps, in addition to the cache meant for the TV, a **separate** cache for browser playback: if
the video isn't already H.264, it transcodes it to H.264 the first time you hit "Play" (this can
take a few seconds — you'll see "Preparing video…") and caches it separately, without touching
the file served to the TV.

**Preparing in advance:** since that first transcode can take a while, every thumbnail in the
library has a button in its top-left corner to kick it off ahead of time, without needing to open
the "Play" popup — handy for getting several videos ready in advance (e.g. from your phone,
before a trip). The icon shows that video's status for browser playback:

- ⬇️ (active button) — not ready yet; a click starts preparing it.
- ⏳ — being prepared right now.
- ✅ (green check) — already ready to play instantly, no transcoding needed (either because it's
  already H.264/VP8/VP9, or because it was prepared before and is still cached). Clicking it
  deletes the cached browser version, if there is one, and reverts back to the "prepare" state —
  the video's original file and its Chromecast/subtitle/thumbnail caches are left untouched.

## Deleting videos

You can delete a video from three places: the trash icon in the top-right corner of its
thumbnail in the library, or the delete button inside each of the Cast and Play popups (bottom-
right of the popup). All three show a confirmation popup before deleting anything.

On confirming, the server deletes the **original file from disk** (not just removing it from the
library) along with all of its cached files (remuxes/transcodes, extracted subtitles, thumbnail).
**This is irreversible** — there's no recycle bin or undo.

## Automatic cache cleanup

`server/.cache` can grow quite a bit with remuxes/transcodes of large videos, so the server
cleans itself up at two points:

- **On startup** (`npm run dev` or `npm start`): deletes cached `.mp4` files (both the one meant
  for Chromecast and the browser one) that aren't from that same day — the cache exists to make
  playing something twice in a row instant, not to accumulate re-encoded videos indefinitely.
  `.vtt` (subtitles) and `.jpg` (thumbnails) files are left alone here, since they're cheap.
- **On library scan** (on startup or when clicking "Update library"): deletes any cached file
  (remux, browser remux, subtitles, thumbnail) whose video is no longer in the index — because
  you deleted it, moved it out of `MEDIA_DIRS`, or renamed it. This step is skipped (with a
  console warning) if any configured media folder couldn't be read during that scan, so a
  temporarily unreachable drive never gets misread as "every video was deleted".

Both cleanups are silent if there's nothing to delete, and if they fail they just log a warning
to the console without interrupting startup or the scan.

## Requirements

- Node.js 18.18+ (20+ recommended).
- **ffmpeg and ffprobe** installed and available on the system `PATH`.
  - Windows: `winget install Gyan.FFmpeg` (or download from https://www.gyan.dev/ffmpeg/builds/
    and add the `bin` folder to your PATH).
  - macOS: `brew install ffmpeg`.
  - Linux: `sudo apt install ffmpeg` (or your distro's package manager).
- Your PC and the TCL TV connected to the **same WiFi/LAN network**.

## Installation

```bash
npm install
cp server/.env.example server/.env
```

Edit `server/.env` and set `MEDIA_DIRS` to the folder(s) where your videos live, e.g.:

```
MEDIA_DIRS=C:\Users\your-user\Videos
```

(on Windows use `\` paths; separate multiple folders with commas).

## Development mode (on your own PC, `localhost`)

```bash
npm run dev
```

This starts the server (`http://localhost:4000`) and the Vite client (`http://localhost:5173`)
together. Open `http://localhost:5173` in Chrome. Since Google Cast only requires a "secure
context" for `localhost` or HTTPS, this mode works without certificates — it's the fastest way to
check everything works before setting up access from your phone/another PC on the network.

> Note: even though you open the web app on `localhost`, the video and subtitles sent to the
> **TV** always use your PC's IP on the local network (the server detects it automatically),
> because the TV doesn't understand "localhost".

## "Actually casting" mode (HTTPS + access from your phone)

Google Chrome requires the page you cast from to be served over **HTTPS**, unless it's
`localhost`. If you want to control casting from your phone or another PC on the network (not
the same one running the server), you need HTTPS with a certificate that device trusts.

The simplest way is [`mkcert`](https://github.com/FiloSottile/mkcert):

```bash
# install mkcert (once)
# Windows (with chocolatey):   choco install mkcert
# macOS:                       brew install mkcert
# Linux: see instructions in the mkcert repo

mkcert -install
mkcert -key-file server/localhost-key.pem -cert-file server/localhost-cert.pem localhost 127.0.0.1 <YOUR-PC-IP>
```

Replace `<YOUR-PC-IP>` with your PC's local IP (e.g. `192.168.1.50` — you can see it in the log
when the server starts). Then, in `server/.env`:

```
HTTPS_KEY=./localhost-key.pem
HTTPS_CERT=./localhost-cert.pem
```

And start in "production" mode (a single process serves the API and the already-built web app):

```bash
npm run build
npm start
```

The server will print two URLs: `http://192.168.1.50:4000` and `https://192.168.1.50:4001` (the
HTTPS port defaults to HTTP + 1, configurable with `HTTPS_PORT`). Open the **HTTPS** one from the
browser on the phone/PC you want to control casting from (that device needs to trust the
certificate — either it has mkcert's root CA installed, or you accept it manually if Chrome warns
about an untrusted certificate).

The TV itself **never** uses the HTTPS port and doesn't need to trust the certificate: the video,
subtitles and thumbnails are always sent to it over the regular HTTP port, because it's the
Chromecast/TV that downloads them directly (not the browser) — so it doesn't matter which
protocol you opened the page with, playback on the TV doesn't depend on it.

## Known limitations

- **Image-based subtitles** (PGS/VobSub/DVB, typical of Blu-ray rips) can't be converted to
  WebVTT — the web app marks them as "unavailable". Text subtitles (SRT, ASS, `mov_text`) do
  work.
- The first time you cast an incompatible video (e.g. a `.mkv`), the server takes a few seconds
  to repackage it before it can play; subsequent times are instant (it stays cached in
  `server/.cache`).
- If a video uses a codec that neither Chromecast nor a simple remux support, with
  `ALLOW_TRANSCODE=true` (the default) the server transcodes it with `libx264`/`aac` — slower and
  uses CPU, but works with almost any file.
- TV discovery depends on mDNS/Cast on your network; if your router isolates WiFi devices from
  each other ("AP/client isolation"), the TV won't show up as a cast target.
- Playing an HEVC/H.265 video in the browser (not casting) takes a few seconds the first time,
  because it's transcoded separately from the copy served to the TV — see
  [Local playback in the browser](#local-playback-in-the-browser).
- Subtitle appearance customization (font, colors, edge, background) only affects local browser
  playback via WebVTT `::cue` styling — Chromecast gets its look from Cast's own TextTrackStyle
  API instead, and if you set both a background color and a window color, only the window color
  shows up in the browser (WebVTT only supports one background per line of text).

## If you save changes and don't see the effect (network/virtual drives)

If the project lives on a drive that isn't a normal local disk (a network drive, a `subst`
drive, a virtual disk, a cloud-synced folder...), both `tsx watch` (server) and Vite (client) may
not pick up file changes automatically — Windows doesn't always send change notifications through
that kind of drive. The symptom is exactly this: you save a change, restart, and it keeps
behaving like before.

It's already configured to use "polling" (actively checking files instead of waiting for a
system notification) in both Vite and `tsx watch`, which makes it more robust in these cases —
if you just updated the project, run `npm install` again to install `cross-env` (used to enable
it). Even so, if some change still doesn't show up:

1. Fully stop **both** processes (Ctrl+C until the prompt comes back) and close the terminal.
2. Open it again and run `npm run dev`.
3. For server-side changes, also hit "Update library" in the web app if the change affects how
   videos are read/processed (titles, filters, etc.) — a simple restart doesn't re-scan the
   library on its own.

## Project structure

```
screen-cast/
  server/    Express + TypeScript: library scanning, ffprobe, remux/extraction with ffmpeg,
             streaming with Range request support.
  client/    Vue 3 + TypeScript + Vite: video library and playback/cast screen using
             Google Cast's Web Sender SDK (cast.framework).
```

## Useful commands

- `npm run dev` — server + client in development mode with hot reload.
- `npm run build` — builds the server (`tsc`) and the client (`vite build`).
- `npm start` — starts the already-built server (also serves the built web app on the same
  port).
- "Update library" button in the web app, or `POST /api/library/rescan` — re-scans the
  configured folders without restarting the server.

---

# En español

# Screen Cast

Web (Vue 3 + TypeScript) y servidor (Node + Express + TypeScript) para castear vídeos locales —
con sus pistas de subtítulos incrustadas (MKV, etc.) — a una TCL Smart TV con Google TV / Android TV,
usando Chromecast built-in (Google Cast).

## Cómo funciona

1. El servidor escanea una o varias carpetas de tu PC en busca de vídeos y lee sus metadatos
   (duración, códecs, pistas de subtítulos) con `ffprobe`.
2. La web (Vue) lista tu biblioteca. Cada vídeo tiene dos botones: "📡 Castear" y "▶ Reproducir".
   Los dos abren un popup sobre la propia biblioteca en vez de navegar a una página aparte, pero la
   URL sigue cambiando (`/play/:id` o `/ver/:id`) — así que puedes recargar la página o compartir
   ese enlace: si entras directamente por esa URL, primero se carga la biblioteca y el popup
   correspondiente se abre solo en cuanto está lista.
3. "📡 Castear" usa el SDK de Google Cast para conectar con tu TV (deben estar en la misma red
   WiFi) y controlar la reproducción de forma remota (play/pausa, volumen, subtítulos, buscar en la
   línea de tiempo). "▶ Reproducir" reproduce el vídeo directamente en el navegador con el
   `<video>` nativo del navegador (con controles que incluyen pantalla completa) — útil para ver
   algo rápido sin encender la TV
   (ver [Reproducción local en el navegador](#reproducción-local-en-el-navegador)).
4. Si el vídeo ya es compatible con el destino (Chromecast o el propio navegador — no siempre es
   lo mismo, ver más abajo), se envía tal cual. Si no (por ejemplo un `.mkv`), el servidor lo
   reempaqueta (remux, sin recodificar) o recodifica a MP4 la primera vez y lo cachea en disco.
5. Como tus subtítulos están incrustados en el contenedor y no en archivos `.srt` sueltos, el
   servidor extrae cada pista de subtítulos a WebVTT (`.vtt`) con `ffmpeg` la primera vez que se
   pide, y la sirve como pista de texto aparte — así el receptor de Cast (o el propio navegador)
   la puede pintar sobre el vídeo.

## Filtro de "vídeos recientes"

Por defecto, el escaneo **ni siquiera lee con `ffprobe`** los vídeos modificados hace más de
`RECENT_MONTHS` meses (3 por defecto, configurable en `server/.env`) — así el escaneo es rápido
aunque tengas una biblioteca antigua grande. En la web hay una casilla "Incluir también vídeos con
más de N meses": al activarla se lanza un nuevo escaneo que sí prueba esos vídeos antiguos y los
añade a la biblioteca; al desactivarla, el siguiente escaneo vuelve a dejarlos fuera (no se
"pierden" — sus miniaturas/remuxes cacheados en `server/.cache` se reutilizan al instante si los
vuelves a incluir más adelante, solo hay que releer su metadata).

## Estilo de los subtítulos

En "🎨 Ajustes" (botón junto a "Actualizar biblioteca") puedes personalizar cómo se ven los
subtítulos en la TV: tamaño y estilo de la fuente, tipo de letra, color y opacidad del texto, del
fondo y del borde, y si aparecen sobre una caja sólida o con esquinas redondeadas. Hay una vista
previa en vivo mientras ajustas cada valor.

Al guardar, el estilo se escribe en `server/data/subtitle-style.json` (se crea la primera vez que
guardas; no se versiona en git) y se aplica automáticamente la próxima vez que casteas un vídeo. Si
ya estás casteando algo en ese momento, el cambio se manda a la TV al instante, sin tener que
recastear.

También puedes cambiar la **posición vertical** de los subtítulos (arriba/centro/abajo). Esta no
viaja por la API de estilo de Cast (que no tiene noción de posición) — el servidor reescribe el
ajuste `line:` de cada cue al servir el archivo `.vtt`, así que a diferencia del resto del estilo
no se actualiza en caliente: se aplica la próxima vez que cambias de pista de subtítulos o vuelves
a castear.

## Reproducción local en el navegador

El botón "▶ Reproducir" reproduce el vídeo directamente en tu navegador (sin pasar por la TV), con
los controles nativos del `<video>` del navegador — incluida la pantalla completa, sin necesidad de
un botón aparte.

**Nota sobre códecs (HEVC/H.265):** Chromecast/Google TV decodifica HEVC en hardware sin problema,
así que un archivo en HEVC se envía tal cual a la TV. La mayoría de navegadores de escritorio
(Chrome/Firefox en Windows sin un decodificador de hardware con licencia) no pueden decodificar
HEVC en un `<video>` — el síntoma es que se oye el audio y se ven los subtítulos con normalidad,
pero la imagen se queda en negro. Por eso el servidor mantiene, además de la caché pensada para la
TV, una caché **independiente** para reproducción en navegador: si el vídeo no está ya en H.264, lo
transcodifica a H.264 la primera vez que le das a "Reproducir" (puede tardar unos segundos, verás
"Preparando vídeo…") y lo cachea aparte, sin tocar el archivo que se le sirve a la TV.

**Preparar con antelación:** como esa primera transcodificación puede tardar, cada miniatura de la
biblioteca tiene un botón en la esquina superior izquierda para lanzarla de antemano, sin necesidad
de abrir el popup de "Reproducir" — útil para dejar varios vídeos listos con tiempo antes de verlos
(por ejemplo desde el móvil, antes de un viaje). El icono indica el estado de ese vídeo para
reproducción en navegador:

- ⬇️ (botón activo) — aún no está listo; un clic empieza a prepararlo.
- ⏳ — se está preparando ahora mismo.
- ✅ (tick verde) — ya está listo para reproducirse al instante, sin transcodificar (porque ya es
  H.264/VP8/VP9, o porque ya se preparó antes y sigue en caché).

## Eliminar vídeos

Puedes borrar un vídeo desde tres sitios: la papelera en la esquina superior derecha de su
miniatura en la biblioteca, o el botón "🗑 Eliminar" dentro de cada uno de los popups de Castear y
de Reproducir. En los tres casos aparece un popup de confirmación antes de borrar nada.

Al confirmar, el servidor elimina el **archivo original del disco** (no solo lo quita de la
biblioteca) y todos sus archivos cacheados (remuxes/transcodificaciones, subtítulos extraídos,
miniatura). **Es irreversible** — no hay papelera de reciclaje ni deshacer.

## Limpieza automática de la caché

`server/.cache` puede crecer bastante con remuxes/transcodificaciones de vídeos grandes, así que el
servidor se limpia solo en dos momentos:

- **Al arrancar** (`npm run dev` o `npm start`): borra los `.mp4` cacheados (tanto el pensado para
  Chromecast como el de navegador) que no sean de ese mismo día — la caché existe para que
  reproducir dos veces seguidas sea instantáneo, no para acumular vídeos recodificados
  indefinidamente. Los `.vtt` (subtítulos) y `.jpg` (miniaturas) no se tocan aquí, pesan poco.
- **Al escanear la biblioteca** (al arrancar o al pulsar "Actualizar biblioteca"): borra cualquier
  archivo cacheado (remux, remux de navegador, subtítulos, miniatura) cuyo vídeo ya no esté en el
  índice — porque lo borraste, lo moviste fuera de `MEDIA_DIRS` o le cambiaste el nombre.

Ambas limpiezas son silenciosas si no hay nada que borrar, y si fallan solo avisan por consola sin
interrumpir el arranque ni el escaneo.

## Requisitos

- Node.js 18.18+ (recomendado 20+).
- **ffmpeg y ffprobe** instalados y accesibles en el `PATH` del sistema.
  - Windows: `winget install Gyan.FFmpeg` (o descarga desde https://www.gyan.dev/ffmpeg/builds/ y
    añade la carpeta `bin` al PATH).
  - macOS: `brew install ffmpeg`.
  - Linux: `sudo apt install ffmpeg` (o el gestor de paquetes de tu distro).
- Tu PC y la TCL TV conectados a la **misma red WiFi/LAN**.

## Instalación

```bash
npm install
cp server/.env.example server/.env
```

Edita `server/.env` y define `MEDIA_DIRS` con la(s) carpeta(s) donde tienes tus vídeos, por ejemplo:

```
MEDIA_DIRS=C:\Users\tu-usuario\Videos
```

(en Windows usa rutas con `\`; varias carpetas se separan por comas).

## Modo desarrollo (en tu propio PC, `localhost`)

```bash
npm run dev
```

Esto arranca el servidor (`http://localhost:4000`) y el cliente Vite (`http://localhost:5173`) a
la vez. Abre `http://localhost:5173` en Chrome. Como Google Cast solo exige "contexto seguro" para
`localhost` o HTTPS, en este modo funciona sin certificados — es la forma más rápida de probar
que todo funciona antes de configurar el acceso desde el móvil/otro PC de la casa.

> Nota: aunque abras la web en `localhost`, el vídeo y los subtítulos que se envían a la **TV**
> siempre usan la IP de tu PC en la red local (el servidor la detecta solo), porque la TV no
> entiende "localhost".

## Modo "para castear de verdad" (HTTPS + acceso desde el móvil)

Google Chrome exige que la página desde la que casteas se sirva por **HTTPS** salvo que sea
`localhost`. Si quieres controlar el cast desde tu móvil u otro PC de casa (no el mismo en el que
corre el servidor), necesitas HTTPS con un certificado en el que ese dispositivo confíe.

La forma más simple es [`mkcert`](https://github.com/FiloSottile/mkcert):

```bash
# instala mkcert (una vez)
# Windows (con chocolatey):   choco install mkcert
# macOS:                      brew install mkcert
# Linux: ver instrucciones en el repo de mkcert

mkcert -install
mkcert -key-file server/localhost-key.pem -cert-file server/localhost-cert.pem localhost 127.0.0.1 <IP-DE-TU-PC>
```

Sustituye `<IP-DE-TU-PC>` por la IP local de tu PC (ej. `192.168.1.50` — puedes verla en el log al
arrancar el servidor). Luego, en `server/.env`:

```
HTTPS_KEY=./localhost-key.pem
HTTPS_CERT=./localhost-cert.pem
```

Y arranca en modo "producción" (un único proceso sirve la API y la web ya compilada):

```bash
npm run build
npm start
```

El servidor imprimirá dos URLs: `http://192.168.1.50:4000` y `https://192.168.1.50:4001` (el
puerto HTTPS es el HTTP + 1 por defecto, configurable con `HTTPS_PORT`). Abre la **HTTPS** desde el
navegador del móvil/PC desde el que quieres controlar el cast (ese dispositivo necesita confiar en
el certificado — o bien tiene instalada la CA raíz de mkcert, o lo aceptas manualmente si Chrome
avisa de certificado no confiable).

La propia TV **nunca** usa el puerto HTTPS ni necesita confiar en el certificado: el vídeo, los
subtítulos y las miniaturas siempre se le envían por el puerto HTTP normal, porque es el
Chromecast/TV quien los descarga directamente (no el navegador), así que da igual desde qué
protocolo hayas abierto la página — la reproducción en la TV no depende de esto.

## Limitaciones conocidas

- **Subtítulos en formato imagen** (PGS/VobSub/DVB, típicos de rips de Blu-ray) no se pueden
  convertir a WebVTT — la web los marca como "no disponibles". Los subtítulos de texto (SRT, ASS,
  `mov_text`) sí funcionan.
- La primera vez que casteas un vídeo no compatible (p. ej. un `.mkv`), el servidor tarda unos
  segundos en reempaquetarlo antes de poder reproducirlo; las siguientes veces es instantáneo
  (queda cacheado en `server/.cache`).
- Si el vídeo usa un códec que ni Chromecast ni un simple remux soportan, con
  `ALLOW_TRANSCODE=true` (por defecto) el servidor lo recodifica con `libx264`/`aac` — más lento y
  usa CPU, pero funciona con casi cualquier archivo.
- El descubrimiento de la TV depende de mDNS/Cast en tu red; si tu router aísla los dispositivos
  WiFi entre sí ("AP/client isolation"), la TV no aparecerá como destino de cast.
- Reproducir en el navegador (no castear) un vídeo en HEVC/H.265 tarda unos segundos la primera
  vez, porque se transcodifica aparte de la copia que se le sirve a la TV — ver
  [Reproducción local en el navegador](#reproducción-local-en-el-navegador).

## Si guardas cambios y no ves el efecto (unidades de red/virtuales)

Si el proyecto vive en una unidad que no es un disco local normal (una unidad de red, una unidad
`subst`, un disco virtual, una carpeta sincronizada en la nube...), tanto `tsx watch` (servidor)
como Vite (cliente) pueden no detectar los cambios de archivo automáticamente — Windows no siempre
manda las notificaciones de cambio a través de ese tipo de unidades. El síntoma es justo este: guardas
un cambio, reinicias, y sigue comportándose como antes.

Ya está configurado para usar "polling" (comprobar los archivos activamente en vez de esperar un
aviso del sistema) tanto en Vite como en `tsx watch`, lo que lo hace más robusto en estos casos —
si acabas de actualizar el proyecto, ejecuta `npm install` de nuevo para instalar `cross-env` (usado
para activarlo). Aun así, si algún cambio no se refleja:

1. Para **completamente** ambos procesos (Ctrl+C hasta que vuelva el prompt) y cierra la terminal.
2. Ábrela de nuevo y lanza `npm run dev`.
3. Para cambios en el servidor, dale también a "Actualizar biblioteca" en la web si el cambio afecta
   a cómo se leen/procesan los vídeos (títulos, filtros, etc.) — un simple reinicio no vuelve a
   escanear la biblioteca por sí solo.

## Estructura del proyecto

```
screen-cast/
  server/    Express + TypeScript: escaneo de biblioteca, ffprobe, remux/extracción con ffmpeg,
             streaming con soporte de Range requests.
  client/    Vue 3 + TypeScript + Vite: biblioteca de vídeos y pantalla de reproducción/cast
             usando el SDK Web Sender de Google Cast (cast.framework).
```

## Comandos útiles

- `npm run dev` — servidor + cliente en modo desarrollo con recarga en caliente.
- `npm run build` — compila servidor (`tsc`) y cliente (`vite build`).
- `npm start` — arranca el servidor ya compilado (sirve también la web compilada en el mismo
  puerto).
- Botón "Actualizar biblioteca" en la web, o `POST /api/library/rescan` — re-escanea las carpetas
  configuradas sin reiniciar el servidor.
