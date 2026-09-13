# Validación del sprint 1

Comprobaciones realizadas el 13 de septiembre de 2026:

- 9 pruebas de servidor/procesamiento con Node.js 24: correctas.
- 4 pruebas de navegador con Chrome en Windows y cámara sintética: correctas.
- Almacenamiento R2 local mediante Wrangler: envío confirmado y reintento tras pérdida de respuesta devuelve el mismo identificador sin crear otra fotografía.
- Fallo de red antes de enviar: captura e identificador conservados para reintentar.
- Sesión eliminada en Preview: renovación de invitación y envío de la misma captura.
- Permiso denegado: explicación de recuperación, disparador deshabilitado y ausencia de selector de archivos.
- Directo con `grayscale(1)` y comprobación de los píxeles decodificados de la captura BN.
- Capturas de interfaz revisadas a 390 × 844 y 1440 × 1000: controles visibles e imagen sin recorte.
- Validación de sintaxis y empaquetado de Worker/Static Assets con `wrangler deploy --dry-run`.

Las pruebas físicas en Safari/iPhone, Android, cambios de orientación y proyector quedan pendientes en [la lista de aceptación](sprint-1.md). Las imágenes de prueba son sintéticas y no se incluyen en Git.

## Instalación Cloudflare, 13 de septiembre de 2026

- Worker `photown` desplegado en `https://photown.photown.workers.dev`.
- Bucket existente `photown-photos`, jurisdicción `eu`, enlazado como `PHOTOS`.
- Verificado: r2.dev deshabilitado y sin dominios públicos del bucket.
- Invitación y firma de sesión de producción configuradas como secretos independientes del entorno local. Sus valores no se incluyen en Git.
- Cloudflare confirma la ruta workers.dev habilitada y el DNS resuelve.
- Comprobación HTTPS remota superada: entrada disponible, Camera privada y envío sin sesión rechazado; invitación correcta crea cookie Secure/HttpOnly/SameSite=Strict.
- Envío real al bucket europeo superado: primera petición 201 y reintento 200 con el mismo identificador. Se descargó la imagen sintética para comprobar el archivo y se retiró exclusivamente ese objeto de R2 al terminar.
- La negociación TLS falló inicialmente tras crear el subdominio y funcionó en la comprobación posterior, sin cambios adicionales en el Worker. Las pruebas físicas del piloto siguen pendientes.

Documentación oficial consultada para la implementación:

- [Static Assets: configuración](https://developers.cloudflare.com/workers/static-assets/binding/)
- [R2: API de Workers y escrituras condicionales](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)
- [Workers: rate limiting](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)
- [Workers: límites](https://developers.cloudflare.com/workers/platform/limits/)
- [Workers: precios](https://developers.cloudflare.com/workers/platform/pricing/)
- [R2: precios](https://developers.cloudflare.com/r2/pricing/)

## Grupos, administración y accesibilidad — 13 de septiembre de 2026

- 17 pruebas de Node superadas, incluidas separación de grupos, propiedad, moderación, rotación de invitaciones, permisos administrativos, eliminación concurrente con subida y recuperación ante fallo de R2.
- 6 recorridos de navegador superados y una séptima prueba de accesibilidad axe (WCAG 2 A/AA y 2.1 AA) superada en entrada, administración, cámara y preview. No equivale a certificación ni sustituye pruebas con usuarios.
- Sintaxis y empaquetado del Worker verificados. Migración D1 aplicada en producción.
- Prueba HTTPS real: administración configurada, inicio de Google con redirección correcta, entrada con invitación, subida privada pendiente, reintento sin duplicado y aparición en Mis fotos. La única fotografía sintética creada en esta comprobación se eliminó y su lectura devuelve 404.
- Google OAuth configurado como secretos; el inicio de sesión interactivo con las cuentas autorizadas sigue pendiente de comprobación humana.
- Dominio personalizado enlazado al Worker. Zona gofiodesign.eu activa en Cloudflare, plan Free; registro del dominio conservado en Porkbun. Se copiaron los 14 registros anteriores, incluidos MX/SPF y verificaciones Google/GitHub. Registros de web anteriores conservados como DNS only.
- Porkbun confirma los servidores chad.ns.cloudflare.com y monroe.ns.cloudflare.com. No había DNSSEC habilitado ni registros de firma existentes que retirar.
- El usuario confirmó la nueva redirección OAuth de photown.gofiodesign.eu. workers.dev permanece disponible durante la propagación y transición de identidades.
