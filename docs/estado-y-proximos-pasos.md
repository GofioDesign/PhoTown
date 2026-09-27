# Estado actual y próximos pasos

Actualizado el 27 de septiembre de 2026.

## Resumen

Hay tres líneas de trabajo que salen del mismo punto (`2a168a3`, muros, perfiles y vista de clase) y no están alineadas:

| Línea | Dónde está | En producción |
| --- | --- | --- |
| Sprint 2: muros, perfiles, vista de clase | `main` tras revertir la PR #1 (`2a168a3`) | Sí, entre el 13 y el 15 de septiembre (versión `990cecc9`) |
| Sprint 1 v6: núcleo de datos y permisos | Rama `sprint-1-v6-core`, sin fusionar | **Sí, desde el 15 de septiembre** (despliegue de `2285f8e` por GitHub Actions) |
| Sprint 3: cuentas por correo, retos, guardado robusto | Rama `feature/correo-retos-guardado` (`87e0d2c`), revertida en `main` | No |

`main` no refleja lo que está publicado. La versión en producción es la de `sprint-1-v6-core`.

## Qué pasó con la PR #1

La PR #1 unió el Sprint 3 en `main` el 27 de septiembre. Se revierte con la PR #2 por tres motivos:

1. El Sprint 3 se construyó sobre `2a168a3` y no sobre v6, que es lo que está publicado. Desplegarlo retiraría el modelo v6 de producción: USER, MEMBERSHIP, roles por grupo y WALL persistente.
2. Las dos ramas usan el mismo número de migración con contenido distinto: `0005_core_v6.sql` y `0005_accounts_challenges.sql`.
3. Las dos resuelven la identidad de forma incompatible. El Sprint 3 propone entrar con correo y enlace o código. v6 planifica vincular Google OAuth desde YO con `sub` verificado.

La PR #1 no llegó a desplegarse, y D1 remoto no tiene `0005_accounts_challenges.sql`. El trabajo sigue disponible en su rama. Para recuperarlo entero habría que revertir la PR #2; volver a unir la rama no funciona. La opción recomendada es rescatarlo por partes sobre v6 (paso 4).

## Próximos cambios, en orden

### 1. Revertir la PR #1

- Unir la PR #2. `main` queda idéntico a `2a168a3`.

### 2. Alinear `main` con producción

- Abrir una PR de `sprint-1-v6-core` a `main`. Como `main` vuelve a tener el contenido de `2a168a3`, que es la base de v6, no debería haber conflictos.
- Antes de unir, confirmar el estado de D1 remoto con `pnpm exec wrangler d1 migrations list photown-db --remote`. Según la auditoría del 14 de septiembre, ya tiene las tablas v6.
- Ejecutar los recorridos Playwright de v6, que no se pudieron correr en su sprint.
- A partir de aquí, `main` es la rama desplegable. El workflow `cloudflare-deploy.yml` solo se dispara desde `sprint-1-v6-core` y hay que cambiarlo a `main`.

### 3. Sprint 2 v6: identidad y ownership

Plan completo en `docs/sprint-2-v6-identity-ownership.md`, que llega a `main` con la PR del paso 2.

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
| Entrada con correo, enlace y código | **Decidir** si convive con OAuth o lo sustituye. Afecta a USER, sesiones y recuperación. |
| Invitaciones por correo y resúmenes (Cloudflare Email Sending) | Rescatar después de decidir la identidad. Requiere dar de alta `gofiodesign.eu` en Email Sending. |

La migración se renumera a partir de `0007`. No se reutiliza `0005`.

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
