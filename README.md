# PhoTown

Un diario fotográfico compartido para mirar, fotografiar y aprender juntos.

Dominio de la instalación: https://photown.gofiodesign.eu (acceso mediante invitación privada). Administración: https://photown.gofiodesign.eu/admin.

La dirección anterior https://photown.photown.workers.dev sigue habilitada durante la transición. Las identidades de participante se guardan por dominio; véase [la guía](docs/google-admin.md).

## Versión actual — transición al núcleo v6

La migración `0005_core_v6.sql` incorpora USER, proveedores OAuth, membresías con PAR-ID, roles y estados separados, configuración de GROUP, PHOTO con origen único y WALL persistente. Conserva las tablas anteriores como puente para migrar el cliente sin perder datos.

La invitación visible lleva al muro del grupo. La navegación fija **YO — cámara — grupo activo** sustituye el menú anterior. Los muros son mosaicos de fotografías que conservan su proporción; la cabecera PHOTOWN y el botón de personalización permanecen fijos. El modo zurdo invierte los laterales y se guarda en el dispositivo.

**YO** reúne todas las copias de la identidad actual, incluso las de otros grupos. Una foto se abre a pantalla completa: ALT para crear/editar descripción, descarga del WebP original disponible y eliminación confirmada. Pulsar prolongadamente activa selección múltiple; también se puede entrar desde Personalización o con Mayús+Espacio. Las descargas múltiples generan un ZIP (hasta 50 fotos y 100 MB por operación); los borrados parciales permiten reintentar las pendientes.

Las copias históricas existentes en distintos grupos se conservan como PHOTO independientes y no se fusionan por hash. Para nuevas capturas, CAMERA fija un único GROUP de origen y ya no permite publicar la misma captura simultáneamente en varios grupos. La descripción y el alias por grupo continúan separados durante la transición.

La cámara BN y la captura ocupan el viewport sin navegación inferior ni scroll. El disparador está sobre el visor. La vista previa muestra el GROUP de origen fijado al capturar. El envío vuelve al muro y los reintentos conservan el mismo identificador y origen.

YO permite editar alias y foto identificativa por grupo. Los grupos aparecen como círculos con portada aprobada cuando hay varios; con uno solo, su muro muestra únicamente YO y shutter abajo. Las fotos tienen marcos y ALT directo; YO añade casilla de selección y acciones de descarga/eliminación. La barra múltiple usa iconos y contador compacto.

Administración incluye un enlace «Muro» en cada grupo para usarlo en clases de escritorio. Muestra solo fotos aprobadas y permite ampliarlas sobre el muro sin sesión de participante.

Personalización reúne añadir grupo, alias, zurdo/diestro, instalación PWA y la identidad necesaria para recuperación administrativa. Google sigue reservado a administradores. Moderación, bloqueo, privacidad R2 y reasignación de identidad permanecen activos.

**Lista de espera:** el email se guarda en D1; administración permite consultarlo y eliminarlo. Por decisión del usuario no se envían correos ni se concede acceso automático. No necesita proveedor de email. Los duplicados devuelven la misma confirmación sin revelar si la dirección ya estaba registrada.

**Todavía no es el MVP completo:** faltan Weekly Review y la validación del piloto. La alternancia selfie/trasera y las pruebas físicas iPhone/Android siguen pendientes. La PWA necesita conexión y no guarda fotos privadas en caché offline. Consulta [Sprint 2](docs/sprint-2.md), [próximos sprints](docs/next-sprint.md) y [administración](docs/google-admin.md).

## Ejecutar en local

Requisitos: Node.js 22 o posterior y pnpm 11 (lockfile incluido). No hace falta una cuenta de Cloudflare para la simulación local.

```sh
pnpm install --frozen-lockfile
cp .dev.vars.example .dev.vars
# Sustituir INVITE_CODE por >=24 caracteres aleatorios y SESSION_SECRET por >=32.
pnpm exec wrangler d1 migrations apply photown-db --local
pnpm dev
```

En PowerShell, `Copy-Item .dev.vars.example .dev.vars` equivale al comando `cp`. Abre `http://localhost:8787` e introduce el código de `.dev.vars`. Wrangler simula Worker y R2 y persiste los archivos localmente en `.wrangler/`. No se escriben objetos en la cuenta de Cloudflare.

La cámara requiere HTTPS salvo en localhost. Abrir una IP de la red local con HTTP desde el móvil no permite probarla correctamente. Para móviles utiliza una instalación de pruebas HTTPS privada.

## Comprobaciones

```sh
pnpm check
pnpm test
pnpm build
pnpm exec playwright install chromium
# PHOTOWN_TEST_CODE debe contener el mismo código local de .dev.vars.
PHOTOWN_TEST_CODE='tu-codigo-local' pnpm test:browser
```

PowerShell: `$env:PHOTOWN_TEST_CODE='tu-codigo-local'; pnpm test:browser`. Opcionalmente define `PLAYWRIGHT_EXECUTABLE_PATH` con la ruta de Chrome para utilizar un navegador ya instalado. Los tests de navegador levantan Wrangler y usan una cámara sintética; no solicitan acceso a la cámara real. Generan fotografías de prueba en R2 local. No ejecutar contra producción.

