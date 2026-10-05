# Estado actual y próximos pasos

Actualizado el 27 de septiembre de 2026.

## Resumen

Hay tres líneas de trabajo que salen del mismo punto (`2a168a3`, muros, perfiles y vista de clase):

| Línea | Dónde está | En producción |
| --- | --- | --- |
| Sprint 2: muros, perfiles, vista de clase | Base común, incluida en v6 | Sí, entre el 13 y el 15 de septiembre (versión `990cecc9`) |
| Sprint 1 v6: núcleo de datos y permisos | Rama `sprint-1-v6-core`, que pasa a `main` con la PR #3 | **Sí, desde el 15 de septiembre** (despliegue de `2285f8e` por GitHub Actions) |
| Sprint 3: cuentas por correo, retos, guardado robusto | Rama `feature/correo-retos-guardado` (`87e0d2c`), revertida en `main` | No |

Hasta la PR #3, `main` no reflejaba lo publicado. Al unirla, el código de `main` coincide con el que está en producción.

## Qué pasó con la PR #1

La PR #1 unió el Sprint 3 en `main` el 27 de septiembre, y la PR #2 la revirtió ese mismo día por tres motivos:

1. El Sprint 3 se construyó sobre `2a168a3` y no sobre v6, que es lo que está publicado. Desplegarlo retiraría el modelo v6 de producción: USER, MEMBERSHIP, roles por grupo y WALL persistente.
2. Las dos ramas usan el mismo número de migración con contenido distinto: `0005_core_v6.sql` y `0005_accounts_challenges.sql`.
3. Las dos resuelven la identidad de forma incompatible. El Sprint 3 propone entrar con correo y enlace o código. v6 planifica vincular Google OAuth desde YO con `sub` verificado.

La PR #1 no llegó a desplegarse, y D1 remoto no tiene `0005_accounts_challenges.sql`. El trabajo sigue disponible en su rama. Para recuperarlo entero habría que revertir la PR #2; volver a unir la rama no funciona. La opción recomendada es rescatarlo por partes sobre v6 (paso 4).

## Próximos cambios, en orden

### 1. Revertir la PR #1 — hecho

- PR #2 unida el 27 de septiembre. `main` volvió a tener el contenido de `2a168a3`.

### 2. Alinear `main` con producción

- PR #3: `sprint-1-v6-core` a `main`, con este documento. Está comprobado que se une sin conflictos.
- Antes de unir, confirmar el estado de D1 remoto con `pnpm exec wrangler d1 migrations list photown-db --remote`. Según la auditoría del 14 de septiembre, ya tiene las tablas v6.
- Ejecutar los recorridos Playwright de v6, que no se pudieron correr en su sprint.
- A partir de aquí, `main` es la rama desplegable. Los workflows `cloudflare-deploy.yml` y `cloudflare-diagnose.yml` se disparan desde `main` (cuando cambia su propio archivo, o a mano desde Actions).

### 3. Sprint 2 v6: identidad y ownership

Plan completo en [sprint-2-v6-identity-ownership.md](sprint-2-v6-identity-ownership.md).

- Correo canónico: sin puntos solo en `gmail.com`. Reconciliar la colisión `gofio.design` / `gofiodesign`.
- Migración `0006_identity_ownership.sql`: rol `owner`, un owner por grupo, auditoría de roles.
- Bootstrap de owner para los 3 grupos que no lo tienen, con una lista privada fuera de Git.
- Vinculación voluntaria de Google desde YO, con `state`, `nonce` y PKCE.
- Hacer copia de D1 antes de migrar y tener preparado el SQL compensatorio para un rollback.

### 4. Rescatar el Sprint 3 sobre v6

Reimplementarlo sobre el modelo v6 en lugar de unir la rama. Para cada pieza hay que decidir si entra:

| Pieza | Propuesta |
| --- | --- |
| Cola local de subidas (IndexedDB, Background Sync) | Rescatar. Es independiente de la identidad. |
| JPEG en Safari y miniaturas de 720 px | Rescatar. Añadir `content_type` y `thumb_key` a PHOTO. |
| Retos y guías de composición | Rescatar sobre GROUP y WALL de v6. |
| Reacciones y avisos en la app | Rescatar sobre USER y MEMBERSHIP. |
| Entrada con correo, enlace y código | **Planificado: magic link** (ver abajo). Convive con Google. |
| Invitaciones por correo y resúmenes | Rescatar después de la identidad, con el mismo proveedor gratuito que el magic link. |

La migración se renumera a partir de `0007`. No se reutiliza `0005`.

#### Magic link (entrada por correo)

Decidido el 1 de octubre de 2026: se añade la entrada con enlace mágico por correo. Por defecto **convive con Google**: cualquiera de los dos inicia sesión en el mismo USER.

