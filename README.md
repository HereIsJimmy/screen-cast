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
   `<video>` nativo (con botón de pantalla completa) — útil para ver algo rápido sin encender la TV
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
los controles nativos del `<video>` más un botón de pantalla completa.

**Nota sobre códecs (HEVC/H.265):** Chromecast/Google TV decodifica HEVC en hardware sin problema,
así que un archivo en HEVC se envía tal cual a la TV. La mayoría de navegadores de escritorio
(Chrome/Firefox en Windows sin un decodificador de hardware con licencia) no pueden decodificar
HEVC en un `<video>` — el síntoma es que se oye el audio y se ven los subtítulos con normalidad,
pero la imagen se queda en negro. Por eso el servidor mantiene, además de la caché pensada para la
TV, una caché **independiente** para reproducción en navegador: si el vídeo no está ya en H.264, lo
transcodifica a H.264 la primera vez que le das a "Reproducir" (puede tardar unos segundos, verás
"Preparando vídeo…") y lo cachea aparte, sin tocar el archivo que se le sirve a la TV.

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
