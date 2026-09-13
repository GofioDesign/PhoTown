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
- HTTPS del dominio personalizado verificado con resolución autoritativa de Cloudflare y certificado válido: `/api/admin/session` devuelve 200 y administración configurada. Algunos resolutores aún conservaban una respuesta negativa anterior durante la comprobación.
- Invitaciones compartibles con `?inv=`, código visible rellenado y retirada del parámetro de la dirección. Generación de 8 caracteres no ambiguos y aceptación de minúsculas verificadas en servidor y recorrido real de administración/entrada en navegador local.
- Recuperación de identidad: prueba de servidor de autorización, aislamiento por grupo, conservación de moderación, no recuperación de borrados, bloqueo del origen y repetición idempotente. Recorrido de navegador con eliminación de cookies, nueva participación, copia de identidad, reasignación administrativa y fotos visibles en la nueva identidad. Nueve pruebas de comunidad superadas.
- Descarga individual de Mis fotos verificada en navegador (archivo WebP descargado sin error) y servidor (propietario autorizado; otra identidad y fotografía borrada rechazadas). No se modifica el archivo ni se publica R2.
- Ampliación posterior: 19 pruebas de servidor superadas y los 9 recorridos de navegador superados (los casos corregidos se ejecutaron de nuevo). Alias por grupo, atribución, ampliación y foco al cerrar, cambio de grupo y envío a dos grupos con respuesta perdida y reintento sin duplicado comprobados.
- Disparador dentro del visor y visible a 320×568, 360×640 y 390×844. Pantalla completa entra/sale en Chrome de pruebas. Manifiesto, icono e instrucciones de instalación comprobados. La instalación y cámara en iPhone/Android físicos siguen pendientes.
- Service worker sin caché de fotografías, sesiones, invitaciones ni respuestas privadas; pantalla informativa cuando falla una navegación sin conexión.

Referencias: [MDN: aplicaciones instalables](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Making_PWAs_installable) y [modo standalone](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/How_to/Create_a_standalone_app).

## Sprint 2 — 13 de septiembre de 2026

- 22 pruebas de servidor superadas: archivo personal entre grupos, aislamiento entre propietarios, conservación de copias independientes y autorización reiterada al borrar tras una recuperación de identidad; lista de espera, validación, deduplicación, acceso administrativo y borrado.
- 11 recorridos de Chrome con D1/R2 locales superados en la ejecución final. Incluyen los flujos anteriores de captura BN, permisos, reintentos, renovación de sesión, moderación y recuperación, adaptados al nuevo modelo de navegación.
- YO y muro en mosaico, imagen completa, ALT con metadato accesible, alias solo en ampliación, modo zurdo persistente, cambio de grupo, envío a varios grupos y borrado de una sola copia verificados.
- Pulsación larga, alternativa de selección desde Personalización, ZIP de originales y borrado múltiple interrumpido/reintentado verificados. El contenido del ZIP coincide byte a byte con las descargas individuales; un lector estándar independiente comprueba su integridad CRC.
- Axe sin violaciones automáticas WCAG 2 A/AA y 2.1 AA en entrada, formulario de espera, administración, cámara, preview, YO, muro, foto ampliada, selección y Personalización. No sustituye validación manual ni certifica conformidad.
- Capturas visuales revisadas en móvil y escritorio. Cámara/shutter dentro del viewport a 320×568, 360×640 y 390×844; entrada/salida de pantalla completa y ayuda de instalación verificadas.
- Sintaxis y empaquetado correctos. Migración 0003 aplicada en local y producción: solo tabla/índice de espera.
- Versión publicada: `5b05e0c5-0e2a-423d-934b-4f3c6c2a1c39`.
- HTTPS del dominio personalizado: entrada, módulos JS, CSS y manifiesto responden 200. Los cinco recursos modificados coinciden por SHA-256 con los archivos probados. Archivo personal y lista administrativa sin sesión responden 401. Email inválido rechazado con 400 sin registro. Dominio workers.dev sigue sirviendo la versión nueva.
- No se crearon participantes, fotos ni solicitudes reales para esta comprobación remota. Las pruebas funcionales con datos se realizaron localmente.
- Pendiente: cámaras e instalación en iPhone/Android físicos, lectores de pantalla y validación con participantes. Cambio selfie/trasera y Weekly Review permanecen para próximos sprints.
