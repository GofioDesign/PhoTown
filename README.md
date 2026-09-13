# PhoTown

Un diario fotográfico compartido para mirar, fotografiar y aprender juntos.

## Sprint 1 — Camera

Implementado: entrada mínima, invitación privada, cámara **en blanco y negro en directo**, captura BN, vista previa, repetir, enviar y almacenamiento privado en R2. Interfaz en español, responsive, sin selector de archivos ni acceso al carrete. Sin bibliotecas de UI, fuentes externas ni servicios de seguimiento.

La fotografía se conserva en memoria cuando falla el envío y los reintentos usan el mismo identificador. «Fotografía guardada» significa almacenamiento confirmado; todavía no significa publicación en el muro.

**Este sprint no es el MVP completo.** Publisher/identidad persistente, D1, estados de publicación, semanas, muro, moderación y revisión pertenecen a los siguientes sprints. La cookie actual solo concede acceso temporal al grupo; no representa un publisher. Las capturas de este sprint son datos técnicos de prueba sin autor, no un archivo del piloto para migrar automáticamente a identidades futuras.

## Ejecutar en local

Requisitos: Node.js 22 o posterior y pnpm 11 (lockfile incluido). No hace falta una cuenta de Cloudflare para la simulación local.

```sh
pnpm install --frozen-lockfile
cp .dev.vars.example .dev.vars
# Sustituir INVITE_CODE por >=24 caracteres aleatorios y SESSION_SECRET por >=32.
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
3. Crear un bucket privado con `pnpm exec wrangler r2 bucket create photown-photos` o cambiar `bucket_name` en `wrangler.jsonc` al bucket privado de la instalación. **No activar r2.dev ni un dominio público de R2.**
4. Configurar secretos independientes de desarrollo mediante `pnpm exec wrangler secret put INVITE_CODE` y `pnpm exec wrangler secret put SESSION_SECRET`. Usar valores aleatorios largos; no incluirlos en código, URLs o GitHub.
5. Ejecutar `pnpm build` para validar el paquete y `pnpm deploy` para publicar en la cuenta seleccionada.
6. Comprobar desde otro navegador que `/camera` redirige a invitación y que `POST /api/photos` sin cookie no permite escribir. Realizar la lista de pruebas móviles antes de invitar participantes.

El código no despliega automáticamente desde GitHub ni habilita un bucket público. El repositorio público contiene únicamente código y documentación: ninguna foto ni credencial. `noindex` es complementario a la autenticación; no la sustituye.

## Decisiones técnicas

- Worker con Static Assets, ejecución del Worker antes de los recursos y R2 enlazado; D1 se incorpora al construir Identity/Photo.
- Acceso mediante código y cookie firmada HMAC, HttpOnly, SameSite=Strict, 12 horas y Secure bajo HTTPS. Rotar `SESSION_SECRET` revoca todas las sesiones; cambiar solo la invitación no revoca las ya emitidas.
- POST exige mismo origen; errores sin tokens, cookies, archivos ni secretos en logs. No hay rutas de lectura/listado de R2 ni rutas administrativas en este sprint.
- Límite de 5 MiB, cuerpo leído con límite real, validación de contenedor WebP estático y dimensiones, retirada de EXIF/XMP/ICC en servidor. R2 guarda los bytes y metadatos técnicos mínimos (fecha del servidor, dimensiones, hash, etapa).
- Un UUID por captura y creación condicional en R2 impiden duplicados incluso si se pierde la respuesta o se renueva la sesión. Reutilizar el UUID con bytes distintos devuelve conflicto.
- Límites orientativos: 10 accesos/minuto por IP hasheada y 12 envíos/minuto por sesión. El rate limiting de Workers es aproximado y por ubicación; no es una cuota global ni defensa contra abuso distribuido. No se guardan IP en R2.
- Tamaño provisional de 2560 px de lado mayor, sin ampliación, WebP 0.88. Comparar fotografías reales antes de fijarlo como criterio definitivo para Review.
- La vista en directo usa CSS `grayscale(1)` y la captura los mismos coeficientes de luminancia. Se muestra todo el encuadre mediante `object-fit: contain`.

Limitación explícita: el servidor valida el contenedor, pero no decodifica el códec ni demuestra que los píxeles sean BN o que provengan de una cámara. El flujo oficial sí produce BN; un cliente HTTP manipulado podría enviar otro WebP. Antes de un piloto con participantes no confiables hay que añadir decodificación/normalización de imagen en servidor y evaluar su coste. No se promete impedir importaciones desde clientes manipulados usando únicamente APIs de navegador.

## Estructura

```text
public/           Entrada, cámara, preview y procesamiento local
server/           Worker, acceso privado y validación de WebP
tests/            Pruebas de servidor y de navegador
docs/             Alcance, decisiones pendientes y pruebas manuales
wrangler.jsonc    Worker, Static Assets, R2 y rate limiting
```

La [licencia existente](LICENSE) se conserva.