Las pruebas cubren conversión BN, acceso, cookies, límites, validación, metadatos, reintentos simultáneos y fallos de almacenamiento. El navegador recorre captura/repetir/envío, decodifica la captura para comprobar sus canales grises y verifica recuperación por falta de red y sesión caducada. Véase [la comprobación manual](docs/sprint-1.md) para Safari/iOS, Android y calidad visual; una cámara sintética no sustituye esas pruebas.

## Preparar Cloudflare

1. Autenticarse con `pnpm exec wrangler login` en la cuenta elegida.
2. Revisar las [tarifas de Workers](https://developers.cloudflare.com/workers/platform/pricing/), [tarifas de R2](https://developers.cloudflare.com/r2/pricing/) y [límites](https://developers.cloudflare.com/workers/platform/limits/). No se presupone gratuidad ni se crea facturación automáticamente con este repositorio.
3. Esta instalación utiliza el bucket privado `photown-photos` con jurisdicción `eu`. Para una instalación nueva equivalente: `pnpm exec wrangler r2 bucket create photown-photos --jurisdiction eu`. Si usas otro bucket, ajustar `bucket_name` y `jurisdiction` en `wrangler.jsonc`. **No activar r2.dev ni un dominio público de R2.**
4. Configurar secretos independientes mediante `pnpm exec wrangler secret put INVITE_CODE`, `pnpm exec wrangler secret put SESSION_SECRET` y `pnpm exec wrangler secret put SUPERADMIN_EMAILS`. Este último admite una lista separada por comas. No incluir códigos, correos administrativos ni secretos en código, URLs o GitHub.
5. Esta instalación utiliza D1 `photown-db`. En una instalación nueva crear la base, ajustar `database_id` y aplicar `pnpm exec wrangler d1 migrations apply photown-db --remote`. Configurar Google según [la guía](docs/google-admin.md). Ejecutar `pnpm build` para validar el paquete y `pnpm deploy` para publicar en la cuenta seleccionada.
6. Comprobar desde otro navegador que `/camera` redirige a invitación y que `POST /api/photos` sin cookie no permite escribir. Realizar la lista de pruebas móviles antes de invitar participantes.

El código no despliega automáticamente desde GitHub ni habilita un bucket público. El repositorio público contiene únicamente código y documentación: ninguna foto ni credencial. `noindex` es complementario a la autenticación; no la sustituye.

## Decisiones técnicas

- Worker con Static Assets, R2 privado y D1 para grupos, publishers, membresías, fotografías y estados temporales de OAuth.
- Identidad aleatoria de navegador (cookie HttpOnly de un año, hash en D1); acceso a grupo firmado de 12 horas. Cookies Secure en HTTPS y SameSite=Strict. Rotar `SESSION_SECRET` revoca las sesiones de acceso; cerrar un grupo impide el acceso inmediatamente.
- Las escrituras exigen mismo origen. La lectura de fotos requiere pertenencia al grupo/propiedad/estado publicado o administración autorizada. No se publican URLs directas de R2.
- Límite de 5 MiB, cuerpo leído con límite real, validación de contenedor WebP estático y dimensiones, retirada de EXIF/XMP/ICC en servidor. R2 guarda píxeles; D1 contiene las referencias y estados. Semana ISO calculada por el servidor en Atlantic/Canary.
- Un UUID por captura y creación condicional en R2 impiden duplicados incluso si se pierde la respuesta o se renueva la sesión. Reutilizar el UUID con bytes distintos devuelve conflicto.
- Límites orientativos: 10 accesos/minuto por IP hasheada y 12 envíos/minuto por publisher. El rate limiting de Workers es aproximado y por ubicación; no es una cuota global ni defensa contra abuso distribuido. No se guardan IP en R2.
- Tamaño provisional de 2560 px de lado mayor, sin ampliación, WebP 0.88. Comparar fotografías reales antes de fijarlo como criterio definitivo para Review.
- La vista en directo usa CSS `grayscale(1)` y la captura los mismos coeficientes de luminancia. Se muestra todo el encuadre mediante `object-fit: contain`.

Limitación explícita: el servidor valida el contenedor, pero no decodifica el códec ni demuestra que los píxeles sean BN o que provengan de una cámara. El flujo oficial sí produce BN; un cliente HTTP manipulado podría enviar otro WebP. Antes de un piloto con participantes no confiables hay que añadir decodificación/normalización de imagen en servidor y evaluar su coste. No se promete impedir importaciones desde clientes manipulados usando únicamente APIs de navegador.

## Estructura

```text
public/           Entrada, cámara, preview y procesamiento local
server/           Worker, identidad, grupos, OAuth, moderación y validación WebP
db/migrations/    Modelo D1
tests/            Pruebas de servidor y de navegador
docs/             Alcance, decisiones pendientes y pruebas manuales
wrangler.jsonc    Worker, Static Assets, R2 y rate limiting
```

La [licencia existente](LICENSE) se conserva.
