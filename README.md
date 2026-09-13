# PhoTown

Un diario fotográfico compartido para mirar, fotografiar y aprender juntos.

Dominio de la instalación: https://photown.gofiodesign.eu (acceso mediante invitación privada). Administración: https://photown.gofiodesign.eu/admin.

La dirección anterior https://photown.photown.workers.dev sigue habilitada durante la transición. Las identidades de participante se guardan por dominio; véase [la guía](docs/google-admin.md).

## Versión actual — Camera, grupos y administración

Implementado: entrada con invitación visible, cámara **en blanco y negro en directo**, captura al tocar el visor o mediante botón/teclado, vista previa, repetir y almacenamiento privado en R2. Identidades pseudónimas persistentes, grupos separados, Mis fotos con descripción opcional y borrado permanente, muro con moderación y administración mediante Google. Interfaz en español, responsive y sin acceso al carrete.

La fotografía se conserva en memoria cuando falla el envío y los reintentos usan el mismo identificador. Los participantes nuevos pasan por moderación; los de confianza publican directamente. El bloqueo y los permisos siempre se comprueban en servidor.

**Todavía no es el MVP completo:** falta Weekly Review y la validación del piloto. El alcance se amplió por petición del usuario para incluir grupos, Google administrativo y gestión de fotos propias. Las capturas anteriores del sprint 1 no tienen autor y no se atribuyen automáticamente a ningún participante. Consulta [Google, permisos y accesibilidad](docs/google-admin.md).

En Mis fotos, cada fotografía disponible incluye «Descargar fotografía»: descarga el WebP original en blanco y negro, con acceso restringido a su propietario. Próximas prioridades: [UI y cámaras móviles](docs/next-sprint.md).

Alias opcional por grupo con atribución en el muro, imágenes ampliables y cabecera con selector de grupo. Antes de enviar se eligen uno o varios grupos ya autorizados; cada copia mantiene moderación y borrado independientes. Los reintentos omiten destinos confirmados y deduplican respuestas perdidas.

Disparador sobre el visor, pantalla completa cuando el navegador la admite e instalación como app en modo standalone. «Instalar app» ofrece el diálogo nativo o instrucciones para añadir PhoTown a la pantalla de inicio. La app necesita conexión y no guarda fotos privadas en caché offline.

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
4. Configurar secretos independientes de desarrollo mediante `pnpm exec wrangler secret put INVITE_CODE` y `pnpm exec wrangler secret put SESSION_SECRET`. Usar valores aleatorios largos; no incluirlos en código, URLs o GitHub.
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