- Partir del código del Sprint 3 (`server/accounts.js`, `server/mail.js` en `87e0d2c`), adaptado a USER e `identity_providers` de v6, con proveedor `email` junto a `google`.
- Enlace de un solo uso, guardado como hash, caducidad de 20 minutos, con página de confirmación para que los escáneres de correo no lo consuman. Código de 6 cifras como alternativa para la PWA de iPhone.
- Respuesta idéntica exista o no la cuenta, y límite de solicitudes por correo.
- Si el correo coincide con una identidad Google ya vinculada, se entra en el mismo USER (correo canónico del Sprint 2 v6).
- Envío con un proveedor gratuito al principio (decidido el 4 de octubre de 2026): Resend por defecto, con Brevo como alternativa. Cloudflare Email Sending exige el plan Workers Paid para enviar a cualquier dirección. El Worker llama a la API del proveedor con `fetch`; la clave va como secreto (`RESEND_API_KEY`) y el dominio verificado en Resend es el subdominio `photown.gofiodesign.eu` (registros DNS que pide el proveedor). El remitente será `PhoTown <acceso@photown.gofiodesign.eu>`, configurable con la variable `MAIL_FROM`. El envío queda aislado en `server/mail.js` para poder cambiar de proveedor sin tocar el resto.
- Implementado el 5 de octubre de 2026 (migración `0007_email_login.sql`, `server/email-login.js`): quien participa vincula su correo desde Personalización con un código o enlace que solo vale en el mismo navegador. Después entra con «Entrar con mi correo» en cualquier dispositivo y recupera su mismo USER, sus fotos y sus grupos; cada dispositivo tiene su propia sesión de un año. Un correo ya vinculado a otro USER no se fusiona: se informa del conflicto y no cambia nada. La entrada administrativa sigue siendo con Google, y la coincidencia con una identidad Google llegará con la vinculación de Google desde YO.

#### Giro, retos y zonas quemadas (5 de octubre de 2026)

- Migración `0008_rotation_challenges.sql`: `photos.rotation` (0/90/180/270), tabla `challenges` y `photos.challenge_id`.
- Girar: owner, admin y moderator del grupo, desde el visor del muro (con su sesión de Google abierta) o desde Gestionar grupo. El giro es solo de presentación; el archivo en R2 no cambia y las descargas se giran en el navegador.
- Retos: owner y admin los crean, editan, cierran y reabren en Gestionar grupo, con una guía de composición (tercios, proporción áurea, espiral, diagonales, centro). Aparecen en la cámara y como filtro en el muro.
- Cámara: botón «Quemados» que marca en rojo los píxeles a 255 y en azul los de 0. Solo superpuesto, nunca se guarda en la foto.
- Muro y YO en rejilla cuadrada uniforme de 3 columnas.

#### Invitaciones por correo (5 de octubre de 2026)

- Migración `0009_email_invitations.sql`, `server/invitations.js`. Owner y admin invitan desde Administración con «Invitar por correo», hasta 20 correos cada vez, con el mismo proveedor que el magic link.
- Cada persona recibe un enlace de un solo uso que caduca en 7 días (`/invite`). Al aceptarlo entra en el grupo y su correo queda vinculado, así que después puede usar «Entrar con mi correo». Si el correo ya pertenece a un USER, el enlace abre ese mismo USER en el dispositivo.
- La invitación con código sigue funcionando igual.

#### Exposición manual en la cámara (5 de octubre de 2026)

- Botón «Exposición» en la cámara, solo si el navegador expone el control (Chrome en Android, según el móvil): Manual con velocidad e ISO en pasos fotográficos, o Auto con compensación ±EV. Usa `applyConstraints` sobre la pista de vídeo (`public/exposure.js`).
- Safari en iPhone no permite estos ajustes desde una web: allí no aparece el botón. La apertura F es fija en los móviles.

### 5. Cámara móvil y accesibilidad

- Alternar cámara frontal y trasera manteniendo el BN, la orientación y el espejo de la frontal.
- Pruebas físicas en iPhone/Safari y Android/Chrome: permisos, instalación de la PWA, vertical y horizontal, JPEG, cola sin conexión.
- VoiceOver, TalkBack y zoom al 200 %. Queda pendiente la lista de aceptación de `docs/sprint-1.md`.

### 6. Weekly Review

- Elegir la semana (semana ISO, lunes, Atlantic/Canary; confirmar antes de implementar), orden estable, contador, flechas y Escape.
- Vista para escritorio, TV y proyector.

### 7. Piloto

- Revisar privacidad, borrado, límites y procedimientos administrativos.
- Normalizar el BN en el servidor para clientes manipulados.
- Piloto con 5–10 personas durante una semana.

## Aplazado

- Notificaciones push del sistema (Web Push).
- Anotaciones con líneas y círculos en el muro de clase.
- Superadmin limitado a eliminar o resetear grupos (antes hay que definir qué conserva un reseteo).
- Aviso de exposición para luces quemadas y sombras sin detalle, sin depender solo del rojo.
- Alias `+tag` y equivalencia de `googlemail.com`.
