# Sprint 3 — Cuentas por correo, retos y guardado robusto

## Qué cambia para quien participa

- **Entrar con el correo, sin contraseña.** Quien coordina invita por correo; la persona recibe un enlace y un código de 6 números. Para volver en otro dispositivo pide un acceso nuevo desde `/login`. El código sirve cuando el enlace se abre en otro navegador (por ejemplo, la PWA de iPhone no comparte sesión con Safari).
- **Fotos guardadas en el dispositivo hasta enviarse.** Al pulsar Enviar la foto va a una cola local (IndexedDB). Sin conexión o con la sesión caducada no se pierde: se envía al volver la conexión, al reabrir la app o con «Enviar ahora». En Chrome/Android el service worker la envía aunque la app esté cerrada (Background Sync).
- **Safari y navegadores sin WebP.** Si el navegador no sabe codificar WebP, la captura se guarda en JPEG. El servidor acepta ambos y en los dos casos quita los metadatos.
- **Miniaturas.** Cada captura sube también una copia de 720 px para el muro. El visor sigue cargando el original.
- **Retos con guías de composición.** Cada grupo puede tener retos (título, propuesta, guía y fecha de cierre opcional). Desde el reto, la cámara abre con su guía: tercios, proporción áurea, espiral áurea (se puede girar), diagonales o centro. Las guías también se pueden usar sin reto. Solo se dibujan en pantalla: nunca aparecen en la foto. Cada reto tiene su propio muro.
- **Reacciones:** Me gusta, Buena luz, Buena composición y Buena idea. Todo el grupo ve los recuentos; quien hizo la foto solo los lee.
- **Avisos:** se avisa de fotos nuevas en el grupo, reacciones a tus fotos, fotos aprobadas y retos nuevos. Aparecen en la campana y, si la persona no lo desactiva en Personalización, llega un resumen por correo como mucho una vez por hora.

## Administración

- Grupos con recuento de participantes, retos abiertos y fotos por revisar.
- Pestañas por grupo: **Fotos** (solo pendientes por defecto), **Invitar** (varios correos a la vez; reenviar o retirar), **Retos** (crear, cerrar, reabrir, ver en el muro de clase) y **Participantes** (con su correo).
- El muro de clase permite filtrar por reto.
- Los administradores reciben cada hora un correo si hay fotos nuevas esperando aprobación.
- Desaparecen los códigos de grupo. Los enlaces antiguos `/enter?inv=` explican que ahora se entra con el correo.

## Migración de participantes actuales

Las identidades anónimas existentes siguen funcionando en su navegador. Si esa persona pide un acceso con su correo y abre el enlace **en el mismo navegador**, el correo queda vinculado a su identidad y conserva sus fotos. Después puede entrar desde cualquier dispositivo. Personalización muestra «Vincular mi correo» a quien todavía no lo tiene.

La recuperación manual de identidad sigue en Participantes → «Recuperar fotos de una identidad anterior», solo para identidades sin correo.

## Puesta en marcha en Cloudflare

1. **Email Sending:** en el panel de Cloudflare, *Email → Email Sending*, dar de alta `gofiodesign.eu`. Cloudflare añade los registros SPF, DKIM y DMARC. El servicio está en beta pública: revisar sus condiciones y límites de envío en la cuenta. El remitente es `MAIL_FROM` (`photown@gofiodesign.eu`) y el binding `EMAIL` está en `wrangler.jsonc`.
2. **Migración D1:** `pnpm exec wrangler d1 migrations apply photown-db --remote` (aplica `0005_accounts_challenges.sql`).
3. **Desplegar:** `pnpm build` y `pnpm deploy`.
4. **Primeras invitaciones:** en `/admin` → grupo → Invitar. Si el correo no está configurado, el panel lo indica y las invitaciones se guardan sin enviarse.
5. `INVITE_CODE` ya no se usa con D1 y se puede borrar de los secretos.

## Seguridad y privacidad

- Los enlaces de acceso caducan en 20 minutos y los de invitación en 7 días. Son de un solo uso, se guardan como hash y el código admite 5 intentos. Hay como mucho 3 solicitudes cada 10 minutos por correo.
- La respuesta a «pedir acceso» es idéntica exista o no la cuenta. Los correos sin invitación pasan a la lista de espera sin recibir nada.
- Las sesiones son por dispositivo (1 año) y «Cerrar sesión» invalida la de ese dispositivo.
- El enlace del correo abre una página con un botón de confirmación: los escáneres de correo que visitan enlaces no consumen el acceso.
- Las miniaturas y los originales siguen los mismos permisos. El navegador puede guardar su copia privada durante una hora. Borrar una foto elimina también la miniatura, las reacciones y los avisos asociados.
- `DEV_LOGIN_LINKS=true` solo actúa en `localhost` y existe para las pruebas automáticas. No configurarlo en producción.

## Pendiente

- Probar en iPhone/Android físicos: JPEG en Safari, cola sin conexión, enlace y código con la PWA instalada.
- Notificaciones push del sistema operativo (Web Push). De momento los avisos son dentro de la app y por correo.
- Lecciones o cursos estructurados sobre los retos, si se quieren más adelante.
