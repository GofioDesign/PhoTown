# Sprint 2 — navegación, muros y gestión de fotos

## Alcance acordado

Implementación del documento entregado el 13 de septiembre de 2026, con dos decisiones posteriores del usuario:

- Conservar copias independientes por grupo. YO reúne las copias de todos los grupos y la confirmación identifica cuáles se eliminan. No se agrupan imágenes antiguas por hash ni se deduce su procedencia.
- Guardar emails de lista de espera en una tabla del backend, sin enviar correos. Solo administradores autorizados pueden verla o eliminar solicitudes.

## Correspondencia con los criterios de aceptación

| Criterios | Implementación |
| --- | --- |
| 1 | Invitación → muro del grupo; PHOTOWN vuelve al muro sin abandonar el grupo. |
| 2 | Quiero probarlo → email validado → D1, estados de error y confirmación; sin acceso automático. |
| 3–6 | Mosaico de proporciones naturales, cabecera fija, navegación inferior YO/cámara/grupo, preferencia zurdo persistente. |
| 7 | Cámara ocupa el viewport, sin scroll ni barra inferior, shutter y controles superpuestos. |
| 8–10 | Foto de grupo a pantalla completa, alias opcional, ALT solo si existe descripción; metadato `alt` actualizado. |
| 11–14 | YO muestra solo las copias del propietario; ALT editable, descarga original y borrado confirmado desde la foto. |
| 15–17 | Pulsación larga activa selección múltiple; ZIP y borrado de seleccionadas con reintento de fallos parciales. Alternativas por teclado y Personalización. |
| 18–21 | Personalización: añadir grupo, alias por grupo, mano preferida. Identidad e instalación disponibles aquí. |
| 22–23 | Nombre real del grupo como control inferior; selector solo con varias membresías. Un destino no requiere elegir. |
| 24 | Captura permanece a pantalla completa, con publicación superpuesta; confirmación → muro. |

## Datos y permisos

- `/api/library` pagina copias propias de todos los grupos. Sus acciones comprueban propiedad en servidor; las rutas anteriores `/api/my-photos` siguen restringidas al grupo actual por compatibilidad.
- `/api/images/:id` permite al propietario leer sus copias aunque esté viendo otro grupo. Los demás participantes solo leen publicadas en su grupo activo. Administración mantiene sus permisos.
- Descripción y retirada vuelven a comprobar propiedad al escribir, para no aceptar una operación antigua después de reasignar la identidad.
- Alias: se conserva el modelo existente, opcional por membresía/grupo, editable o eliminable desde Personalización.
- La lista de espera valida y limita solicitudes, normaliza y deduplica emails y nunca devuelve la lista al visitante. No utiliza los secretos Google para enviar mensajes.
- Migración aditiva `0003_waitlist.sql`. No altera fotografías, grupos ni identidades existentes.

## Límites y seguimiento

- ZIP local de hasta 50 fotos y 100 MB; conserva exactamente los WebP descargables, sin recompresión. Una selección mayor se divide en operaciones.
- Los controles de foto y cámara se superponen sin scroll de página. Formularios/overlays pueden desplazarse si el contenido, el teclado o la ampliación necesitan más espacio.
- Una captura pendiente permanece en memoria y reaparece al abrir la cámara; cerrar la página puede perderla. No hay cola de subida offline.
- Pantalla completa del navegador cuando está disponible; viewport completo y PWA standalone como base compatible.
- Pruebas con cámara sintética y viewport móvil no sustituyen dispositivos físicos, VoiceOver/TalkBack ni un piloto con personas con distintas necesidades.
- Cambio selfie/trasera, Weekly Review y alertas de exposición no forman parte de este documento de Sprint 2; siguen en planificación.

## Revisión visual posterior, según las referencias del usuario

Esta revisión sustituye la indicación anterior de ocultar permanentemente el autor en el mosaico de grupo. Las fotos del grupo ahora llevan marco, alias/avatar opcionales y ALT directo. YO mantiene las mismas imágenes con acciones y casilla, sin identificación repetida del autor. El perfil por grupo se edita desde YO.

Con varias membresías, se muestran círculos superiores con portadas aprobadas y nombre; con una sola, el muro de grupo omite su botón inferior. YO y grupo usan iconos. La selección múltiple muestra iconos y número, con nombres accesibles; cerrar/ALT se sitúan abajo en la foto ampliada.

Administración añade el muro de clase por grupo, con publicaciones aprobadas y ampliación sobre el muro. Herramientas de dibujo y administradores propios por grupo quedan pendientes para una versión posterior, junto con la restricción futura del superadmin a eliminar/resetear grupos.
